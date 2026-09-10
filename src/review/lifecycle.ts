import { randomUUID } from "node:crypto";
import { configHash } from "../config/repo.js";
import { emptyReviewTelemetry } from "../agent/telemetry.js";
import { isReviewTelemetry } from "../types.js";
import { errorMessage } from "../policy.js";
import type { CheckResult, GitContext, ReviewResult, RunMetadata, SentinelConfig } from "../types.js";
import type { ResolvedReviewModel } from "../model-runtime.js";

/** 一次 Review 运行的身份、输出位置和初始元数据。 */
export interface ReviewRun {
  id: string;
  outputDir: string;
  metadata: RunMetadata;
}

/** 固化本次运行的 ID、输出目录和输入快照，让后续阶段只消费不可变事实。 */
export function createReviewRun(repositoryRoot: string, outputRoot: string | undefined, context: GitContext, config: SentinelConfig): ReviewRun {
  const startedAtMs = Date.now();
  const id = `${new Date(startedAtMs).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  return {
    id,
    outputDir: outputRoot ?? `${repositoryRoot}/.repo-sentinel/runs/${id}`,
    metadata: {
      schemaVersion: 1,
      runId: id,
      startedAt: new Date(startedAtMs).toISOString(),
      status: "running",
      repositoryRoot,
      currentBranch: context.currentBranch,
      base: context.base,
      head: context.head,
      dirty: context.dirty,
      configHash: configHash(config),
    },
  };
}

/** dry-run 仍然生成完整产物，但明确不执行检查和 Agent，避免产生虚假质量指标。 */
export function createDryRunResult(checks: CheckResult[]): ReviewResult {
  return {
    schemaVersion: 1,
    mergeRecommendation: "inconclusive",
    summary: "Dry run：已收集变更并生成检查计划，未调用 Agent 或执行检查。",
    checks,
    findings: [],
    limitations: ["dry-run 未执行检查"],
    nextActions: ["移除 --dry-run 以运行实际审查"],
  };
}

/** Agent 或编排失败时的降级结果：保留已完成的检查事实，结论由上层重算为 inconclusive。 */
export function createFailureResult(checks: CheckResult[], error: unknown): ReviewResult {
  return {
    schemaVersion: 1,
    mergeRecommendation: "inconclusive",
    summary: "Agent 未能完成结构化审查。",
    checks,
    findings: [],
    limitations: [errorMessage(error)],
    nextActions: ["检查 Pi 模型配置、认证和本地项目依赖后重试"],
  };
}

/** 即使 Agent 失败，也补齐完整 telemetry，便于区分「无问题」和「未完成」。 */
export function finalizeTelemetry(result: ReviewResult, startedAtMs: number): ReviewResult {
  const telemetry = result.telemetry;
  return {
    ...result,
    telemetry: isReviewTelemetry(telemetry) ? { ...telemetry, totalDurationMs: Date.now() - startedAtMs } : emptyReviewTelemetry(Date.now() - startedAtMs),
  };
}

/** 补齐运行元数据的终态，并记录实际使用的模型和操作者配置来源。 */
export function completeMetadata(metadata: RunMetadata, result: ReviewResult, model?: ResolvedReviewModel, operatorConfigPath?: string): RunMetadata {
  const completed: RunMetadata = {
    ...metadata,
    status: result.mergeRecommendation === "inconclusive" ? "failed" : "completed",
    finishedAt: new Date().toISOString(),
  };
  if (model) completed.agent = { provider: model.model.provider, model: model.model.id, thinkingLevel: model.thinkingLevel };
  if (operatorConfigPath) completed.operatorConfigPath = operatorConfigPath;
  return completed;
}
