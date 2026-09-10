import type { AgentTelemetry, ReviewResult, ReviewTelemetry } from "../types.js";
import { computeRecommendation } from "../report.js";
import { runReviewAgent } from "./specialist.js";
import { runAggregatorAgent, mergeSpecialistResults } from "./aggregator.js";
import { combineTelemetry, asAgentTelemetry } from "./telemetry.js";
import type { MultiAgentRunInput, SpecialistResult } from "./contracts.js";

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

/** 多专家并发执行，汇总失败时保留已完成专家结果并显式标记降级。 */
export async function runMultiAgentReview(input: MultiAgentRunInput): Promise<ReviewResult> {
  const startedAt = Date.now(); // 多专家编排开始时间。
  // 配置可以声明多个角色，但 disabled 角色不会创建 Session。
  const roles = input.config.review.roles.filter((role) => role.enabled); // 本次实际启用的专家角色。
  const successes: SpecialistResult[] = []; // 成功提交结构化结果的专家。
  const failedRoles: string[] = []; // 没有完成审查的专家角色名称。
  // 每个专家独立捕获错误：一个角色失败不应该取消其他已运行的角色。
  const outcomes = await mapWithConcurrency(roles, input.maxParallelAgents ?? 4, async (role) => { // 按并发上限运行所有专家。
    await input.trace.record("specialist_start", { agentRole: role.id });
    try {
      const result = await runReviewAgent({ ...input, role: role.id, instructions: role.instructions, systemPrompt: input.operator?.rolePrompts?.[role.id], includeCheckTool: false, includeContextTools: true, maxSeconds: input.specialistSeconds ?? input.config.review.maxSpecialistSeconds });
      await input.trace.record("specialist_end", { agentRole: role.id, findings: result.findings.length });
      return { role: role.id, result } satisfies SpecialistResult;
    } catch (error) {
      await input.trace.record("specialist_error", { agentRole: role.id, error: error instanceof Error ? error.message : String(error) });
      return { role: role.id, error };
    }
  });
  // 先收集所有结果，再统一决定是否进入汇总阶段，避免完成顺序影响业务判断。
  for (const outcome of outcomes) {
    if ("result" in outcome && outcome.result !== undefined) successes.push({ role: outcome.role, result: outcome.result });
    else failedRoles.push(outcome.role);
  }
  const specialistDurationMs = Date.now() - startedAt; // 专家阶段总耗时。
  await input.trace.record("orchestration_summary", { configuredRoles: roles.map((role) => role.id), specialistCount: roles.length, successCount: successes.length, failedRoles, maxParallelAgents: input.maxParallelAgents ?? input.config.review.maxParallelAgents, specialistDurationMs });
  // 没有任何专家完成时，汇总没有可信输入，必须直接失败为 inconclusive。
  if (successes.length === 0) throw new Error(`所有专家 Agent 均未完成结构化审查：${failedRoles.join(", ")}`);

  await input.trace.record("aggregator_start", { agentRole: "aggregator", specialistCount: successes.length });
  try {
    // 汇总成功后仍由编排层重新计算 telemetry 和 limitations，防止遗漏失败专家。
    const aggregated = await runAggregatorAgent(input, successes, failedRoles); // 汇总成功专家的结构化结果。
    const limitations = [...new Set([...aggregated.limitations, ...failedRoles.map((role) => `专家 Agent ${role} 未完成结构化审查。`)])]; // 补充失败专家的限制说明。
    await input.trace.record("aggregator_end", { agentRole: "aggregator", findings: aggregated.findings.length });
    const aggregatorTelemetry = asAgentTelemetry(aggregated.telemetry); // 汇总 Agent 自身的单 Session telemetry。
    const specialistTelemetry = successes.map(({ result }) => asAgentTelemetry(result.telemetry)).filter((value): value is AgentTelemetry => Boolean(value)); // 成功专家的 telemetry 列表。
    const combined = combineTelemetry([...specialistTelemetry, ...(aggregatorTelemetry ? [aggregatorTelemetry] : [])]); // 合并所有成功 Session 的统计。
    const telemetry: ReviewTelemetry = { usageAvailable: combined.usageAvailable, specialistCount: roles.length, successfulSpecialists: successes.length, failedSpecialists: failedRoles.length, specialistDurationMs, aggregatorDurationMs: aggregatorTelemetry?.durationMs, totalDurationMs: Date.now() - startedAt, turns: combined.turns, toolCalls: combined.toolCalls, inputTokens: combined.inputTokens, outputTokens: combined.outputTokens, cacheReadTokens: combined.cacheReadTokens, cacheWriteTokens: combined.cacheWriteTokens, totalCost: combined.totalCost };
    // 结论必须在编排层就地重算：runMultiAgentReview 是导出 API，直接调用它的调用方
    // 不应该拿到 assembleMergedResult 留下的占位 inconclusive。
    const withLimitations = { ...aggregated, limitations }; // 参与确定性判定的结果视图。
    return { ...withLimitations, mergeRecommendation: computeRecommendation(withLimitations, input.config), telemetry };
  } catch (error) {
    // 汇总失败不丢弃已经完成的专家结果，但必须留下 agent_orchestration limitation。
    const reason = error instanceof Error ? error.message : String(error);
    await input.trace.record("aggregator_error", { agentRole: "aggregator", error: reason });
    const merged = mergeSpecialistResults(successes, input.initialChecks, failedRoles, reason);
    const specialistTelemetry = successes.map(({ result }) => asAgentTelemetry(result.telemetry)).filter((value): value is AgentTelemetry => Boolean(value));
    const combined = combineTelemetry(specialistTelemetry);
    return { ...merged, mergeRecommendation: computeRecommendation(merged, input.config), telemetry: { usageAvailable: combined.usageAvailable, specialistCount: roles.length, successfulSpecialists: successes.length, failedSpecialists: failedRoles.length, specialistDurationMs, totalDurationMs: Date.now() - startedAt, turns: combined.turns, toolCalls: combined.toolCalls, inputTokens: combined.inputTokens, outputTokens: combined.outputTokens, cacheReadTokens: combined.cacheReadTokens, cacheWriteTokens: combined.cacheWriteTokens, totalCost: combined.totalCost } };
  }
}
