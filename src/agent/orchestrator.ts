import type { AgentTelemetry, ReviewResult, ReviewTelemetry } from "../types.js";
import { computeRecommendation } from "../report.js";
import { runReviewAgent } from "./specialist.js";
import { runAggregatorAgent, mergeSpecialistResults } from "./aggregator.js";
import { combineTelemetry, asAgentTelemetry } from "./telemetry.js";
import type { AgentRoleConfig } from "../types.js";
import type { MultiAgentRunInput, SpecialistOutcome, SpecialistResult } from "./contracts.js";

/**
 * 有界并发 map：最多同时启动 limit 个 worker，并保持结果与输入顺序一致。
 * 这比 Promise.all(items.map(...)) 更容易控制 Provider 并发和资源消耗。
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); // 按输入顺序保存每个 worker 的结果。
  let next = 0; // 下一个尚未领取的任务下标。
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => { // 有界并发 worker 列表。
    while (true) {
      const index = next++; // 当前 worker 领取的任务下标。
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function isSuccess(outcome: SpecialistOutcome): outcome is SpecialistResult {
  return "result" in outcome;
}

/** 成功专家的单 Session telemetry；缺失的统计不参与合并。 */
function sessionTelemetries(successes: SpecialistResult[]): AgentTelemetry[] {
  return successes.map(({ result }) => asAgentTelemetry(result.telemetry)).filter((value): value is AgentTelemetry => value !== undefined);
}

/** 运行级 telemetry 的唯一构造点，成功和降级两条路径共用同一份字段映射。 */
function buildTelemetry(input: {
  totalSpecialists: number;
  successes: number;
  failed: number;
  specialistDurationMs: number;
  aggregatorDurationMs?: number;
  startedAt: number;
  sessions: AgentTelemetry[];
}): ReviewTelemetry {
  const combined = combineTelemetry(input.sessions); // 所有成功 Session 的统计。
  return {
    usageAvailable: combined.usageAvailable,
    specialistCount: input.totalSpecialists,
    successfulSpecialists: input.successes,
    failedSpecialists: input.failed,
    specialistDurationMs: input.specialistDurationMs,
    aggregatorDurationMs: input.aggregatorDurationMs,
    totalDurationMs: Date.now() - input.startedAt,
    turns: combined.turns,
    toolCalls: combined.toolCalls,
    inputTokens: combined.inputTokens,
    outputTokens: combined.outputTokens,
    cacheReadTokens: combined.cacheReadTokens,
    cacheWriteTokens: combined.cacheWriteTokens,
    totalCost: combined.totalCost,
  };
}

/**
 * 运行一个专家并归一化为可判别结果。
 * 每个专家独立捕获错误：一个角色失败不应该取消其他已运行的角色。
 */
async function runSpecialist(input: MultiAgentRunInput, role: AgentRoleConfig): Promise<SpecialistOutcome> {
  await input.trace.record("specialist_start", { agentRole: role.id });
  try {
    const result = await runReviewAgent({
      ...input,
      role: role.id,
      instructions: role.instructions,
      systemPrompt: input.operator?.rolePrompts?.[role.id],
      includeCheckTool: false,
      includeContextTools: true,
      maxSeconds: input.specialistSeconds ?? input.config.review.maxSpecialistSeconds,
    });
    await input.trace.record("specialist_end", { agentRole: role.id, findings: result.findings.length });
    return { role: role.id, result };
  } catch (error) {
    await input.trace.record("specialist_error", { agentRole: role.id, error: error instanceof Error ? error.message : String(error) });
    return { role: role.id, error };
  }
}

/** 多专家并发执行，汇总失败时保留已完成专家结果并显式标记降级。 */
export async function runMultiAgentReview(input: MultiAgentRunInput): Promise<ReviewResult> {
  const startedAt = Date.now(); // 多专家编排开始时间。
  // 配置可以声明多个角色，但 disabled 角色不会创建 Session。
  const roles = input.config.review.roles.filter((role) => role.enabled); // 本次实际启用的专家角色。
  const maxParallelAgents = input.maxParallelAgents ?? input.config.review.maxParallelAgents;
  const outcomes = await mapWithConcurrency(roles, maxParallelAgents, (role) => runSpecialist(input, role)); // 按并发上限运行所有专家。
  // 先收集所有结果，再统一决定是否进入汇总阶段，避免完成顺序影响业务判断。
  const successes: SpecialistResult[] = outcomes.filter(isSuccess);
  const failedRoles = outcomes.filter((outcome) => !isSuccess(outcome)).map((outcome) => outcome.role); // 没有完成审查的专家角色名称。
  const specialistDurationMs = Date.now() - startedAt; // 专家阶段总耗时。
  await input.trace.record("orchestration_summary", { configuredRoles: roles.map((role) => role.id), specialistCount: roles.length, successCount: successes.length, failedRoles, maxParallelAgents, specialistDurationMs });
  // 没有任何专家完成时，汇总没有可信输入，必须直接失败为 inconclusive。
  if (successes.length === 0) throw new Error(`所有专家 Agent 均未完成结构化审查：${failedRoles.join(", ")}`);

  await input.trace.record("aggregator_start", { agentRole: "aggregator", specialistCount: successes.length });
  try {
    const aggregated = await runAggregatorAgent(input, successes, failedRoles); // 汇总成功专家的结构化结果。
    // 汇总成功后仍由编排层重新合并 limitations，防止遗漏失败专家。
    const limitations = [...new Set([...aggregated.limitations, ...failedRoles.map((role) => `专家 Agent ${role} 未完成结构化审查。`)])];
    await input.trace.record("aggregator_end", { agentRole: "aggregator", findings: aggregated.findings.length });
    const aggregatorTelemetry = asAgentTelemetry(aggregated.telemetry); // 汇总 Agent 自身的单 Session telemetry。
    const telemetry = buildTelemetry({
      totalSpecialists: roles.length,
      successes: successes.length,
      failed: failedRoles.length,
      specialistDurationMs,
      aggregatorDurationMs: aggregatorTelemetry?.durationMs,
      startedAt,
      sessions: [...sessionTelemetries(successes), ...(aggregatorTelemetry ? [aggregatorTelemetry] : [])],
    });
    // 结论必须在编排层就地重算：runMultiAgentReview 是导出 API，直接调用它的调用方
    // 不应该拿到 assembleMergedResult 留下的占位 inconclusive。
    const withOrchestration: ReviewResult = { ...aggregated, limitations, incompleteSpecialists: failedRoles };
    return { ...withOrchestration, mergeRecommendation: computeRecommendation(withOrchestration, input.config), telemetry };
  } catch (error) {
    // 汇总失败不丢弃已经完成的专家结果，但必须留下结构化降级标记。
    const reason = error instanceof Error ? error.message : String(error);
    await input.trace.record("aggregator_error", { agentRole: "aggregator", error: reason });
    const merged = mergeSpecialistResults(successes, input.initialChecks, failedRoles, reason);
    const telemetry = buildTelemetry({
      totalSpecialists: roles.length,
      successes: successes.length,
      failed: failedRoles.length,
      specialistDurationMs,
      startedAt,
      sessions: sessionTelemetries(successes),
    });
    return { ...merged, mergeRecommendation: computeRecommendation(merged, input.config), telemetry };
  }
}
