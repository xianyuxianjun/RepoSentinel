import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CheckResult, Finding, MergePlan, ReviewResult } from "../types.js";
import { validateReviewResult } from "../report.js";
import { runSession } from "./session.js";
import { boundedPreview } from "../tools/context.js";
import { aggregatorPrompt } from "./prompts.js";
import type { MultiAgentRunInput, SpecialistResult } from "./contracts.js";
import { createSubmitMergePlanTool, validateMergePlan, type ReviewToolState } from "../tools/review.js";

// 汇总输入是多个专家结果的总和，必须单独设置预算，不能沿用单个 Diff 的预算。
export const MAX_AGGREGATOR_CONTEXT_CHARS = 40_000;

/** 汇总输入里的一条 Finding：去掉各专家自己的 id，改用全局唯一的 ref。 */
interface AggregatorFinding extends Omit<Finding, "id"> {
  ref: string;
}

/** 单个专家在汇总输入中的投影。 */
interface AggregatorPayloadItem {
  role: string;
  summary: string;
  findings: AggregatorFinding[];
  limitations: string[];
  nextActions: string[];
}

/**
 * 不同专家各自从 finding_1 开始编号，直接沿用会让模型无法准确表达“保留哪一条”。
 * ref 形如 `logic#2`，只用于汇总阶段，不进入最终报告。
 */
function findingRef(role: string, index: number): string {
  return `${role}#${index + 1}`;
}

/**
 * 为汇总 Agent 构造最小必要信息。
 *
 * 这里返回两套东西，它们服务不同目的，不能混用：
 * - payload：给模型看的**限长投影**，受 MAX_AGGREGATOR_CONTEXT_CHARS 预算约束；
 * - originals：ref → 专家**原始 Finding**，用于组装最终报告。
 * 如果组装也读 payload，长文本会被 boundedPreview 静默截断，“按 ref 原样搬运”就不成立。
 */
export function buildAggregatorPayload(successes: SpecialistResult[]): { payload: AggregatorPayloadItem[]; payloadChars: number; truncatedFindings: number; trimmedSections: number; refs: Set<string>; originals: Map<string, Finding> } {
  const originals = new Map<string, Finding>(); // ref → 未被截断的专家原始 Finding，插入顺序即 payload 顺序。
  const payload: AggregatorPayloadItem[] = successes.map(({ role, result }) => ({
    role,
    summary: boundedPreview(result.summary, 1_000),
    // 只投影汇总需要的字段，并剔除原 id，避免模型混用 id 和 ref。
    findings: result.findings.slice(0, 30).map((finding, index) => {
      const ref = findingRef(role, index); // 当前 Finding 在汇总阶段、也是组装阶段使用的引用。
      originals.set(ref, finding);
      return {
        ref,
        severity: finding.severity,
        category: finding.category,
        title: boundedPreview(finding.title, 240),
        summary: boundedPreview(finding.summary, 1_000),
        location: finding.location,
        evidence: finding.evidence.slice(0, 5).map((evidence) => ({ ...evidence, summary: boundedPreview(evidence.summary, 600) })),
        confidence: finding.confidence,
        suggestedFix: boundedPreview(finding.suggestedFix, 800),
        verificationStatus: finding.verificationStatus,
      };
    }),
    limitations: result.limitations.slice(0, 20).map((item) => boundedPreview(item, 500)),
    nextActions: result.nextActions.slice(0, 20).map((item) => boundedPreview(item, 500)),
  }));
  let payloadChars = JSON.stringify(payload).length; // 汇总输入当前占用的字符数。
  let truncatedFindings = 0; // 因超出预算而删除的 Finding 数量。
  let trimmedSections = 0; // 因超出预算而删除的说明/摘要数量。
  // 第一层：优先删除 Finding，而不是删除角色和限制信息；这样仍能保留失败语义。
  while (payloadChars > MAX_AGGREGATOR_CONTEXT_CHARS && payload.some((item) => item.findings.length > 0)) {
    const target = payload.reduce((current, item) => item.findings.length > current.findings.length ? item : current); // 找出 Finding 最多的专家，优先从它裁剪。
    const removed = target.findings.pop(); // 被裁掉的投影项，它的 ref 也必须同步失效。
    if (removed) originals.delete(removed.ref);
    truncatedFindings += 1;
    payloadChars = JSON.stringify(payload).length;
  }
  // 第二层：Finding 清空后仍然超预算，说明只 pop Finding 会让预算变成软约束——
  // 每个专家的 summary/limitations/nextActions 本身就能占掉上万字符。
  while (payloadChars > MAX_AGGREGATOR_CONTEXT_CHARS && payload.some((item) => item.limitations.length > 0 || item.nextActions.length > 0)) {
    const target = payload.reduce((current, item) => (item.limitations.length + item.nextActions.length) > (current.limitations.length + current.nextActions.length) ? item : current);
    if (target.limitations.length > 0) target.limitations.pop(); else target.nextActions.pop();
    trimmedSections += 1;
    payloadChars = JSON.stringify(payload).length;
  }
  // 第三层：最后才压缩每个专家自己的 summary，尽量保住“每个专家说了什么”。
  while (payloadChars > MAX_AGGREGATOR_CONTEXT_CHARS && payload.some((item) => item.summary.length > 0)) {
    const target = payload.reduce((current, item) => item.summary.length > current.summary.length ? item : current);
    target.summary = target.summary.slice(0, Math.floor(target.summary.length / 2));
    trimmedSections += 1;
    payloadChars = JSON.stringify(payload).length;
  }
  // ref 集合在裁剪之后统计，保证“模型可引用的 ref”与“可回查的原文”始终一致。
  const refs = new Set(originals.keys());
  return { payload, payloadChars, truncatedFindings, trimmedSections, refs, originals };
}

