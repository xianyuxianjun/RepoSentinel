import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CheckResult, Finding, MergePlan, ReviewResult } from "../types.js";
import { validateReviewResult } from "../report.js";
import { runSession } from "./session.js";
import { boundedPreview } from "../tools/context.js";
import { aggregatorPrompt } from "./prompts.js";
import { DEFAULT_THINKING_LEVEL } from "../model-runtime.js";
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
  const originals = new Map<string, Finding>(); // ref → 专家**全部**原始 Finding。阻断兜底必须看到完整集合，不能只看模型看得到的那部分。
  const visibleRefs = new Set<string>(); // 模型实际看到的 ref 集合，只有这些可以被 keep 引用。
  const payload: AggregatorPayloadItem[] = successes.map(({ role, result }) => {
    // ref 基于完整列表的下标，因此“裁剪”不会改变其他 Finding 的 ref。
    for (const [index, finding] of result.findings.entries()) originals.set(findingRef(role, index), finding);
    return {
      role,
      summary: boundedPreview(result.summary, 1_000),
      // 只投影汇总需要的字段，并剔除原 id，避免模型混用 id 和 ref。
      findings: result.findings.slice(0, 30).map((finding, index) => {
        const ref = findingRef(role, index); // 当前 Finding 在汇总阶段使用的引用。
        visibleRefs.add(ref);
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
    };
  });
  const droppedByCap = successes.reduce((total, { result }) => total + Math.max(0, result.findings.length - 30), 0); // 每个专家超过 30 条的 Finding 不会进入模型视野。
  const { payloadChars, truncatedFindings, trimmedSections } = trimToBudget(payload, visibleRefs, droppedByCap); // 把投影压进上下文预算。
  // refs 是“模型可引用的集合”，originals 是“可回查的完整集合”；
  // 后者更大是故意的：被裁剪的阻断证据仍然要被兜底保留。
  return { payload, payloadChars, truncatedFindings, trimmedSections, refs: visibleRefs, originals };
}

/** 汇总输入的字符数；作为预算判定的唯一度量。 */
function measure(payload: AggregatorPayloadItem[]): number {
  return JSON.stringify(payload).length;
}

/**
 * 把汇总输入压到 MAX_AGGREGATOR_CONTEXT_CHARS 以内。
 *
 * 三层裁剪顺序是设计的一部分，不能调换：
 * 1) 先删 Finding（保留角色与失败语义）；
 * 2) 再删 limitations/nextActions（limitations/nextActions 本身也能占掉上万字符）；
 * 3) 最后才压缩每个专家自己的 summary，尽量保住“每个专家说了什么”。
 *
 * visibleRefs 与 payload 同步删除，而 originals 保持不变：被裁掉的 high/critical
 * 仍然能被确定性兜底保留，不会变成假通过。
 */
function trimToBudget(payload: AggregatorPayloadItem[], visibleRefs: Set<string>, initialTruncatedFindings: number): { payloadChars: number; truncatedFindings: number; trimmedSections: number } {
  let payloadChars = measure(payload); // 汇总输入当前占用的字符数。
  let truncatedFindings = initialTruncatedFindings; // 未进入模型视野的 Finding 数量。
  let trimmedSections = 0; // 因超出预算而删除的说明/摘要数量。
  while (payloadChars > MAX_AGGREGATOR_CONTEXT_CHARS && payload.some((item) => item.findings.length > 0)) {
    const target = payload.reduce((current, item) => item.findings.length > current.findings.length ? item : current); // 找出 Finding 最多的专家，优先从它裁剪。
    const removed = target.findings.pop(); // 被裁掉的投影项。
    // 只从“模型可见集合”里移除：originals 保留完整集合，否则被裁掉的阻断证据连兜底逻辑都看不到。
    if (removed) visibleRefs.delete(removed.ref);
    truncatedFindings += 1;
    payloadChars = measure(payload);
  }
  while (payloadChars > MAX_AGGREGATOR_CONTEXT_CHARS && payload.some((item) => item.limitations.length > 0 || item.nextActions.length > 0)) {
    const target = payload.reduce((current, item) => (item.limitations.length + item.nextActions.length) > (current.limitations.length + current.nextActions.length) ? item : current);
    if (target.limitations.length > 0) target.limitations.pop(); else target.nextActions.pop();
    trimmedSections += 1;
    payloadChars = measure(payload);
  }
  while (payloadChars > MAX_AGGREGATOR_CONTEXT_CHARS && payload.some((item) => item.summary.length > 0)) {
    const target = payload.reduce((current, item) => item.summary.length > current.summary.length ? item : current);
    target.summary = target.summary.slice(0, Math.floor(target.summary.length / 2));
    trimmedSections += 1;
    payloadChars = measure(payload);
  }
  return { payloadChars, truncatedFindings, trimmedSections };
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
 * 高等级且已验证的 Finding 引用。
 *
 * 这些是“确定性阻断证据”，不允许被汇总模型的 keep 列表丢弃：否则模型就等于可以
 * 自行宣布通过，与“模型只能提供证据、不能决定结论”的设计前提相道而驰。
 */
export function blockingRefs(originals: ReadonlyMap<string, Finding>): string[] {
  return [...originals]
    .filter(([, finding]) => (finding.severity === "critical" || finding.severity === "high") && finding.verificationStatus === "verified")
    .map(([ref]) => ref);
}

/**
 * 按汇总方案组装最终结果。
 *
 * Finding 正文一律回查 originals 里的专家原文，模型只提供 keep 列表和摘要，
 * 因此汇总阶段既不会改写证据，也不会被汇总输入的限长投影截断。
 */
export function assembleMergedResult(input: MergeAssemblyInput): ReviewResult {
  const keep = new Set(input.plan.keep); // 模型决定保留的 Finding 引用。
  // 兜底：模型没保留的阻断证据一律补回来。模型仍可以对它们去重或排序，但无法让它们消失。
  const protectedRefs = blockingRefs(input.originals).filter((ref) => !keep.has(ref));
  for (const ref of protectedRefs) keep.add(ref);
  const findings: Finding[] = []; // 按汇总输入顺序组装的最终 Finding 列表。
  // 遍历 originals 而不是 keep，顺序才稳定；Map 的插入顺序就是专家结果的先后顺序。
  for (const [ref, original] of input.originals) {
    if (!keep.has(ref)) continue;
    findings.push({ ...original, id: `finding_${findings.length + 1}` });
  }
  // 专家的 limitations/nextActions 记录的是“它没能验证什么”，属于不可丢失的事实；
  // 汇总 Prompt 已要求模型不要复述它们，因此必须由主控确定性合并，排在模型补充的全局信息之前。
  // 专家的 limitations 同样是模型生成的文本，但不再当作内部标记解析：覆盖完整性由结构化字段承载。
  const limitations = [...new Set([...input.specialists.flatMap(({ result }) => result.limitations), ...input.plan.limitations])];
  const nextActions = [...new Set([...input.specialists.flatMap(({ result }) => result.nextActions), ...input.plan.nextActions])];
  // 被裁掉的 Finding 不会进入报告，必须显式说明，否则读者会以为覆盖是完整的。
  if (input.truncatedFindings) limitations.unshift(`汇总输入超出 ${MAX_AGGREGATOR_CONTEXT_CHARS} 字符预算，${input.truncatedFindings} 条 Finding 未参与汇总，可能未出现在本报告中。`);
  if (protectedRefs.length > 0) limitations.unshift(`汇总模型丢弃了 ${protectedRefs.length} 条 high/critical 且已验证的 Finding，已由确定性兜底保留。`);
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
    thinkingLevel: input.agentModel?.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    model: input.agentModel?.model,
    modelRuntime: input.agentModel?.modelRuntime,
    tools: ["submit_merge_plan"],
    customTools: [submitPlan],
    sessionManager: SessionManager.inMemory(input.repositoryRoot),
  }); // 汇总 Agent 的 Pi 会话。
  state.activeSession = session; // 让 submit_merge_plan 成功后可以主动终止会话。
  await input.trace.record("aggregator_context_bounded", { agentRole: "aggregator", specialistCount: prepared.payload.length, payloadChars: prepared.payloadChars, maxContextChars: MAX_AGGREGATOR_CONTEXT_CHARS, maxFindingsPerSpecialist: 30, truncatedFindings: prepared.truncatedFindings, trimmedSections: prepared.trimmedSections, findingRefs: prepared.refs.size });
  const run = await runSession({ session, trace: input.trace, role: "aggregator", maxTurns: input.maxTurns ?? input.config.review.maxAgentTurns, maxSeconds: input.aggregatorSeconds ?? input.maxSeconds ?? input.config.review.maxAggregatorSeconds, submitToolName: "submit_merge_plan" }, aggregatorPrompt(prepared.payload, failedRoles, input.operator?.aggregatorPrompt), () => state.submitted); // 执行汇总 Prompt 和提交工具。
  // 工具层已经校验过一次；这里再校验一次，作为不依赖工具实现的可信边界。
  const plan = validateMergePlan(run.submitted, prepared.refs); // 已校验的汇总去重方案。
  const assembled = assembleMergedResult({ originals: prepared.originals, plan, checks: input.initialChecks ?? [], specialists: successes, truncatedFindings: prepared.truncatedFindings }); // 回查专家原文并按 ref 组装最终结果。
  const validated = validateReviewResult(assembled, input.initialChecks ?? [], input.context.changes.map((change) => change.path)); // 对组装结果做与专家一致的最终校验。
  await input.trace.record("aggregator_merge_plan", { agentRole: "aggregator", visibleRefs: prepared.refs.size, allFindings: prepared.originals.size, kept: plan.keep.length, dropped: prepared.refs.size - plan.keep.length, protectedBlockingRefs: blockingRefs(prepared.originals).filter((ref) => !plan.keep.includes(ref)).length });
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
  const limitations = [...new Set([...successes.flatMap(({ result }) => result.limitations), ...failedRoles.map((role) => `专家 Agent ${role} 未完成结构化审查。`), ...(reason !== undefined ? [`agent_orchestration: ${reason}`] : [])])];
  // reason 用 !== undefined 判断而不是真值：空字符串的 error message 会跳过这条标记，
  // 让一次降级结果看起来像正常合并（fail-open）。覆盖完整性由结构化字段承载，
  // limitations 只作为人类可读说明，不再被 computeRecommendation 反向解析。
  return {
    schemaVersion: 1,
    mergeRecommendation: reason !== undefined ? "inconclusive" : "approve_with_notes",
    summary: `多 Agent 审查完成：${successes.length} 个专家 Agent 返回结果，合并 ${findings.length} 条去重 Finding。`,
    checks: checks ?? [],
    findings,
    limitations,
    nextActions: [...new Set(successes.flatMap(({ result }) => result.nextActions))],
    incompleteSpecialists: failedRoles,
    orchestrationError: reason,
  };
}
