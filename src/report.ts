import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTelemetry, CheckResult, Finding, GitContext, Recommendation, ReviewResult, ReviewTelemetry, RunMetadata, SentinelConfig } from "./types.js";
import { redactSensitiveText } from "./policy.js";
import { renderSarif } from "./sarif.js";

// 报告按严重程度排序，让人工首先看到可能阻断合并的问题。
const severityRank: Record<Finding["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/**
 * Agent 输出是不可信的外部结果。
 * 这里不仅检查字段类型，还检查路径、证据引用和高等级 Finding 的证据要求。
 */
export function validateReviewResult(value: unknown, checks: CheckResult[], changedPaths: string[] = []): ReviewResult {
  if (!value || typeof value !== "object") throw new Error("Agent 结果不是对象");
  const input = value as Record<string, unknown>; // Agent 返回结果的对象视图。
  if (typeof input.summary !== "string" || input.summary.length > 500) throw new Error("Agent summary 无效或超过 500 字");
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

function normalizeTelemetry(value: unknown): AgentTelemetry | ReviewTelemetry | undefined {
  if (!value || typeof value !== "object") return undefined;
  return "specialistCount" in (value as Record<string, unknown>) ? normalizeReviewTelemetry(value) : normalizeAgentTelemetry(value);
}

/** 校验并归一化单条 Finding，避免下游模块反复处理 undefined 字段。 */
function validateFinding(value: unknown, index: number, checks: CheckResult[], changedPaths: string[]): Finding {
  if (!value || typeof value !== "object") throw new Error(`Finding ${index + 1} 不是对象`);
  const item = value as Record<string, unknown>; // 单条 Finding 的原始对象。
  const location = item.location as Record<string, unknown> | undefined; // Finding 的文件和行号位置。
  if (typeof item.title !== "string" || typeof item.summary !== "string" || !location || typeof location.path !== "string") throw new Error(`Finding ${index + 1} 缺少必要字段`);
  if (changedPaths.length > 0 && !changedPaths.includes(location.path)) throw new Error(`Finding ${index + 1} 定位到了未变更文件：${location.path}`);
  if (location.path.startsWith("/") || location.path.split("/").includes("..")) throw new Error(`Finding ${index + 1} 路径无效：${location.path}`);
  const confidence = item.confidence; // 模型对该 Finding 的置信度。
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) throw new Error(`Finding ${index + 1} confidence 无效`);
  if (item.evidence !== undefined && !Array.isArray(item.evidence)) throw new Error(`Finding ${index + 1} evidence 必须是数组`);
  const rawEvidence = Array.isArray(item.evidence) ? item.evidence : []; // Agent 提供的原始证据列表。
  if (rawEvidence.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error(`Finding ${index + 1} evidence 无效`);
  const evidence = rawEvidence.map((entry) => {
    const value = entry as Record<string, unknown>; // 单条证据的对象视图。
    return { type: value.type, reference: value.reference, summary: value.summary };
  });
  if (evidence.some((entry) => !["command", "diff", "source"].includes(String(entry.type)) || typeof entry.reference !== "string" || typeof entry.summary !== "string")) throw new Error(`Finding ${index + 1} evidence 无效`);
  if (!["critical", "high", "medium", "low", "info"].includes(String(item.severity))) throw new Error(`Finding ${index + 1} severity 无效`);
  const severity = String(item.severity) as Finding["severity"]; // 归一化后的严重等级。
  if ((severity === "critical" || severity === "high") && evidence.length === 0) throw new Error(`Finding ${index + 1} 缺少高等级问题的证据`);
  if (item.verificationStatus === "verified" && evidence.length === 0) throw new Error(`Finding ${index + 1} 标记为 verified 但没有证据`);
  if (location.startLine !== undefined && (!Number.isInteger(location.startLine) || Number(location.startLine) < 1)) throw new Error(`Finding ${index + 1} startLine 无效`);
  if (location.endLine !== undefined && (!Number.isInteger(location.endLine) || Number(location.endLine) < 1)) throw new Error(`Finding ${index + 1} endLine 无效`);
  if (location.startLine !== undefined && location.endLine !== undefined && Number(location.endLine) < Number(location.startLine)) throw new Error(`Finding ${index + 1} 行号范围无效`);
  const references = new Set(checks.map((check) => check.checkId)); // 可被 evidence.command 引用的检查 ID。
  for (const entry of evidence) if (entry.type === "command" && !references.has(String(entry.reference))) throw new Error(`Finding ${index + 1} 引用了不存在的检查：${String(entry.reference)}`);
  return {
    id: typeof item.id === "string" ? item.id : `finding_${index + 1}`,
    severity, category: typeof item.category === "string" ? item.category : "logic_risk",
    title: item.title, summary: item.summary,
    location: { path: location.path, startLine: numberOr(location.startLine, 1), endLine: numberOr(location.endLine, numberOr(location.startLine, 1)) },
    evidence: evidence.map((entry) => ({ type: String(entry.type) as Finding["evidence"][number]["type"], reference: String(entry.reference ?? ""), summary: String(entry.summary ?? "") })),
    confidence,
    suggestedFix: typeof item.suggestedFix === "string" ? item.suggestedFix : "请结合证据进行人工确认。",
    verificationStatus: ["verified", "inferred", "needs_human_review"].includes(String(item.verificationStatus)) ? String(item.verificationStatus) as Finding["verificationStatus"] : "needs_human_review",
  };
}

function numberOr(value: unknown, fallback: number): number { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback; }
function arrayOfStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function isRecommendation(value: unknown): value is Recommendation { return ["approve", "approve_with_notes", "needs_changes", "blocked", "inconclusive"].includes(String(value)); }

// computeRecommendation 依据 limitation 前缀做确定性判定，模型提供的文本不能冒充这些内部标记。
const INTERNAL_MARKERS = /^(agent_orchestration:|专家 Agent )/;

/**
 * 阻止模型生成的说明文本冒充内部标记。
 * 专家和汇总的结果都会经过这里，否则受 diff 提示注入影响的模型可以直接操控
 * 确定性结论（例如伪造 agent_orchestration 强制 inconclusive）。
 */
export function neutralizeInternalMarkers(value: string): string {
  return INTERNAL_MARKERS.test(value) ? `汇总补充：${value}` : value;
}

/**
 * 重新计算最终建议，不信任模型自报的 mergeRecommendation。
 * 这是确定性安全门：模型只能提供证据，不能自行宣布“通过”。
 */
export function computeRecommendation(result: Omit<ReviewResult, "mergeRecommendation">, config: SentinelConfig): Recommendation {
  // 第一优先：已经拿到的确定性阻断证据。只要存在 high/critical+verified，就给出可操作的
  // 阻断结论，而不是因为检查未完成或编排不完整降级成“无法确认”而丢掉已发现的问题。
  if (result.findings.some((finding) => (finding.severity === "critical" || finding.severity === "high") && finding.verificationStatus === "verified")) return "needs_changes";
  const requiredCheckIds = Object.entries(config.checks) // 所有必须成功完成的检查 ID。
    .filter(([, check]) => Boolean(check && check.enabled !== false && check.required))
    .map(([checkId]) => checkId);
  if (result.checks.some((check) => check.status === "failed" && config.checks[check.category]?.required)) return "needs_changes";
  // 以下都属于“无法确认”：缺少必需检查、必需检查未完成、专家或汇总未完成。
  // 这些规则统一排在阻断证据之后，避免任何一个环节的缺失掩盖已经发现的高等级问题。
  if (requiredCheckIds.some((checkId) => !result.checks.some((check) => check.checkId === checkId))) return "inconclusive";
  if (result.checks.some((check) => config.checks[check.category]?.required && (check.status === "environment_error" || check.status === "timed_out" || check.status === "skipped"))) return "inconclusive";
  if (result.limitations.some((item) => item.startsWith("agent_orchestration:"))) return "inconclusive";
  if (result.limitations.some((item) => item.startsWith("专家 Agent ") && item.includes("未完成"))) return "inconclusive";
  return result.findings.length > 0 ? "approve_with_notes" : "approve";
}

/** 把已校验结果渲染为方便人阅读的 Markdown 报告。 */
export function renderMarkdown(meta: RunMetadata, result: ReviewResult, context: GitContext): string {
  const findings = [...result.findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]); // 按严重程度排序后的 Finding。
  const lines = [
    "# RepoSentinel Review", "", `- Run: \`${meta.runId}\``, `- Repository: \`${meta.repositoryRoot}\``, `- Base: \`${context.base.ref}\` (${context.base.sha})`, `- Head: \`${context.head.ref}\` (${context.head.sha})`, `- Recommendation: **${result.mergeRecommendation}**`, "", "## Summary", result.summary, "", "## Checks",
  ];
  for (const check of result.checks) lines.push(`- ${check.status === "passed" ? "[x]" : "[ ]"} **${check.checkId}**: \`${check.displayCommand}\` - ${check.status} (${check.durationMs} ms)`);
  if (result.telemetry && "specialistCount" in result.telemetry) {
    const telemetry = result.telemetry; // 报告中展示的多 Agent 运行统计。
    lines.push("", "## Telemetry", `- Agent orchestration: ${telemetry.successfulSpecialists}/${telemetry.specialistCount} specialists succeeded`, `- Duration: ${telemetry.totalDurationMs} ms (specialists ${telemetry.specialistDurationMs} ms${telemetry.aggregatorDurationMs === undefined ? "" : `, aggregator ${telemetry.aggregatorDurationMs} ms`})`, `- Turns / tool calls: ${telemetry.turns} / ${telemetry.toolCalls}`, `- Tokens: input ${telemetry.inputTokens}, output ${telemetry.outputTokens}, cache read ${telemetry.cacheReadTokens}, cache write ${telemetry.cacheWriteTokens}`, `- Estimated cost: ${telemetry.totalCost}`);
  }
  lines.push("", "## Findings");
  if (findings.length === 0) lines.push("No findings.");
  for (const finding of findings) lines.push(`### ${finding.severity.toUpperCase()}: ${finding.title}`, `- Location: \`${finding.location.path}:${finding.location.startLine}\``, `- Confidence: ${finding.confidence}`, `- Verification: ${finding.verificationStatus}`, `- ${finding.summary}`, `- Suggested fix: ${finding.suggestedFix}`, `- Evidence: ${finding.evidence.map((e) => `${e.type}:${e.reference}`).join(", ") || "none"}`, "");
  if (result.limitations.length) lines.push("## Limitations", ...result.limitations.map((item) => `- ${item}`), "");
  if (result.nextActions.length) lines.push("## Next Actions", ...result.nextActions.map((item) => `- ${item}`), "");
  return `${lines.join("\n")}\n`;
}

/**
 * 统一写出 JSON、Markdown 和 SARIF。
 * safeResult 先完成脱敏，确保不同格式不会出现“某个格式忘记脱敏”的分叉。
 */
export async function writeRun(outputDir: string, meta: RunMetadata, result: ReviewResult, context: GitContext): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const safeChecks = result.checks.map((check) => ({ ...check, displayCommand: redactSensitiveText(check.displayCommand), output: redactSensitiveText(check.output), error: check.error ? redactSensitiveText(check.error) : undefined })); // 脱敏后的检查结果。
  // 只在持久化前复制并脱敏，不修改内存中的原始结果，避免影响后续逻辑。
  const safeResult: ReviewResult = { // 不修改内存原始结果的持久化安全副本。
    ...result,
    summary: redactSensitiveText(result.summary),
    checks: safeChecks,
    findings: result.findings.map((finding) => ({
      ...finding,
      category: redactSensitiveText(finding.category),
      title: redactSensitiveText(finding.title),
      summary: redactSensitiveText(finding.summary),
      suggestedFix: redactSensitiveText(finding.suggestedFix),
      evidence: finding.evidence.map((evidence) => ({ ...evidence, reference: redactSensitiveText(evidence.reference), summary: redactSensitiveText(evidence.summary) })),
    })),
    limitations: result.limitations.map(redactSensitiveText),
    nextActions: result.nextActions.map(redactSensitiveText),
  };
  await writeFile(join(outputDir, "run.json"), `${JSON.stringify({ ...meta, result: safeResult }, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, "checks.json"), `${JSON.stringify(safeChecks, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, "report.md"), renderMarkdown(meta, safeResult, context), "utf8");
  await writeFile(join(outputDir, "report.sarif"), `${JSON.stringify(renderSarif(safeResult, meta), null, 2)}\n`, "utf8");
}