/** 组装最终结果所需的输入。 */
export interface MergeAssemblyInput {
  /** ref → 专家原始 Finding，顺序与汇总输入一致。 */
  originals: ReadonlyMap<string, Finding>;
  plan: MergePlan;
  checks: CheckResult[];
  /** 成功提交结果的专家，用于确定性合并 limitations/nextActions。 */
  specialists: SpecialistResult[];
  /** 因汇总输入预算被裁掉的 Finding 数量；>0 时必须在报告中留下可见说明。 */
  truncatedFindings?: number;
}

/**
 * 按汇总方案组装最终结果。
 *
 * Finding 正文一律回查 originals 里的专家原文，模型只提供 keep 列表和摘要，
 * 因此汇总阶段既不会改写证据，也不会被汇总输入的限长投影截断。
 */
export function assembleMergedResult(input: MergeAssemblyInput): ReviewResult {
  const keep = new Set(input.plan.keep); // 模型决定保留的 Finding 引用。
  const findings: Finding[] = []; // 按汇总输入顺序组装的最终 Finding 列表。
  // 遍历 originals 而不是 keep，顺序才稳定；Map 的插入顺序就是专家结果的先后顺序。
  for (const [ref, original] of input.originals) {
    if (!keep.has(ref)) continue;
    findings.push({ ...original, id: `finding_${findings.length + 1}` });
  }
  // 专家的 limitations/nextActions 记录的是“它没能验证什么”，属于不可丢失的事实；
  // 汇总 Prompt 已要求模型不要复述它们，因此必须由主控确定性合并，排在模型补充的全局信息之前。
  const limitations = [...new Set([...input.specialists.flatMap(({ result }) => result.limitations), ...input.plan.limitations])];
  const nextActions = [...new Set([...input.specialists.flatMap(({ result }) => result.nextActions), ...input.plan.nextActions])];
  // 被裁掉的 Finding 不会进入报告，必须显式说明，否则读者会以为覆盖是完整的。
  if (input.truncatedFindings) limitations.unshift(`汇总输入超出 ${MAX_AGGREGATOR_CONTEXT_CHARS} 字符预算，${input.truncatedFindings} 条 Finding 未参与汇总，可能未出现在本报告中。`);
  return {
    schemaVersion: 1,
    mergeRecommendation: "inconclusive", // 占位值，由 computeRecommendation 在编排层重新计算。
    summary: input.plan.summary,
    checks: input.checks,
    findings,
    limitations,
    nextActions,
  };
}

/** 汇总专家结果；汇总 Agent 只提交去重方案，不能重新读取仓库或执行检查。 */
export async function runAggregatorAgent(input: MultiAgentRunInput, successes: SpecialistResult[], failedRoles: string[]): Promise<ReviewResult> {
  const state: ReviewToolState = { submitted: undefined }; // 汇总 Tool 与 Session 共享的提交状态。
  // 先准备有界输入：工具需要合法的 ref 集合，而 ref 由输入裁剪后的结果决定。
  const prepared = buildAggregatorPayload(successes); // 裁剪专家结果，生成有界的汇总输入。
  const submitPlan = createSubmitMergePlanTool({ trace: input.trace, role: "aggregator", allowedRefs: prepared.refs }, state); // 创建只允许提交去重方案的工具。
  const sessionFactory = input.createAgentSession ?? createAgentSession; // 生产或测试用的 Session 创建函数。
  // 汇总 Agent 与专家使用同一个已解析模型，避免同一份报告里混用不同模型。
  const { session } = await sessionFactory({
    cwd: input.repositoryRoot,
    thinkingLevel: input.agentModel?.thinkingLevel ?? "low",
    model: input.agentModel?.model,
    modelRuntime: input.agentModel?.modelRuntime,
    tools: ["submit_merge_plan"],
    customTools: [submitPlan],
    sessionManager: SessionManager.inMemory(input.repositoryRoot),
  }); // 汇总 Agent 的 Pi 会话。
  state.activeSession = session; // 让 submit_merge_plan 成功后可以主动终止会话。
  await input.trace.record("aggregator_context_bounded", { agentRole: "aggregator", specialistCount: prepared.payload.length, payloadChars: prepared.payloadChars, maxContextChars: MAX_AGGREGATOR_CONTEXT_CHARS, maxFindingsPerSpecialist: 30, truncatedFindings: prepared.truncatedFindings, trimmedSections: prepared.trimmedSections, findingRefs: prepared.refs.size });
  const run = await runSession({ session, trace: input.trace, role: "aggregator", maxTurns: input.maxTurns ?? input.config.review.maxAgentTurns, maxSeconds: input.aggregatorSeconds ?? input.maxSeconds ?? input.config.review.maxAggregatorSeconds, submitToolName: "submit_merge_plan" }, aggregatorPrompt(prepared.payload, failedRoles), () => state.submitted); // 执行汇总 Prompt 和提交工具。
  // 工具层已经校验过一次；这里再校验一次，作为不依赖工具实现的可信边界。
  const plan = validateMergePlan(run.submitted, prepared.refs); // 已校验的汇总去重方案。
  const assembled = assembleMergedResult({ originals: prepared.originals, plan, checks: input.initialChecks ?? [], specialists: successes, truncatedFindings: prepared.truncatedFindings }); // 回查专家原文并按 ref 组装最终结果。
  const validated = validateReviewResult(assembled, input.initialChecks ?? [], input.context.changes.map((change) => change.path)); // 对组装结果做与专家一致的最终校验。
  await input.trace.record("aggregator_merge_plan", { agentRole: "aggregator", totalRefs: prepared.refs.size, kept: plan.keep.length, dropped: prepared.refs.size - plan.keep.length });
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
