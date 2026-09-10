import { runProcess } from "./process.js";
import { assertSafeCommand, redactSensitiveText, sanitizedEnvironment } from "./policy.js";
import { resolveApprovedCommand } from "./commands.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckCategory, CheckConfig, CheckResult, SentinelConfig } from "./types.js";

/** 返回启用的检查；保持配置对象和执行逻辑之间的唯一入口。 */
export function listChecks(config: SentinelConfig): Array<{ checkId: CheckCategory; config: CheckConfig }> {
  return (Object.entries(config.checks) as Array<[CheckCategory, CheckConfig | undefined]>)
    .filter((entry): entry is [CheckCategory, CheckConfig] => Boolean(entry[1] && entry[1].enabled !== false))
    .map(([checkId, check]) => ({ checkId, config: check }));
}

/**
 * 执行单项预批准检查，并把异常转换为 CheckResult。
 * 失败也要返回结构化结果，调用方才能区分代码失败和环境失败。
 */
export async function executeCheck(repoRoot: string, config: SentinelConfig, checkId: CheckCategory): Promise<CheckResult> {
  const check = config.checks[checkId]; // 当前检查的配置。
  const startedAt = new Date().toISOString(); // 当前检查开始时间。
  if (!check || check.enabled === false) return skipped(checkId, startedAt, "");
  // 即使配置已经在 loadConfig 时验证过，执行边界仍再次校验，避免未来新增调用路径绕过策略。
  assertSafeCommand(check.command, config.commandPolicy.allowed);
  const mapped = resolveApprovedCommand(check.command); // 从目录查表得到固定的可执行文件和参数。
  if (!mapped) throw new Error(`MVP 暂不支持该命令，请使用预定义 npm 检查：${check.command}`);
  const unavailable = await preflightCommand(repoRoot, mapped.npmScript); // 执行前检查依赖的 npm script 是否存在。
  if (unavailable) return environmentError(checkId, check.command, startedAt, unavailable);
  try {
    const result = await runProcess(mapped.file, mapped.args, { // 执行经过 allowlist 校验的检查命令。
      cwd: repoRoot,
      timeoutMs: check.timeoutSeconds * 1000,
      maxOutputBytes: config.commandPolicy.maxOutputBytes,
      env: sanitizedEnvironment(),
    });
    const output = redactSensitiveText(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim()); // 合并并脱敏命令输出。
    return {
      checkId, category: checkId, commandId: checkId, displayCommand: check.command,
      status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "passed" : isExternalServiceFailure(check.command, output) ? "environment_error" : "failed",
      exitCode: result.exitCode ?? undefined,
      startedAt, finishedAt: new Date().toISOString(), durationMs: result.durationMs,
      output, outputTruncated: result.outputTruncated,
    };
  } catch (error) {
    return environmentError(checkId, check.command, startedAt, redactSensitiveText(error instanceof Error ? error.message : String(error)));
  }
}

function skipped(checkId: CheckCategory, startedAt: string, displayCommand: string): CheckResult {
  return { checkId, category: checkId, commandId: checkId, displayCommand, status: "skipped", startedAt, finishedAt: new Date().toISOString(), durationMs: 0, output: "", outputTruncated: false };
}

function environmentError(checkId: CheckCategory, displayCommand: string, startedAt: string, error: string): CheckResult {
  return { checkId, category: checkId, commandId: checkId, displayCommand, status: "environment_error", startedAt, finishedAt: new Date().toISOString(), durationMs: 0, output: "", outputTruncated: false, error };
}

// 运行前先检查 npm script 是否存在，把「配置错误」转换为可解释的 environment_error。
// npmScript 为 undefined 表示 npm 内置子命令（如 audit），不需要预检。
async function preflightCommand(repoRoot: string, npmScript: string | undefined): Promise<string | undefined> {
  if (!npmScript) return undefined;
  try {
    const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }; // 仓库 package.json 内容。
    if (!packageJson.scripts || typeof packageJson.scripts[npmScript] !== "string") return `package.json 缺少 npm script：${npmScript}`;
    return undefined;
  } catch (error) {
    return `无法读取 package.json：${error instanceof Error ? error.message : String(error)}`;
  }
}

function isExternalServiceFailure(command: string, output: string): boolean {
  return command === "npm audit --json" && /audit endpoint returned an error|NOT_IMPLEMENTED|security\/advisories/i.test(output);
}
