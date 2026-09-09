import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ReviewResult } from "../types.js";
import { validateReviewResult } from "../report.js";
import { runSession } from "./session.js";
import { boundedPreview } from "../tools/context.js";
import { aggregatorPrompt } from "./prompts.js";
import type { MultiAgentRunInput, SpecialistResult } from "./contracts.js";
import { createSubmitReviewTool, type ReviewToolState } from "../tools/review.js";

// 汇总输入是多个专家结果的总和，必须单独设置预算，不能沿用单个 Diff 的预算。
export const MAX_AGGREGATOR_CONTEXT_CHARS = 40_000;

/**
 * 为汇总 Agent 构造最小必要信息。
 * 每层都有限制：专家数量、Finding 数量、文本长度和总字符数。
 */
function buildAggregatorPayload(successes: SpecialistResult[]): { payload: Array<Record<string, unknown>>; payloadChars: number; truncatedFindings: number } {
  const payload = successes.map(({ role, result }) => ({
    role,
    summary: boundedPreview(result.summary, 1_000),
    findings: result.findings.slice(0, 30).map((finding) => ({
      ...finding,
      title: boundedPreview(finding.title, 240),
      summary: boundedPreview(finding.summary, 1_000),
      suggestedFix: boundedPreview(finding.suggestedFix, 800),
      evidence: finding.evidence.slice(0, 5).map((evidence) => ({ ...evidence, summary: boundedPreview(evidence.summary, 600) })),
    })),
    limitations: result.limitations.slice(0, 20).map((item) => boundedPreview(item, 500)),
    nextActions: result.nextActions.slice(0, 20).map((item) => boundedPreview(item, 500)),
  }));
  let payloadChars = JSON.stringify(payload).length; // 汇总输入当前占用的字符数。
  let truncatedFindings = 0; // 因超出预算而删除的 Finding 数量。
  // 超预算时优先删除 Finding，而不是删除角色和限制信息；这样仍能保留失败语义。
  while (payloadChars > MAX_AGGREGATOR_CONTEXT_CHARS && payload.some((item) => Array.isArray(item.findings) && item.findings.length > 0)) {
    const target = payload.reduce((current, item) => (item.findings as unknown[]).length > (current.findings as unknown[]).length ? item : current); // 找出 Finding 最多的专家，优先从它裁剪。
    (target.findings as unknown[]).pop();
    truncatedFindings += 1;
    payloadChars = JSON.stringify(payload).length;
  }
  return { payload, payloadChars, truncatedFindings };
}

/** 汇总专家结果；汇总 Agent 只能提交结果，不能重新读取仓库或执行检查。 */
export async function runAggregatorAgent(input: MultiAgentRunInput, successes: SpecialistResult[], failedRoles: string[]): Promise<ReviewResult> {
  const state: ReviewToolState = { submitted: undefined }; // 汇总 Tool 与 Session 共享的提交状态。
  const submitReview = createSubmitReviewTool({ trace: input.trace, role: "aggregator", checkResults: input.initialChecks ?? [], changedPaths: input.context.changes.map((change) => change.path), merged: true }, state); // 创建只允许提交结果的汇总工具。
  const sessionFactory = input.createAgentSession ?? createAgentSession; // 生产或测试用的 Session 创建函数。
  const { session } = await sessionFactory({ cwd: input.repositoryRoot, thinkingLevel: "low", tools: ["submit_review"], customTools: [submitReview], sessionManager: SessionManager.inMemory(input.repositoryRoot) }); // 汇总 Agent 的 Pi 会话。
  state.activeSession = session; // 让 submit_review 成功后可以主动终止会话。
  const prepared = buildAggregatorPayload(successes); // 裁剪专家结果，生成有界的汇总输入。
  await input.trace.record("aggregator_context_bounded", { agentRole: "aggregator", specialistCount: prepared.payload.length, payloadChars: prepared.payloadChars, maxContextChars: MAX_AGGREGATOR_CONTEXT_CHARS, maxFindingsPerSpecialist: 30, truncatedFindings: prepared.truncatedFindings });
  const run = await runSession({ session, trace: input.trace, role: "aggregator", maxTurns: input.maxTurns ?? 12, maxSeconds: input.aggregatorSeconds ?? input.maxSeconds ?? 90 }, aggregatorPrompt(prepared.payload, failedRoles), () => state.submitted); // 执行汇总 Prompt 和提交工具。
  const validated = validateReviewResult(run.submitted, input.initialChecks ?? [], input.context.changes.map((change) => change.path)); // 校验汇总后的最终结果。
  await input.trace.record("agent_end", { agentRole: "aggregator", findings: validated.findings.length, checks: validated.checks.length, telemetry: run.telemetry });
  return { ...validated, telemetry: run.telemetry };
}

/**
 * 汇总 Session 失败时的确定性降级路径。
 * 这里宁可返回 inconclusive，也不把部分结果伪装成完整审查。
 */
export function mergeSpecialistResults(successes: SpecialistResult[], checks: MultiAgentRunInput["initialChecks"] = [], failedRoles: string[], reason?: string): ReviewResult {
  const findings: ReviewResult["findings"] = []; // 按顺序保存去重后的 Finding。
  const seen = new Set<string>(); // 记录已经出现过的 Finding 去重键。
  // 去重 key 目前使用位置 + 标题；它是保守去重，不试图推断复杂的根因相似度。
  for (const specialist of successes) {
    for (const finding of specialist.result.findings) {
      const key = `${finding.location.path}:${finding.location.startLine}:${finding.title.toLowerCase()}`; // 用路径、行号和标题识别重复问题。
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ ...finding, id: `finding_${findings.length + 1}` });
    }
  }
  const limitations = [...successes.flatMap(({ result }) => result.limitations), ...failedRoles.map((role) => `专家 Agent ${role} 未完成结构化审查。`), ...(reason ? [`agent_orchestration: ${reason}`] : [])]; // 合并专家限制和编排失败原因。
  return { schemaVersion: 1, mergeRecommendation: reason ? "inconclusive" : "approve_with_notes", summary: `多 Agent 审查完成：${successes.length} 个专家 Agent 返回结果，合并 ${findings.length} 条去重 Finding。`, checks: checks ?? [], findings, limitations: [...new Set(limitations)], nextActions: [...new Set(successes.flatMap(({ result }) => result.nextActions))] };
}
