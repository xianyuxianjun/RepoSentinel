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
  return !effectiveDenyPathPatterns(config.commandPolicy.denyPathPatterns).some((pattern) => globToRegExp(pattern.split(sep).join("/")).test(rel));
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
