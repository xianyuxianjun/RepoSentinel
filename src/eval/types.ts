import type { ReviewResult } from "../types.js";
import type { ReviewOptions } from "../review.js";

// expected.json 是评测数据集的「标准答案」契约，不参与生产 Review 决策。
export interface EvalExpected {
  findings?: Array<{ category?: string; severity?: string; path?: string; title?: string }>;
  recommendation?: string;
}

export interface EvalCase {
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
