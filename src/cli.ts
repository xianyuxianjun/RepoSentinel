#!/usr/bin/env node
import { initConfig } from "./config.js";
import { runReview } from "./review.js";
import { readFile } from "node:fs/promises";
import { compareEvalSummaries, type EvalSummary } from "./eval.js";

// MVP 使用轻量参数解析，保持 CLI 依赖少；复杂参数需求再引入专用 parser。
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag); // 参数名在命令行数组中的位置。
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args: string[], flag: string): boolean { return args.includes(flag); }

/** 集中维护命令帮助，避免业务分支里散落使用说明。 */
function usage(): void {
  console.log(`RepoSentinel 0.1.0

Usage:
  repo-sentinel init [--repo <path>] [--force]
  repo-sentinel review [--repo <path>] [--base <ref>] [--head <ref>] [--config <path>] [--output <path>] [--allow-dirty] [--dry-run]
  repo-sentinel eval --dataset <path>
    [--baseline <summary.json>] [--max-quality-drop <fraction>] [--max-p95-increase <fraction>]
  repo-sentinel diagnose [--repo <path>]
`);
}

/** CLI 只负责参数适配、结果打印和退出码映射，业务逻辑在 service 模块中。 */
async function main(): Promise<number> {
  const args = process.argv.slice(2); // 去掉 Node 和脚本路径后的命令行参数。
  const command = args[0]; // 用户选择的顶层命令。
  if (!command || command === "--help" || command === "-h") { usage(); return 0; }
  if (command === "init") {
    const repo = valueAfter(args, "--repo") ?? process.cwd(); // init 要处理的仓库路径。
    console.log(`已创建配置：${await initConfig(repo, has(args, "--force"))}`);
    return 0;
  }
  if (command === "eval") {
    const { runEvaluation } = await import("./eval.js");
    const dataset = valueAfter(args, "--dataset"); // eval 使用的数据集路径。
    if (!dataset) throw new Error("eval 缺少 --dataset <path>");
    let summary = await runEvaluation(dataset, { configPath: valueAfter(args, "--config"), allowDirty: has(args, "--allow-dirty"), dryRun: has(args, "--dry-run") }); // 当前评测汇总。
    const baselinePath = valueAfter(args, "--baseline"); // 可选的历史基线文件。
    let regressionFailed = false; // 是否触发评测回归门禁。
    if (baselinePath) {
      const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as EvalSummary; // 读取历史评测基线。
      const maxQualityDrop = Number(valueAfter(args, "--max-quality-drop") ?? 0.05);
      const maxP95IncreaseRatio = Number(valueAfter(args, "--max-p95-increase") ?? 0.2);
      if (!Number.isFinite(maxQualityDrop) || maxQualityDrop < 0 || !Number.isFinite(maxP95IncreaseRatio) || maxP95IncreaseRatio < 0) {
        throw new Error("回归阈值必须是非负有限数字");
      }
      const regression = compareEvalSummaries(summary, baseline, { baselinePath, maxQualityDrop, maxP95IncreaseRatio }); // 比较当前结果和历史基线。
      summary = { ...summary, regression };
      regressionFailed = regression.compared && !regression.passed;
    }
    console.log(JSON.stringify(summary, null, 2));
    return regressionFailed ? 3 : summary.failed === 0 ? 0 : 2;
  }
  if (command === "diagnose") {
    const { runAgentDiagnostic } = await import("./diagnose.js");
    const diagnostic = await runAgentDiagnostic(valueAfter(args, "--repo") ?? process.cwd()); // 执行 Provider 和 Tool Calling 诊断。
    console.log(JSON.stringify(diagnostic, null, 2));
    return diagnostic.ok ? 0 : 2;
  }
  if (command !== "review") { usage(); return 2; }
  // review 的退出码供 CI 使用：0 通过，1 需要修改/阻断，2 表示无法完成验证。
  const output = valueAfter(args, "--output"); // 可选的报告输出目录。
  const result = await runReview({ // 执行完整 Review 主流程。
    repo: valueAfter(args, "--repo") ?? process.cwd(),
    base: valueAfter(args, "--base"),
    head: valueAfter(args, "--head") ?? "HEAD",
    configPath: valueAfter(args, "--config"),
    output,
    allowDirty: has(args, "--allow-dirty"),
    dryRun: has(args, "--dry-run"),
  });
  console.log(`Recommendation: ${result.result.mergeRecommendation}`);
  console.log(result.result.summary);
  console.log(`Checks: ${result.result.checks.length}, Findings: ${result.result.findings.length}`);
  console.log(`报告目录：${result.outputDir}`);
  return result.result.mergeRecommendation === "approve" || result.result.mergeRecommendation === "approve_with_notes" ? 0 : result.result.mergeRecommendation === "needs_changes" || result.result.mergeRecommendation === "blocked" ? 1 : 2;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
