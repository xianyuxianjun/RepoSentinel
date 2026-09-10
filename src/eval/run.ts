import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runReview, type ReviewOptions } from "../review.js";
import { asReviewTelemetry, percentile, scoreFindings } from "./score.js";
import type { EvalCase, EvalExpected, EvalSummary, EvaluationRunner } from "./types.js";

/** 读取一个 case 的仓库位置、base/head 和预期 Finding。 */
async function loadCase(dataset: string, entry: string): Promise<EvalCase> {
  const directory = join(dataset, entry); // 当前评测 case 目录。
  const caseConfig = JSON.parse(await readFile(join(directory, "case.json"), "utf8")) as Record<string, unknown>; // case 的运行配置。
  const expected = JSON.parse(await readFile(join(directory, "expected.json"), "utf8")) as EvalExpected; // case 的标准答案。
  const repository = resolve(directory, typeof caseConfig.repository === "string" ? caseConfig.repository : "repository"); // case 对应的 Git 仓库。
  return { id: typeof caseConfig.id === "string" ? caseConfig.id : entry, repository, base: typeof caseConfig.base === "string" ? caseConfig.base : undefined, head: typeof caseConfig.head === "string" ? caseConfig.head : "HEAD", expected };
}

/** 一次评测运行的累计指标，避免在顺序循环里散落十几个可变变量。 */
interface ScoreBoard {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  evidence: number;
  checkExecutions: number;
  checkSuccesses: number;
  recommendationMatches: number;
  telemetryAvailableCases: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  durations: number[];
}

function emptyScoreBoard(): ScoreBoard {
  return { truePositive: 0, falsePositive: 0, falseNegative: 0, evidence: 0, checkExecutions: 0, checkSuccesses: 0, recommendationMatches: 0, telemetryAvailableCases: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0, durations: [] };
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
  const board = emptyScoreBoard(); // 所有 case 的累计指标。
  const results: Array<Record<string, unknown>> = []; // 每个 case 的运行结果。
  let completed = 0;
  // case 按名称排序并顺序运行，结果稳定且不会同时占用过多 Provider/进程资源。
  for (const entry of entries) {
    const caseStartedAt = Date.now();
    try {
      const item = await loadCase(dataset, entry); // 当前 case 的配置和仓库。
      const run = await reviewRunner({ ...baseOptions, repo: item.repository, base: item.base, head: item.head ?? "HEAD" }); // 执行一次 Review。
      const expectedFindings = item.expected.findings ?? []; // 当前 case 预期的问题列表。
      const score = scoreFindings(run.result.findings, expectedFindings); // 对实际 Finding 进行匹配计分。
      const recommendationCorrect = scored && (item.expected.recommendation === undefined || item.expected.recommendation === run.result.mergeRecommendation);
      if (scored) {
        board.truePositive += score.truePositive;
        board.falsePositive += score.falsePositive;
        board.falseNegative += score.falseNegative;
        board.evidence += score.evidence;
        board.checkExecutions += run.result.checks.length;
        board.checkSuccesses += run.result.checks.filter((check) => check.status === "passed").length;
      }
      completed += 1;
      const telemetry = asReviewTelemetry(run.result.telemetry); // 当前 case 的多 Agent 统计。
      const durationMs = telemetry?.totalDurationMs ?? Date.now() - caseStartedAt; // 当前 case 总耗时。
      board.durations.push(durationMs);
      if (scored && telemetry?.usageAvailable) {
        board.telemetryAvailableCases += 1;
        board.totalInputTokens += telemetry.inputTokens;
        board.totalOutputTokens += telemetry.outputTokens;
        board.totalCost += telemetry.totalCost;
      }
      if (recommendationCorrect) board.recommendationMatches += 1;
      results.push({ id: item.id, status: "completed", scored, recommendation: run.result.mergeRecommendation, recommendationCorrect: scored ? recommendationCorrect : null, durationMs, telemetry, checkExecutionSuccessRate: scored ? (run.result.checks.length === 0 ? 1 : run.result.checks.filter((check) => check.status === "passed").length / run.result.checks.length) : null, ...(scored ? score : { truePositive: null, falsePositive: null, falseNegative: null, evidence: null }), report: run.outputDir });
    } catch (error) {
      results.push({ id: entry, status: "failed", durationMs: Date.now() - caseStartedAt, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const actualPositive = board.truePositive + board.falsePositive;
  const expectedPositive = board.truePositive + board.falseNegative;
  return {
    schemaVersion: 1, dataset, cases: entries.length, completed, failed: entries.length - completed,
    scored,
    findingPrecision: scored ? (actualPositive === 0 ? 1 : board.truePositive / actualPositive) : null,
    findingRecall: scored ? (expectedPositive === 0 ? 1 : board.truePositive / expectedPositive) : null,
    falsePositiveRate: scored ? (actualPositive === 0 ? 0 : board.falsePositive / actualPositive) : null,
    evidenceCoverage: scored ? (board.truePositive === 0 ? 1 : board.evidence / board.truePositive) : null,
    checkExecutionSuccessRate: scored ? (board.checkExecutions === 0 ? 1 : board.checkSuccesses / board.checkExecutions) : null,
    recommendationAccuracy: scored ? (completed === 0 ? 0 : board.recommendationMatches / completed) : null,
    telemetryAvailableCases: board.telemetryAvailableCases,
    averageDurationMs: board.durations.length === 0 ? 0 : board.durations.reduce((sum, value) => sum + value, 0) / board.durations.length,
    p95DurationMs: percentile(board.durations, 0.95),
    totalInputTokens: scored ? board.totalInputTokens : null,
    totalOutputTokens: scored ? board.totalOutputTokens : null,
    averageInputTokens: scored ? (board.telemetryAvailableCases === 0 ? 0 : board.totalInputTokens / board.telemetryAvailableCases) : null,
    averageOutputTokens: scored ? (board.telemetryAvailableCases === 0 ? 0 : board.totalOutputTokens / board.telemetryAvailableCases) : null,
    totalCost: scored ? board.totalCost : null,
    averageCost: scored ? (board.telemetryAvailableCases === 0 ? 0 : board.totalCost / board.telemetryAvailableCases) : null,
    results,
  };
}
