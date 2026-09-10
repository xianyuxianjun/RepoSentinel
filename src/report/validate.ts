import type { AgentTelemetry, AnyTelemetry, CheckResult, Finding, Recommendation, ReviewResult, ReviewTelemetry } from "../types.js";
import { isReviewTelemetry } from "../types.js";

/** severity 的合法取值，同时也是校验的唯一来源。 */
const SEVERITIES: ReadonlyArray<Finding["severity"]> = ["critical", "high", "medium", "low", "info"];
const EVIDENCE_TYPES: ReadonlyArray<Finding["evidence"][number]["type"]> = ["command", "diff", "source"];
const VERIFICATION_STATUSES: ReadonlyArray<Finding["verificationStatus"]> = ["verified", "inferred", "needs_human_review"];
const RECOMMENDATIONS: ReadonlyArray<Recommendation> = ["approve", "approve_with_notes", "needs_changes", "blocked", "inconclusive"];

const MAX_SUMMARY_CHARS = 500;

/** 统一的 Finding 校验错误：带上序号，消息格式由这里单点决定。 */
function findingError(index: number, reason: string): Error {
  return new Error(`Finding ${index + 1} ${reason}`);
}

/**
 * Agent 输出是不可信的外部结果。
 * 这里不仅检查字段类型，还检查路径、证据引用和高等级 Finding 的证据要求。
 */
export function validateReviewResult(value: unknown, checks: CheckResult[], changedPaths: string[] = []): ReviewResult {
  if (!value || typeof value !== "object") throw new Error("Agent 结果不是对象");
  const input = value as Record<string, unknown>; // Agent 返回结果的对象视图。
  if (typeof input.summary !== "string" || input.summary.length > MAX_SUMMARY_CHARS) throw new Error(`Agent summary 无效或超过 ${MAX_SUMMARY_CHARS} 字`);
  if (!Array.isArray(input.findings)) throw new Error("Agent findings 必须是数组");
  const findings = input.findings.map((item, index) => validateFinding(item, index, checks, changedPaths)); // 校验并归一化所有 Finding。
  return {
    schemaVersion: 1,
    mergeRecommendation: isRecommendation(input.mergeRecommendation) ? input.mergeRecommendation : "inconclusive",
    summary: input.summary,
    checks,
    findings,
    limitations: arrayOfStrings(input.limitations),
    nextActions: arrayOfStrings(input.nextActions),
    telemetry: normalizeTelemetry(input.telemetry),
  };
}

/** 校验并归一化单条 Finding，避免下游模块反复处理 undefined 字段。 */
function validateFinding(value: unknown, index: number, checks: CheckResult[], changedPaths: string[]): Finding {
  if (!value || typeof value !== "object") throw findingError(index, "不是对象");
  const item = value as Record<string, unknown>; // 单条 Finding 的原始对象。
  const location = item.location; // Finding 的文件和行号位置。
  if (typeof item.title !== "string" || typeof item.summary !== "string" || !location || typeof location !== "object" || Array.isArray(location)) throw findingError(index, "缺少必要字段");
  const loc = location as Record<string, unknown>; // 位置信息的对象视图。
  if (typeof loc.path !== "string") throw findingError(index, "缺少必要字段");
  const path = loc.path; // 归一化后的文件路径。
  if (changedPaths.length > 0 && !changedPaths.includes(path)) throw findingError(index, `定位到了未变更文件：${path}`);
  if (path.startsWith("/") || path.split("/").includes("..")) throw findingError(index, `路径无效：${path}`);
  const confidence = item.confidence; // 模型对该 Finding 的置信度。
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) throw findingError(index, "confidence 无效");
  const evidence = validateEvidence(item.evidence, checks, index); // 校验并归一化证据列表。
  if (!SEVERITIES.includes(item.severity as Finding["severity"])) throw findingError(index, "severity 无效");
  const severity = item.severity as Finding["severity"]; // 归一化后的严重等级。
  if ((severity === "critical" || severity === "high") && evidence.length === 0) throw findingError(index, "缺少高等级问题的证据");
  if (item.verificationStatus === "verified" && evidence.length === 0) throw findingError(index, "标记为 verified 但没有证据");
  const startLine = readLine(loc.startLine, "startLine", 1, index); // 归一化后的起始行号。
  const endLine = readLine(loc.endLine, "endLine", startLine, index); // 归一化后的结束行号。
  if (loc.startLine !== undefined && loc.endLine !== undefined && endLine < startLine) throw findingError(index, "行号范围无效");
  return {
    id: typeof item.id === "string" ? item.id : `finding_${index + 1}`,
    severity,
    category: typeof item.category === "string" ? item.category : "logic_risk",
    title: item.title,
    summary: item.summary,
    location: { path, startLine, endLine },
    evidence,
    confidence,
    suggestedFix: typeof item.suggestedFix === "string" ? item.suggestedFix : "请结合证据进行人工确认。",
    verificationStatus: VERIFICATION_STATUSES.includes(item.verificationStatus as Finding["verificationStatus"]) ? item.verificationStatus as Finding["verificationStatus"] : "needs_human_review",
  };
}

