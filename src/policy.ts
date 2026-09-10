import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SentinelConfig } from "./types.js";

// 环境变量名称本身可能暴露凭据，因此执行检查时只保留最小安全集合。
const secretEnvPattern = /(KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL|PRIVATE)/i;
const shellMetaPattern = /[;&|`$<>\n\r]/;
// 仓库配置只能增加禁止模式，不能删除这些系统级敏感路径。
export const BASELINE_DENY_PATH_PATTERNS = [".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key", ".git/**"];

/** 合并系统基线和仓库自定义规则，并去重。 */
export function effectiveDenyPathPatterns(patterns: string[] = []): string[] {
  return [...new Set([...BASELINE_DENY_PATH_PATTERNS, ...patterns])];
}

/**
 * 脱敏不是权限控制，而是输出层的最后一道防线。
 * 文件访问和命令执行仍必须先经过路径/命令策略校验。
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED KEY]");
}

/**
 * 会被整体替换为 [REDACTED] 的凭据字段名。
 *
 * 这里刻意使用精确字段名而不是宽泛的子串匹配：
 * 旧实现用 /key|token|auth/i 匹配任意键名，会把 inputTokens、outputTokens 这类
 * 正常遥测字段也一并抹掉，让 Trace 失去可审计性。
 */
const CREDENTIAL_KEY_PATTERN = /^(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|credentials?|authorization|cookie)$/i;

/** 持久化到报告或 Trace 的错误消息长度上限。 */
const MAX_ERROR_MESSAGE_CHARS = 1_000;

/** 把任意异常转成可持久化的短消息：脱敏并限长，供报告、Trace 和检查结果共用。 */
export function errorMessage(error: unknown, maxChars = MAX_ERROR_MESSAGE_CHARS): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, maxChars);
}

/**
 * 递归脱敏任意 JSON-likes 的 payload：
 * 字符串走 redactSensitiveText，凭据字段直接整体替换，其余字段递归处理。
 * Trace 等诊断出口共用这一份实现，避免各写一套正则产生脱敏盲区。
 */
export function redactPayload(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, CREDENTIAL_KEY_PATTERN.test(key) ? "[REDACTED]" : redactPayload(item)]));
  }
  return value;
}

// 项目只需要支持有限的 glob 规则，因此用小型转换器避免引入额外依赖。
function globToRegExp(pattern: string): RegExp {
  let source = "^"; // 正在构造的正则表达式文本。
  for (let index = 0; index < pattern.length;) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
    } else if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
    } else if (pattern[index] === "*") {
      source += "[^/]*";
      index += 1;
    } else {
      source += pattern[index].replace(/[.\\+?^${}()|[\\]\\]/g, "\\$&");
      index += 1;
    }
  }
  return new RegExp(`${source}$`);
}

/** 判断路径是否位于仓库内且没有命中敏感路径规则。 */
export function isPathAllowed(repoRoot: string, candidate: string, config: { commandPolicy: Pick<SentinelConfig["commandPolicy"], "denyPathPatterns"> }): boolean {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(repoRoot, candidate); // 候选路径的绝对路径。
  const rel = relative(repoRoot, absolute).split(sep).join("/"); // 相对于仓库的标准化路径。
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return false;
  return !matchesDenyPath(rel, config.commandPolicy.denyPathPatterns);
}

/**
 * 判断仓库内相对路径是否命中敏感路径规则（含系统基线）。
 * 单独暴露出来，让 Diff 过滤等只拿到相对路径的调用方不必伪造一个 config 外壳。
 */
export function matchesDenyPath(relativePath: string, patterns: string[]): boolean {
  return effectiveDenyPathPatterns(patterns).some((pattern) => globToRegExp(pattern.split(sep).join("/")).test(relativePath));
}

export function assertPathAllowed(repoRoot: string, candidate: string, config: { commandPolicy: Pick<SentinelConfig["commandPolicy"], "denyPathPatterns"> }): void {
  if (!isPathAllowed(repoRoot, candidate, config)) throw new Error(`拒绝访问路径：${candidate}`);
}

/** 命令必须同时满足“无 Shell 控制语法”和“精确命中 allowlist”。 */
export function assertSafeCommand(command: string, allowed: string[]): void {
  if (shellMetaPattern.test(command)) throw new Error("命令包含不允许的 Shell 控制字符");
  if (!allowed.includes(command)) throw new Error(`命令不在允许列表中：${command}`);
}

/** 为子进程构造最小环境，避免把当前终端中的凭据传给检查命令。 */
export function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "HOME", "NODE_ENV", "TMPDIR", "TMP", "TEMP", "npm_config_user_agent"]); // 子进程可以继承的最小环境变量集合。
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key) && !secretEnvPattern.test(key)).concat([
    ["CI", "1"],
    ["NO_COLOR", "1"],
  ]));
}
