import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckResult, GitContext, ReviewResult, RunMetadata } from "../types.js";
import { redactSensitiveText } from "../policy.js";
import { renderSarif } from "../sarif.js";
import { renderMarkdown } from "./markdown.js";

/** 构造只用于持久化的脱敏副本，不修改内存中的原始结果。 */
function redactResult(result: ReviewResult): ReviewResult {
  const checks: CheckResult[] = result.checks.map((check) => ({
    ...check,
    displayCommand: redactSensitiveText(check.displayCommand),
    output: redactSensitiveText(check.output),
    error: check.error ? redactSensitiveText(check.error) : undefined,
  }));
  return {
    ...result,
    summary: redactSensitiveText(result.summary),
    checks,
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
}

/**
 * 统一写出 JSON、Markdown 和 SARIF。
 * 先完成脱敏再渲染三种格式，确保不会出现「某个格式忘记脱敏」的分叉。
 */
export async function writeRun(outputDir: string, meta: RunMetadata, result: ReviewResult, context: GitContext): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const safeResult = redactResult(result); // 脱敏后的持久化安全副本。
  const safeChecks = safeResult.checks; // run.json 与 checks.json 共用同一份脱敏检查结果。
  await writeFile(join(outputDir, "run.json"), `${JSON.stringify({ ...meta, result: safeResult }, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, "checks.json"), `${JSON.stringify(safeChecks, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, "report.md"), renderMarkdown(meta, safeResult, context), "utf8");
  await writeFile(join(outputDir, "report.sarif"), `${JSON.stringify(renderSarif(safeResult, meta), null, 2)}\n`, "utf8");
}
