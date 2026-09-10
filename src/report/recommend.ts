import type { CheckResult, Finding, Recommendation, ReviewResult, SentinelConfig } from "../types.js";

/** 高等级且已验证的 Finding 是确定性阻断证据。 */
function isBlockingFinding(finding: Finding): boolean {
  return (finding.severity === "critical" || finding.severity === "high") && finding.verificationStatus === "verified";
}

/** 所有必须成功完成的检查 ID。 */
function requiredCheckIds(config: SentinelConfig): string[] {
  return Object.entries(config.checks)
    .filter(([, check]) => Boolean(check && check.enabled !== false && check.required))
    .map(([checkId]) => checkId);
}

const INCOMPLETE_STATUSES: ReadonlyArray<CheckResult["status"]> = ["environment_error", "timed_out", "skipped"];

/**
 * 重新计算最终建议，不信任模型自报的 mergeRecommendation。
 * 这是确定性安全门：模型只能提供证据，不能自行宣布「通过」。
 *
 * 判定顺序是设计的一部分：
 * 1) 已经拿到的确定性阻断证据优先，避免检查未完成或编排不完整把已发现的问题降级成「无法确认」；
 * 2) 必需检查失败同样给出可操作的 needs_changes；
 * 3) 其余「无法确认」情形（缺检查、检查未完成、编排降级、专家缺失）统一返回 inconclusive。
 */
export function computeRecommendation(result: Omit<ReviewResult, "mergeRecommendation">, config: SentinelConfig): Recommendation {
  if (result.findings.some(isBlockingFinding)) return "needs_changes";
  if (result.checks.some((check) => check.status === "failed" && config.checks[check.category]?.required)) return "needs_changes";
  if (requiredCheckIds(config).some((checkId) => !result.checks.some((check) => check.checkId === checkId))) return "inconclusive";
  if (result.checks.some((check) => config.checks[check.category]?.required && INCOMPLETE_STATUSES.includes(check.status))) return "inconclusive";
  // 编排降级和专家缺失都通过结构化字段表达，而不是解析 limitations 里的文本前缀。
  if (result.orchestrationError !== undefined) return "inconclusive";
  if ((result.incompleteSpecialists?.length ?? 0) > 0) return "inconclusive";
  return result.findings.length > 0 ? "approve_with_notes" : "approve";
}
