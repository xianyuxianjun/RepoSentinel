import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Finding, ReviewResult, ReviewTelemetry } from "./types.js";
import { runReview, type ReviewOptions } from "./review.js";

// expected.json 是评测数据集的“标准答案”契约，不参与生产 Review 决策。
interface EvalExpected {
  findings?: Array<{ category?: string; severity?: string; path?: string; title?: string }>;
  recommendation?: string;
}

interface EvalCase {
  id: string;
  repository: string;
  base?: string;
  head?: string;
  expected: EvalExpected;
}

export interface EvalSummary {
  schemaVersion: 1;
  dataset: string;
  cases: number;
  completed: number;
  failed: number;
  scored: boolean;
  findingPrecision: number | null;
  findingRecall: number | null;
  falsePositiveRate: number | null;
  evidenceCoverage: number | null;
  checkExecutionSuccessRate: number | null;
  recommendationAccuracy: number | null;
  telemetryAvailableCases: number;
  averageDurationMs: number;
  p95DurationMs: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  averageInputTokens: number | null;
  averageOutputTokens: number | null;
  totalCost: number | null;
  averageCost: number | null;
  results: Array<Record<string, unknown>>;
  regression?: EvalRegression;
}

export interface EvalRegressionViolation {
  metric: string;
  baseline: number;
  current: number;
  delta: number;
  allowed: number;
  direction: "decrease" | "increase";
}

export interface EvalRegression {
  compared: boolean;
  passed: boolean;
  baseline?: string;
  maxQualityDrop: number;
  maxP95IncreaseRatio: number;
  violations: EvalRegressionViolation[];
  reason?: string;
}

export interface EvalRegressionOptions {
  maxQualityDrop?: number;
  maxP95IncreaseRatio?: number;
  baselinePath?: string;
}

export type EvaluationRunner = (options: ReviewOptions) => Promise<{ result: ReviewResult; outputDir: string }>;

/** 读取一个 case 的仓库位置、base/head 和预期 Finding。 */
async function loadCase(dataset: string, entry: string): Promise<EvalCase> {
  const directory = join(dataset, entry); // 当前评测 case 目录。
  const caseConfig = JSON.parse(await readFile(join(directory, "case.json"), "utf8")) as Record<string, unknown>; // case 的运行配置。
  const expected = JSON.parse(await readFile(join(directory, "expected.json"), "utf8")) as EvalExpected; // case 的标准答案。
  const repository = resolve(directory, typeof caseConfig.repository === "string" ? caseConfig.repository : "repository"); // case 对应的 Git 仓库。
  return { id: typeof caseConfig.id === "string" ? caseConfig.id : entry, repository, base: typeof caseConfig.base === "string" ? caseConfig.base : undefined, head: typeof caseConfig.head === "string" ? caseConfig.head : "HEAD", expected };
}

/** 使用可解释的字段匹配，避免评测因模型措辞轻微变化而完全失去可比性。 */
function matches(actual: Finding, expected: NonNullable<EvalExpected["findings"]>[number]): boolean {
  return (!expected.category || actual.category === expected.category) &&
    (!expected.severity || actual.severity === expected.severity) &&
    (!expected.path || actual.location.path === expected.path) &&
    (!expected.title || actual.title.toLowerCase().includes(expected.title.toLowerCase()));
}

/** 一对一匹配 expected，防止一条实际 Finding 重复计为多个 true positive。 */
function scoreFindings(actual: Finding[], expected: NonNullable<EvalExpected["findings"]>): { truePositive: number; falsePositive: number; falseNegative: number; evidence: number } {
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

function asReviewTelemetry(value: ReviewResult["telemetry"]): ReviewTelemetry | undefined {
  return value && "specialistCount" in value ? value : undefined;
}

/** 计算离散样本的近似 P95，用于观察长尾耗时而非只看平均值。 */
function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b); // 从小到大排列的耗时样本。
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)); // 百分位对应的样本下标。
  return sorted[index];
}

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
  const qualityMetrics: Array<{ metric: keyof EvalSummary; direction: "higher" | "lower" }> = [
    { metric: "findingPrecision", direction: "higher" },
    { metric: "findingRecall", direction: "higher" },
    { metric: "falsePositiveRate", direction: "lower" },
    { metric: "recommendationAccuracy", direction: "higher" },
    { metric: "evidenceCoverage", direction: "higher" },
    { metric: "checkExecutionSuccessRate", direction: "higher" },
  ];
  for (const { metric, direction } of qualityMetrics) {
    const previous = baseline[metric];
    const next = current[metric];
    if (typeof previous !== "number" || typeof next !== "number") continue;
    const delta = next - previous;
    if ((direction === "higher" && delta < -maxQualityDrop) || (direction === "lower" && delta > maxQualityDrop)) {
      base.violations.push({ metric, baseline: previous, current: next, delta, allowed: maxQualityDrop, direction: direction === "higher" ? "decrease" : "increase" });
    }
  }
  if (baseline.p95DurationMs > 0 && current.p95DurationMs > baseline.p95DurationMs * (1 + maxP95IncreaseRatio)) {
    const delta = current.p95DurationMs - baseline.p95DurationMs;
    base.violations.push({ metric: "p95DurationMs", baseline: baseline.p95DurationMs, current: current.p95DurationMs, delta, allowed: baseline.p95DurationMs * maxP95IncreaseRatio, direction: "increase" });
  }
  return { ...base, compared: true, passed: base.violations.length === 0 };
}

