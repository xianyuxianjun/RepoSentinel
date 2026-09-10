import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, configHash, loadOperatorConfig } from "./config.js";
import { resolveReviewModel, type ResolvedReviewModel } from "./model-runtime.js";
import { collectGitContext } from "./git.js";
import { executeCheck, listChecks } from "./checks.js";
import { runMultiAgentReview } from "./agent.js";
import { computeRecommendation, writeRun } from "./report.js";
import { TraceRecorder } from "./trace.js";
import { redactSensitiveText } from "./policy.js";
import type { CheckCategory, CheckResult, ReviewResult, ReviewTelemetry, RunMetadata, SentinelConfig } from "./types.js";

/** CLI review 命令到 ReviewService 的输入契约。 */
export interface ReviewOptions {
  repo: string;
  base?: string;
  head: string;
  configPath?: string;
  /** 操作者配置路径；不提供时依次看环境变量和默认路径。 */
  operatorConfigPath?: string;
  output?: string;
  allowDirty: boolean;
  dryRun: boolean;
}

export type CheckRunner = (repositoryRoot: string, config: SentinelConfig, checkId: CheckCategory) => Promise<CheckResult>;

/** Execute each configured check once, converting runner failures into explicit results. */
/**
 * 每个检查只执行一次；单项异常转成结果，不让外层 catch 重新执行整组检查。
 * 这保证检查副作用、Trace 和报告之间保持 exactly-once 语义。
 */
export async function executeChecksOnce(repositoryRoot: string, config: SentinelConfig, checkIds: CheckCategory[], runner: CheckRunner = executeCheck): Promise<CheckResult[]> {
  return Promise.all(checkIds.map(async (checkId) => {
    try {
      return await runner(repositoryRoot, config, checkId);
    } catch (error) {
      const check = config.checks[checkId]; // 失败检查对应的配置。
      const now = new Date().toISOString(); // 将异常结果统一使用同一时间点。
      return {
        checkId,
        category: checkId,
        commandId: checkId,
        displayCommand: check?.command ?? "",
        status: "environment_error",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        output: "",
        outputTruncated: false,
        error: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      } satisfies CheckResult;
    }
  }));
}

/**
 * ReviewService 主流程：加载配置 -> 收集 Git -> 执行检查 -> 编排 Agent -> 写报告。
 * 确定性步骤由这里掌控，Agent 只负责语义审查。
 */
