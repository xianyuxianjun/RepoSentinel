import type { Finding, GitContext, ReviewResult, RunMetadata } from "../types.js";
import { isReviewTelemetry } from "../types.js";

// 报告按严重程度排序，让人工首先看到可能阻断合并的问题。
const severityRank: Record<Finding["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** 把已校验结果渲染为方便人阅读的 Markdown 报告。 */
export function renderMarkdown(meta: RunMetadata, result: ReviewResult, context: GitContext): string {
  const findings = [...result.findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]); // 按严重程度排序后的 Finding。
  const lines = [
    "# RepoSentinel Review", "", `- Run: \`${meta.runId}\``, `- Repository: \`${meta.repositoryRoot}\``, `- Base: \`${context.base.ref}\` (${context.base.sha})`, `- Head: \`${context.head.ref}\` (${context.head.sha})`, `- Recommendation: **${result.mergeRecommendation}**`, "", "## Summary", result.summary, "", "## Checks",
  ];
  for (const check of result.checks) lines.push(`- ${check.status === "passed" ? "[x]" : "[ ]"} **${check.checkId}**: \`${check.displayCommand}\` - ${check.status} (${check.durationMs} ms)`);
  if (isReviewTelemetry(result.telemetry)) {
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
