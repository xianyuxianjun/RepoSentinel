import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, loadOperatorConfig } from "../config.js";
import { resolveReviewModel, type ResolvedReviewModel } from "../model-runtime.js";
import { collectGitContext } from "../git.js";
import { executeCheck, listChecks } from "../checks.js";
import { runMultiAgentReview } from "../agent.js";
import { computeRecommendation, writeRun } from "../report.js";
import { TraceRecorder } from "../trace.js";
import { errorMessage } from "../policy.js";
import type { CheckCategory, CheckResult, ReviewResult, RunMetadata, SentinelConfig } from "../types.js";
import { createDryRunResult, createFailureResult, createReviewRun, finalizeTelemetry, completeMetadata } from "./lifecycle.js";

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
        error: errorMessage(error),
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
  const context = await collectGitContext(repositoryRoot, options.base, options.head, config.review.maxDiffBytes, config.commandPolicy.denyPathPatterns);
  if (context.dirty && !options.allowDirty) throw new Error("工作区存在未提交修改；如确认要检查当前提交，请使用 --allow-dirty");
  if (context.changes.length > config.review.maxChangedFiles) throw new Error(`变更文件数超过限制：${context.changes.length} > ${config.review.maxChangedFiles}`);
  const run = createReviewRun(repositoryRoot, options.output, context, config); // 固化输出位置与输入快照。
  const outputDir = resolve(run.outputDir);
  await mkdir(outputDir, { recursive: true });
  const trace = new TraceRecorder(outputDir, run.id); // 记录可审计生命周期事件。
  await trace.record("run_created", { baseSha: context.base.sha, headSha: context.head.sha, changedFiles: context.changes.length });
  let result: ReviewResult; // 最终 Review 结果，dry-run 和真实运行都会写入它。
  let agentModel: ResolvedReviewModel | undefined; // 本次运行实际使用的模型；dry-run 或解析失败时为 undefined。
  let operatorPath: string | undefined; // 本次运行读取的操作者配置路径，用于事后审计模型来源。
  if (options.dryRun) {
    result = createDryRunResult(skippedChecks(config));
  } else {
    let executedChecks: CheckResult[] = []; // 主控已经执行过的检查结果。
    try {
      // 先跑确定性检查：即使模型配置或认证有问题，报告也应该保留检查证据，
      // 否则一次模型故障会把已经获得的测试/构建结论一并丢掉。
      // 主控统一执行检查，专家只消费结果，避免多个 Agent 重复运行 npm 命令。
      executedChecks = await executeChecksOnce(repositoryRoot, config, listChecks(config).map(({ checkId }) => checkId));
      for (const check of executedChecks) await trace.record("check_result", check as unknown as Record<string, unknown>);
      // 模型与提示词来自操作者配置，而不是被审查仓库的配置：
      // 后者随 PR 变更，不能用来决定审查成本和数据出向。
      const operator = await loadOperatorConfig(options.operatorConfigPath); // 操作者配置及其路径。
      operatorPath = operator.path;
      agentModel = await resolveReviewModel(operator.config.model, { thinkingLevel: operator.config.thinkingLevel });
      await trace.record("agent_model_resolved", { model: agentModel.reference, thinkingLevel: agentModel.thinkingLevel, operatorConfigPath: operator.path, rolePrompts: Object.keys(operator.config.rolePrompts ?? {}), aggregatorPromptOverridden: operator.config.aggregatorPrompt !== undefined });
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
      result = createFailureResult(executedChecks, error); // Agent 失败时仍保留已经完成的检查事实。
      await trace.record("run_error", { error: errorMessage(error) });
    }
  }
  result = finalizeTelemetry(result, runStartedAt);
  const metadata = completeMetadata(run.metadata, result, agentModel, operatorPath);
  await writeRun(outputDir, metadata, result, context);
  await trace.record("run_finished", { status: metadata.status, recommendation: result.mergeRecommendation });
  return { result, metadata, outputDir };
}

/** dry-run 的检查清单：保留计划，但明确标记为未执行。 */
function skippedChecks(config: SentinelConfig): CheckResult[] {
  const now = new Date().toISOString();
  return listChecks(config).map(({ checkId, config: check }) => ({
    checkId,
    category: checkId,
    commandId: checkId,
    displayCommand: check.command,
    status: "skipped" as const,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    output: "",
    outputTruncated: false,
  }));
}