/** evidence 必须是数组，元素必须是带合法类型和字段的对象，且 command 只能引用真实存在的检查。 */
function validateEvidence(raw: unknown, checks: CheckResult[], index: number): Finding["evidence"] {
  if (raw !== undefined && !Array.isArray(raw)) throw findingError(index, "evidence 必须是数组");
  const entries = Array.isArray(raw) ? raw : [];
  if (entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw findingError(index, "evidence 无效");
  const references = new Set(checks.map((check) => check.checkId)); // 可被 evidence.command 引用的检查 ID。
  return entries.map((entry) => {
    const value = entry as Record<string, unknown>; // 单条证据的对象视图。
    const type = value.type; // 证据类型。
    if (!EVIDENCE_TYPES.includes(type as Finding["evidence"][number]["type"]) || typeof value.reference !== "string" || typeof value.summary !== "string") throw findingError(index, "evidence 无效");
    if (type === "command" && !references.has(value.reference)) throw findingError(index, `引用了不存在的检查：${value.reference}`);
    return { type: type as Finding["evidence"][number]["type"], reference: value.reference, summary: value.summary };
  });
}

/** 行号可以是 undefined（回退到 fallback），但只要出现就必须是 >= 1 的整数。 */
function readLine(value: unknown, label: string, fallback: number, index: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1) throw findingError(index, `${label} 无效`);
  return value as number;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeAgentTelemetry(value: unknown): AgentTelemetry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>; // 单个 Agent telemetry 的对象视图。
  return {
    usageAvailable: input.usageAvailable === true,
    durationMs: nonNegativeNumber(input.durationMs),
    turns: nonNegativeNumber(input.turns),
    toolCalls: nonNegativeNumber(input.toolCalls),
    inputTokens: nonNegativeNumber(input.inputTokens),
    outputTokens: nonNegativeNumber(input.outputTokens),
    cacheReadTokens: nonNegativeNumber(input.cacheReadTokens),
    cacheWriteTokens: nonNegativeNumber(input.cacheWriteTokens),
    totalCost: nonNegativeNumber(input.totalCost),
  };
}

function normalizeReviewTelemetry(value: unknown): ReviewTelemetry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>; // 多 Agent telemetry 的对象视图。
  return {
    usageAvailable: input.usageAvailable === true,
    specialistCount: nonNegativeNumber(input.specialistCount),
    successfulSpecialists: nonNegativeNumber(input.successfulSpecialists),
    failedSpecialists: nonNegativeNumber(input.failedSpecialists),
    specialistDurationMs: nonNegativeNumber(input.specialistDurationMs),
    aggregatorDurationMs: input.aggregatorDurationMs === undefined ? undefined : nonNegativeNumber(input.aggregatorDurationMs),
    totalDurationMs: nonNegativeNumber(input.totalDurationMs),
    turns: nonNegativeNumber(input.turns),
    toolCalls: nonNegativeNumber(input.toolCalls),
    inputTokens: nonNegativeNumber(input.inputTokens),
    outputTokens: nonNegativeNumber(input.outputTokens),
    cacheReadTokens: nonNegativeNumber(input.cacheReadTokens),
    cacheWriteTokens: nonNegativeNumber(input.cacheWriteTokens),
    totalCost: nonNegativeNumber(input.totalCost),
  };
}

/** 用共享判别函数区分两种 telemetry，避免校验层和执行层各写一份 `in` 检查。 */
function normalizeTelemetry(value: unknown): AnyTelemetry | undefined {
  if (!value || typeof value !== "object") return undefined;
  return isReviewTelemetry(value as AnyTelemetry) ? normalizeReviewTelemetry(value) : normalizeAgentTelemetry(value);
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecommendation(value: unknown): value is Recommendation {
  return (RECOMMENDATIONS as readonly unknown[]).includes(value);
}
