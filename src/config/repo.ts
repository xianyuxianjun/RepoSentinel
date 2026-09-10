import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { effectiveDenyPathPatterns } from "../policy.js";
import { resolveApprovedCommand } from "../commands.js";
import { CHECK_CATEGORIES, DEFAULT_CONFIG } from "./defaults.js";
import type { AgentRoleConfig, CheckCategory, CheckConfig, SentinelConfig } from "../types.js";

const MAX_CHANGED_FILES = 1_000; // 单次审查允许的最大变更文件数。
const MAX_DIFF_BYTES = 5_000_000; // 单次审查允许读取的最大 Diff 字节数。
const MAX_OUTPUT_BYTES = 5_000_000; // 单次检查允许保存的最大输出字节数。

const forbiddenCommandTokens = /[;&|`$<>\n\r]|\b(sudo|curl|wget|nc|ssh|git\s+(push|commit|reset|checkout)|rm\s+-rf)\b/i;

/** 用于把本次运行绑定到具体配置，便于事后解释报告产生的环境。 */
export function configHash(config: SentinelConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

/**
 * 配置是外部输入，即使来自本地仓库也不能直接信任。
 * 这里完成类型、范围、命令 allowlist 和角色约束的归一化。
 */
export function validateConfig(input: unknown): SentinelConfig {
  if (!input || typeof input !== "object") throw new Error("配置必须是 JSON 对象");
  const value = input as Record<string, unknown>; // 外部配置的对象视图。
  if (value.version !== 1) throw new Error("不支持的配置 version，当前只支持 1");
  const checks = validateChecks(value.checks); // 归一化后的检查配置。
  const { allowed, denyPathPatterns, maxOutputBytes } = validateCommandPolicy(value.commandPolicy, checks);
  const { limits, roles } = validateReview(value.review);
  assertLimitsInRange({ ...limits, maxOutputBytes }); // 角色先于数值范围校验，保持既有的错误优先级。
  return {
    version: 1,
    checks,
    commandPolicy: { allowed, denyPathPatterns, maxOutputBytes },
    review: { ...limits, roles },
  };
}

/** 只遍历系统认识的固定类别，未知字段不会自动变成可执行命令。 */
function validateChecks(raw: unknown): SentinelConfig["checks"] {
  const checks = (raw ?? {}) as Record<string, unknown>; // 用户声明的检查配置。
  const normalized: SentinelConfig["checks"] = {};
  for (const category of CHECK_CATEGORIES) {
    const item = checks[category];
    if (item === undefined) continue;
    if (!item || typeof item !== "object") throw new Error(`checks.${category} 必须是对象`);
    const check = item as Record<string, unknown>; // 当前检查的原始配置对象。
    if (typeof check.command !== "string" || check.command.trim() === "") throw new Error(`checks.${category}.command 无效`);
    if (forbiddenCommandTokens.test(check.command)) throw new Error(`checks.${category}.command 包含不允许的 Shell 语法`);
    const timeoutSeconds = check.timeoutSeconds ?? 120; // 当前检查的超时时间。
    if (typeof timeoutSeconds !== "number" || timeoutSeconds < 1 || timeoutSeconds > 900) throw new Error(`checks.${category}.timeoutSeconds 必须在 1 到 900 之间`);
    normalized[category as CheckCategory] = {
      command: check.command.trim(),
      required: check.required === true,
      timeoutSeconds,
      enabled: check.enabled !== false,
    } satisfies CheckConfig;
  }
  return normalized;
}

/**
 * commandPolicy 决定 Agent 最终能触发哪些确定性检查，是权限模型的一部分。
 * allowed 缺省时只有内置默认允许列表可用；每条启用检查的命令都必须命中它。
 */
function validateCommandPolicy(raw: unknown, checks: SentinelConfig["checks"]): { allowed: string[]; denyPathPatterns: string[]; maxOutputBytes: number } {
  const policy = (raw ?? {}) as Record<string, unknown>; // 命令和路径安全策略。
  const allowed = Array.isArray(policy.allowed) ? policy.allowed : DEFAULT_CONFIG.commandPolicy.allowed; // 允许执行的精确命令列表。
  if (!allowed.every((item) => typeof item === "string" && !forbiddenCommandTokens.test(item))) throw new Error("commandPolicy.allowed 包含非法命令");
  for (const [category, check] of Object.entries(checks)) {
    if (check && !allowed.includes(check.command)) throw new Error(`checks.${category}.command 不在 commandPolicy.allowed 中`);
  }
  const denyPathPatterns = effectiveDenyPathPatterns(
    Array.isArray(policy.denyPathPatterns) ? policy.denyPathPatterns.filter((item): item is string => typeof item === "string") : [],
  );
  const maxOutputBytes = typeof policy.maxOutputBytes === "number" ? policy.maxOutputBytes : DEFAULT_CONFIG.commandPolicy.maxOutputBytes; // 检查输出的字节上限。
  return { allowed: [...allowed] as string[], denyPathPatterns, maxOutputBytes };
}

/** Review 限制同时保护模型成本、进程资源和本地仓库稳定性。 */
function validateReview(raw: unknown): { limits: Omit<SentinelConfig["review"], "roles">; roles: AgentRoleConfig[] } {
  const review = (raw ?? {}) as Record<string, unknown>; // Review 资源限制和角色配置。
  const number = (key: keyof SentinelConfig["review"]): number => typeof review[key] === "number" ? review[key] as number : DEFAULT_CONFIG.review[key] as number;
  const maxAgentSeconds = number("maxAgentSeconds"); // 全局 Agent 时间上限，同时作为阶段级回退值。
  const limits = {
    maxChangedFiles: number("maxChangedFiles"),
    maxDiffBytes: number("maxDiffBytes"),
    maxAgentTurns: number("maxAgentTurns"),
    maxAgentSeconds,
    maxParallelAgents: number("maxParallelAgents"),
    // 阶段级超时优先取显式配置，否则回退到全局 maxAgentSeconds，最后才是内置默认。
    maxSpecialistSeconds: typeof review.maxSpecialistSeconds === "number" ? review.maxSpecialistSeconds : typeof review.maxAgentSeconds === "number" ? review.maxAgentSeconds : DEFAULT_CONFIG.review.maxSpecialistSeconds,
    maxAggregatorSeconds: typeof review.maxAggregatorSeconds === "number" ? review.maxAggregatorSeconds : typeof review.maxAgentSeconds === "number" ? review.maxAgentSeconds : DEFAULT_CONFIG.review.maxAggregatorSeconds,
  };
  const roles = validateRoles(review.roles ?? DEFAULT_CONFIG.review.roles); // 用户配置或默认的专家角色列表。
  return { limits, roles };
}

function validateRoles(rawRoles: unknown): AgentRoleConfig[] {
  if (!Array.isArray(rawRoles) || rawRoles.length < 1 || rawRoles.length > 8) throw new Error("review.roles 必须包含 1 到 8 个角色");
  const roleIds = new Set<string>(); // 用于检测重复角色 ID。
  const roles = rawRoles.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`review.roles[${index}] 必须是对象`);
    const item = raw as Record<string, unknown>; // 当前角色的原始配置。
    const id = typeof item.id === "string" ? item.id.trim() : ""; // 角色唯一标识。
    const instructions = typeof item.instructions === "string" ? item.instructions.trim() : ""; // 角色职责说明。
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(id)) throw new Error(`review.roles[${index}].id 无效`);
    if (roleIds.has(id)) throw new Error(`review.roles 包含重复角色：${id}`);
    if (instructions.length < 1 || instructions.length > 1000) throw new Error(`review.roles[${index}].instructions 必须为 1 到 1000 字`);
    roleIds.add(id);
    return { id, instructions, enabled: item.enabled !== false } satisfies AgentRoleConfig;
  });
  if (!roles.some((role) => role.enabled)) throw new Error("review.roles 至少启用一个角色");
  return roles;
}

function assertLimitsInRange(limits: Omit<SentinelConfig["review"], "roles"> & { maxOutputBytes: number }): void {
  const values = Object.values(limits);
  if (!values.every((n) => Number.isFinite(n) && n > 0)) throw new Error("review 和输出限制必须为有限正数");
  if (limits.maxChangedFiles > MAX_CHANGED_FILES) throw new Error(`变更文件数最多 ${MAX_CHANGED_FILES}`);
  if (limits.maxDiffBytes > MAX_DIFF_BYTES) throw new Error(`Diff 字节数最多 ${MAX_DIFF_BYTES}`);
  if (limits.maxOutputBytes > MAX_OUTPUT_BYTES) throw new Error(`输出字节数最多 ${MAX_OUTPUT_BYTES}`);
  if (limits.maxAgentTurns > 100 || limits.maxAgentSeconds > 3600) throw new Error("Agent 轮次最多 100，运行时间最多 3600 秒");
  if (limits.maxParallelAgents > 8) throw new Error("并行 Agent 最多 8 个");
  if (limits.maxSpecialistSeconds > 900 || limits.maxAggregatorSeconds > 900) throw new Error("专家和汇总 Agent 运行时间最多 900 秒");
}

/** 优先读取仓库配置；文件不存在时回退到代码内置默认配置。 */
export async function loadConfig(repoRoot: string, configPath?: string): Promise<SentinelConfig> {
  const path = resolve(repoRoot, configPath ?? ".repo-sentinel/config.json");
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown; // 从配置文件读取的未知输入。
    return validateConfig(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return validateConfig(DEFAULT_CONFIG);
    throw error;
  }
}

/**
 * 按目标仓库实际存在的 npm script 收敛检查。
 *
 * 只丢掉「非必需且脚本不存在」的检查（如本仓库没有 lint）：它们只会制造噪声。
 * 必需检查即使脚本缺失也保留——此时它会以 environment_error 让结论变成
 * inconclusive，也就是 fail-closed；删掉它反而会让确定性门禁静默消失。
 */
async function availableChecks(repoRoot: string): Promise<SentinelConfig["checks"]> {
  let scripts: Record<string, string> = {}; // 目标仓库声明的 npm scripts。
  try {
    const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    scripts = manifest.scripts ?? {};
  } catch {
    return DEFAULT_CONFIG.checks; // 读不到 package.json 时不猜，保留默认检查交由执行阶段判定。
  }
  const checks: SentinelConfig["checks"] = {};
  for (const [checkId, check] of Object.entries(DEFAULT_CONFIG.checks)) {
    if (!check) continue;
    const script = resolveApprovedCommand(check.command)?.npmScript; // 当前检查依赖的 script 名。
    if (script && scripts[script] === undefined && check.required !== true) continue;
    checks[checkId as CheckCategory] = check;
  }
  return checks;
}

/** 创建示例配置；默认不覆盖已有配置，防止误删用户设置。 */
export async function initConfig(repoRoot: string, force = false): Promise<string> {
  const path = resolve(repoRoot, ".repo-sentinel/config.json"); // 配置文件的绝对路径。
  if (!force) {
    try { await access(path); throw new Error(`配置已存在：${path}，如需覆盖请使用 --force`); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  // 按目标仓库实际存在的 npm script 生成检查，避免写入必然失败的检查。
  await writeFile(path, `${JSON.stringify({ ...DEFAULT_CONFIG, checks: await availableChecks(repoRoot) }, null, 2)}\n`, "utf8");
  return path;
}

export function configDirectory(repoRoot: string): string {
  return dirname(resolve(repoRoot, ".repo-sentinel/config.json"));
}