export async function runReview(options: ReviewOptions): Promise<{ result: ReviewResult; metadata: RunMetadata; outputDir: string }> {
  const runStartedAt = Date.now(); // 整个 Review 流程开始时间。
  const repositoryRoot = resolve(options.repo); // 规范化后的仓库绝对路径。
  const config = await loadConfig(repositoryRoot, options.configPath); // 本次运行使用的配置。
  // 先确定本次审查的 Git 快照，后面的检查和 Agent 都使用同一份上下文。
  const context = await collectGitContext(repositoryRoot, options.base, options.head, config.review.maxDiffBytes, config.commandPolicy.denyPathPatterns); // 固定本次审查的 Git 快照。
  if (context.dirty && !options.allowDirty) throw new Error("工作区存在未提交修改；如确认要检查当前提交，请使用 --allow-dirty");
  if (context.changes.length > config.review.maxChangedFiles) throw new Error(`变更文件数超过限制：${context.changes.length} > ${config.review.maxChangedFiles}`);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`; // 本次运行的唯一标识。
  const outputDir = resolve(options.output ?? `${repositoryRoot}/.repo-sentinel/runs/${runId}`); // 报告和 Trace 的输出目录。
  await mkdir(outputDir, { recursive: true });
  const trace = new TraceRecorder(outputDir, runId); // 记录可审计生命周期事件。
  const metadata: RunMetadata = { // 描述输入快照和运行状态的元数据。
    schemaVersion: 1, runId, startedAt: new Date().toISOString(), status: "running", repositoryRoot,
    currentBranch: context.currentBranch, base: context.base, head: context.head, dirty: context.dirty, configHash: configHash(config),
  };
  await trace.record("run_created", { baseSha: context.base.sha, headSha: context.head.sha, changedFiles: context.changes.length });
  let result: ReviewResult; // 最终 Review 结果，dry-run 和真实运行都会写入它。
  let agentModel: ResolvedReviewModel | undefined; // 本次运行实际使用的模型；dry-run 或解析失败时为 undefined。
  let operatorPath: string | undefined; // 本次运行读取的操作者配置路径，用于事后审计模型来源。
  // dry-run 仍然生成完整产物，但明确不执行检查和 Agent，避免产生虚假质量指标。
  if (options.dryRun) {
    result = { schemaVersion: 1, mergeRecommendation: "inconclusive", summary: "Dry run：已收集变更并生成检查计划，未调用 Agent 或执行检查。", checks: listChecks(config).map(({ checkId, config: check }) => ({ checkId, category: checkId, commandId: checkId, displayCommand: check.command, status: "skipped" as const, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0, output: "", outputTruncated: false })), findings: [], limitations: ["dry-run 未执行检查"], nextActions: ["移除 --dry-run 以运行实际审查"] };
  } else {
    let executedChecks: CheckResult[] = []; // 主控已经执行过的检查结果。
    try {
      // 模型与提示词来自操作者配置，而不是被审查仓库的配置：
      // 后者随 PR 变更，不能用来决定审查成本和数据出向。
      const operator = await loadOperatorConfig(options.operatorConfigPath); // 操作者配置及其路径。
      operatorPath = operator.path;
      agentModel = await resolveReviewModel(operator.config.model, { thinkingLevel: operator.config.thinkingLevel });
      await trace.record("agent_model_resolved", { model: agentModel.reference, thinkingLevel: agentModel.thinkingLevel, operatorConfigPath: operator.path, rolePrompts: Object.keys(operator.config.rolePrompts ?? {}), aggregatorPromptOverridden: operator.config.aggregatorPrompt !== undefined });
      // 主控统一执行检查，专家只消费结果，避免多个 Agent 重复运行 npm 命令。
      const enabledChecks = listChecks(config); // 当前配置中启用的检查列表。
      executedChecks = await executeChecksOnce(repositoryRoot, config, enabledChecks.map(({ checkId }) => checkId));
      for (const check of executedChecks) await trace.record("check_result", check as unknown as Record<string, unknown>);
      result = await runMultiAgentReview({
        repositoryRoot,
        context,
        config,
        trace,
        initialChecks: executedChecks,
        maxTurns: config.review.maxAgentTurns,
        maxSeconds: config.review.maxAgentSeconds,
        maxParallelAgents: config.review.maxParallelAgents,
        specialistSeconds: config.review.maxSpecialistSeconds,
        aggregatorSeconds: config.review.maxAggregatorSeconds,
        agentModel,
        operator: operator.config,
      });
      result = { ...result, mergeRecommendation: computeRecommendation(result, config) };
    } catch (error) {
      const checks = executedChecks; // Agent 失败时仍保留已经完成的检查事实。
      const safeError = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1_000); // 脱敏并限制错误信息长度。
      result = { schemaVersion: 1, mergeRecommendation: "inconclusive", summary: "Agent 未能完成结构化审查。", checks, findings: [], limitations: [safeError], nextActions: ["检查 Pi 模型配置、认证和本地项目依赖后重试"] };
      await trace.record("run_error", { error: safeError });
    }
  }
  // 即使 Agent 失败，也写出完整的 ReviewTelemetry，便于区分“无问题”和“未完成”。
  const telemetry = result.telemetry; // Agent 或编排器产生的运行统计。
  result = {
    ...result,
    telemetry: telemetry && "specialistCount" in telemetry
      ? { ...telemetry, totalDurationMs: Date.now() - runStartedAt }
      : {
        usageAvailable: false,
        specialistCount: 0, successfulSpecialists: 0, failedSpecialists: 0, specialistDurationMs: 0,
        totalDurationMs: Date.now() - runStartedAt, turns: 0, toolCalls: 0, inputTokens: 0,
        outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0,
      } satisfies ReviewTelemetry,
  };
  metadata.status = result.mergeRecommendation === "inconclusive" ? "failed" : "completed";
  metadata.finishedAt = new Date().toISOString();
  // 把实际使用的模型写进 run.json，事后才能解释这份报告是哪个模型给出的。
  if (agentModel) metadata.agent = { provider: agentModel.model.provider, model: agentModel.model.id, thinkingLevel: agentModel.thinkingLevel };
  if (operatorPath) metadata.operatorConfigPath = operatorPath;
  await writeRun(outputDir, metadata, result, context);
  await trace.record("run_finished", { status: metadata.status, recommendation: result.mergeRecommendation });
  return { result, metadata, outputDir };
}