/**
 * 顺序运行数据集中的每个 case，并汇总质量、检查成功率、延迟和 usage。
 * reviewRunner 可注入 Fake Runner，因此指标计算可以脱离真实模型测试。
 */
export async function runEvaluation(datasetPath: string, baseOptions: Omit<ReviewOptions, "repo" | "base" | "head" | "output">, reviewRunner: EvaluationRunner = runReview): Promise<EvalSummary> {
  // dry-run 只验证数据集和运行链路，不调用模型，所以质量指标必须标为不可评分。
  const scored = !baseOptions.dryRun; // 是否真实调用模型并计算质量指标。
  const dataset = resolve(datasetPath); // 评测数据集绝对路径。
  const entries = (await readdir(dataset, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); // 按名称排序的 case 列表。
  const results: Array<Record<string, unknown>> = []; // 每个 case 的运行结果。
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let evidenceCount = 0;
  let checkExecutions = 0;
  let checkSuccesses = 0;
  let completed = 0;
  let recommendationMatches = 0;
  let telemetryAvailableCases = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  const durations: number[] = []; // 所有完成 case 的耗时样本。
  // case 按名称排序并顺序运行，结果稳定且不会同时占用过多 Provider/进程资源。
  for (const entry of entries) {
    const caseStartedAt = Date.now();
    try {
      const item = await loadCase(dataset, entry); // 当前 case 的配置和仓库。
      const run = await reviewRunner({ ...baseOptions, repo: item.repository, base: item.base, head: item.head ?? "HEAD" }); // 执行一次 Review。
      const expectedFindings = item.expected.findings ?? []; // 当前 case 预期的问题列表。
      const score = scoreFindings(run.result.findings, expectedFindings); // 对实际 Finding 进行匹配计分。
      if (scored) {
        truePositive += score.truePositive;
        falsePositive += score.falsePositive;
        falseNegative += score.falseNegative;
        evidenceCount += score.evidence;
        checkExecutions += run.result.checks.length;
        checkSuccesses += run.result.checks.filter((check) => check.status === "passed").length;
      }
      completed += 1;
      const telemetry = asReviewTelemetry(run.result.telemetry); // 当前 case 的多 Agent 统计。
      const durationMs = telemetry?.totalDurationMs ?? Date.now() - caseStartedAt; // 当前 case 总耗时。
      durations.push(durationMs);
      if (scored && telemetry?.usageAvailable) {
        telemetryAvailableCases += 1;
        totalInputTokens += telemetry.inputTokens;
        totalOutputTokens += telemetry.outputTokens;
        totalCost += telemetry.totalCost;
      }
      const recommendationCorrect = scored && (item.expected.recommendation === undefined || item.expected.recommendation === run.result.mergeRecommendation);
      if (recommendationCorrect) recommendationMatches += 1;
      results.push({ id: item.id, status: "completed", scored, recommendation: run.result.mergeRecommendation, recommendationCorrect: scored ? recommendationCorrect : null, durationMs, telemetry, checkExecutionSuccessRate: scored ? (run.result.checks.length === 0 ? 1 : run.result.checks.filter((check) => check.status === "passed").length / run.result.checks.length) : null, ...(scored ? score : { truePositive: null, falsePositive: null, falseNegative: null, evidence: null }), report: run.outputDir });
    } catch (error) {
      results.push({ id: entry, status: "failed", durationMs: Date.now() - caseStartedAt, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const actualPositive = truePositive + falsePositive;
  const expectedPositive = truePositive + falseNegative;
  return {
    schemaVersion: 1, dataset, cases: entries.length, completed, failed: entries.length - completed,
    scored,
    findingPrecision: scored ? (actualPositive === 0 ? 1 : truePositive / actualPositive) : null,
    findingRecall: scored ? (expectedPositive === 0 ? 1 : truePositive / expectedPositive) : null,
    falsePositiveRate: scored ? (actualPositive === 0 ? 0 : falsePositive / actualPositive) : null,
    evidenceCoverage: scored ? (truePositive === 0 ? 1 : evidenceCount / truePositive) : null,
    checkExecutionSuccessRate: scored ? (checkExecutions === 0 ? 1 : checkSuccesses / checkExecutions) : null,
    recommendationAccuracy: scored ? (completed === 0 ? 0 : recommendationMatches / completed) : null,
    telemetryAvailableCases,
    averageDurationMs: durations.length === 0 ? 0 : durations.reduce((sum, value) => sum + value, 0) / durations.length,
    p95DurationMs: percentile(durations, 0.95),
    totalInputTokens: scored ? totalInputTokens : null,
    totalOutputTokens: scored ? totalOutputTokens : null,
    averageInputTokens: scored ? (telemetryAvailableCases === 0 ? 0 : totalInputTokens / telemetryAvailableCases) : null,
    averageOutputTokens: scored ? (telemetryAvailableCases === 0 ? 0 : totalOutputTokens / telemetryAvailableCases) : null,
    totalCost: scored ? totalCost : null,
    averageCost: scored ? (telemetryAvailableCases === 0 ? 0 : totalCost / telemetryAvailableCases) : null,
    results,
  };
}
