import { isReviewTelemetry } from "../types.js";
import type { AnyTelemetry, Finding, ReviewTelemetry } from "../types.js";
import type { EvalExpected, EvalRegression, EvalRegressionOptions, EvalSummary } from "./types.js";

/** 运行级 telemetry 才有评测需要的字段；单 Agent telemetry 不参与运行指标。 */
export function asReviewTelemetry(value: unknown): ReviewTelemetry | undefined {
  return isReviewTelemetry(value as AnyTelemetry | undefined) ? value as ReviewTelemetry : undefined;
}

/** 使用可解释的字段匹配，避免评测因模型措辞轻微变化而完全失去可比性。 */
function matches(actual: Finding, expected: NonNullable<EvalExpected["findings"]>[number]): boolean {
  return (!expected.category || actual.category === expected.category) &&
    (!expected.severity || actual.severity === expected.severity) &&
    (!expected.path || actual.location.path === expected.path) &&
    (!expected.title || actual.title.toLowerCase().includes(expected.title.toLowerCase()));
}

/** 一对一匹配 expected，防止一条实际 Finding 重复计为多个 true positive。 */
export function scoreFindings(actual: Finding[], expected: NonNullable<EvalExpected["findings"]>): { truePositive: number; falsePositive: number; falseNegative: number; evidence: number } {
  const used = new Set<number>(); // 已被匹配的 expected 下标，避免重复计分。
  let truePositive = 0; // 正确匹配的 Finding 数量。
  let evidence = 0; // 有证据支持的正确 Finding 数量。
  for (const finding of actual) {
    const index = expected.findIndex((item, itemIndex) => !used.has(itemIndex) && matches(finding, item));
    if (index >= 0) {
      used.add(index);
      truePositive += 1;
      if (finding.evidence.length > 0) evidence += 1;
    }
  }
  return { truePositive, falsePositive: actual.length - truePositive, falseNegative: expected.length - truePositive, evidence };
}

/** 计算离散样本的近似 P95，用于观察长尾耗时而非只看平均值。 */
export function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b); // 从小到大排列的耗时样本。
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)); // 百分位对应的样本下标。
  return sorted[index];
}

/** 质量指标：direction 表示「越大越好」还是「越小越好」。 */
const QUALITY_METRICS: Array<{ metric: keyof EvalSummary; direction: "higher" | "lower" }> = [
  { metric: "findingPrecision", direction: "higher" },
  { metric: "findingRecall", direction: "higher" },
  { metric: "falsePositiveRate", direction: "lower" },
  { metric: "recommendationAccuracy", direction: "higher" },
  { metric: "evidenceCoverage", direction: "higher" },
  { metric: "checkExecutionSuccessRate", direction: "higher" },
];

/** Compare scored eval summaries without treating unavailable metrics as zero. */
export function compareEvalSummaries(current: EvalSummary, baseline: EvalSummary, options: EvalRegressionOptions = {}): EvalRegression {
  const maxQualityDrop = options.maxQualityDrop ?? 0.05; // 质量指标允许下降的最大幅度。
  const maxP95IncreaseRatio = options.maxP95IncreaseRatio ?? 0.2; // P95 耗时允许上升的最大比例。
  const base: EvalRegression = {
    compared: false,
    passed: true,
    baseline: options.baselinePath,
    maxQualityDrop,
    maxP95IncreaseRatio,
    violations: [],
  };
  if (!current.scored || !baseline.scored) {
    return { ...base, reason: "仅允许比较 scored=true 的评测汇总。" };
  }
  const violations = [...base.violations];
  for (const { metric, direction } of QUALITY_METRICS) {
    const previous = baseline[metric];
    const next = current[metric];
    if (typeof previous !== "number" || typeof next !== "number") continue;
    const delta = next - previous;
    if ((direction === "higher" && delta < -maxQualityDrop) || (direction === "lower" && delta > maxQualityDrop)) {
      violations.push({ metric, baseline: previous, current: next, delta, allowed: maxQualityDrop, direction: direction === "higher" ? "decrease" : "increase" });
    }
  }
  if (baseline.p95DurationMs > 0 && current.p95DurationMs > baseline.p95DurationMs * (1 + maxP95IncreaseRatio)) {
    const delta = current.p95DurationMs - baseline.p95DurationMs;
    violations.push({ metric: "p95DurationMs", baseline: baseline.p95DurationMs, current: current.p95DurationMs, delta, allowed: baseline.p95DurationMs * maxP95IncreaseRatio, direction: "increase" });
  }
  return { ...base, compared: true, passed: violations.length === 0, violations };
}
