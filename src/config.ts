import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { effectiveDenyPathPatterns } from "./policy.js";
import type { AgentRoleConfig, CheckCategory, OperatorConfig, SentinelConfig, ThinkingLevelName } from "./types.js";

// 默认角色按关注点分工，而不是让一个 Agent 同时承担所有审查任务。
// 角色配置化后，用户可以增删职责，但仍受数量和格式限制。
const defaultRoles: AgentRoleConfig[] = [
  { id: "logic", instructions: "重点检查业务逻辑、边界条件、状态变化和潜在回归。", enabled: true },
  { id: "testing", instructions: "重点检查测试覆盖、类型安全、构建配置和检查失败是否揭示真实问题。", enabled: true },
  { id: "security", instructions: "重点检查敏感数据、权限边界、依赖和输入处理风险。", enabled: true },
  { id: "quality", instructions: "重点检查可维护性、性能、API 设计和工程一致性。", enabled: true },
];

/**
 * 未提供操作者配置时使用的模型引用。
 *
 * 这是一个内置默认值，仓库内的 .repo-sentinel/config.json 无权修改它：
 * 那份配置随 PR 一起变更，不能用来决定审查成本和数据出向。
 */
export const DEFAULT_MODEL_REFERENCE = "deepseek/deepseek-v4-flash";

const MAX_MODEL_REFERENCE_LENGTH = 200; // 模型引用长度上限，防止异常配置进入 Trace 和报告。
const MAX_SYSTEM_PROMPT_CHARS = 4_000; // 单个 Agent 提示词前段的长度上限。
const thinkingLevels: ThinkingLevelName[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]; // SDK 支持的档位全集。

/** 缺少操作者配置时的默认值：内置模型、无提示词覆盖。 */
export const DEFAULT_OPERATOR_CONFIG: OperatorConfig = { version: 1, model: DEFAULT_MODEL_REFERENCE };

/** 操作者配置的默认路径：与 Pi 自身的 agent 配置放在一起，位于被审查仓库之外。 */
export function defaultOperatorConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(); // 当前用户的主目录。
  return join(home, ".pi", "agent", "repo-sentinel.json");
}

function validateSystemPrompt(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_SYSTEM_PROMPT_CHARS) throw new Error(`操作者配置的 ${label} 必须是 1 到 ${MAX_SYSTEM_PROMPT_CHARS} 字的字符串`);
  return value;
}

/**
 * 操作者配置是本地文件，但同样按外部输入校验：
 * 模型引用与提示词都会进入 SDK 调用和 Trace，必须限制长度并拒绝控制字符。
 */
export function validateOperatorConfig(input: unknown): OperatorConfig {
  if (!input || typeof input !== "object") throw new Error("操作者配置必须是 JSON 对象");
  const value = input as Record<string, unknown>; // 操作者配置的对象视图。
  if (value.version !== 1) throw new Error("不支持的操作者配置 version，当前只支持 1");
  const rawModel = value.model ?? DEFAULT_MODEL_REFERENCE; // 未声明模型时用内置默认。
  if (typeof rawModel !== "string" || rawModel.trim() === "" || rawModel.length > MAX_MODEL_REFERENCE_LENGTH || /[\u0000-\u001f\u007f]/.test(rawModel)) throw new Error(`操作者配置的 model 必须为 1 到 ${MAX_MODEL_REFERENCE_LENGTH} 字的模型引用，例如 ${DEFAULT_MODEL_REFERENCE}`);
  let thinkingLevel: ThinkingLevelName | undefined; // 可选的全局思考档位。
  if (value.thinkingLevel !== undefined) {
    if (typeof value.thinkingLevel !== "string" || !thinkingLevels.includes(value.thinkingLevel as ThinkingLevelName)) throw new Error(`操作者配置的 thinkingLevel 只能是 ${thinkingLevels.join("、")}`);
    thinkingLevel = value.thinkingLevel as ThinkingLevelName;
  }
  const rawPrompts = value.rolePrompts; // 按角色 ID 的前段提示词覆盖。
  let rolePrompts: Record<string, string> | undefined;
  if (rawPrompts !== undefined) {
    if (!rawPrompts || typeof rawPrompts !== "object" || Array.isArray(rawPrompts)) throw new Error("操作者配置的 rolePrompts 必须是对象");
    rolePrompts = {};
    for (const [roleId, prompt] of Object.entries(rawPrompts as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9_-]{1,31}$/.test(roleId)) throw new Error(`rolePrompts 的角色 ID 无效：${roleId}`);
      rolePrompts[roleId] = validateSystemPrompt(prompt, `rolePrompts.${roleId}`);
    }
  }
  const aggregatorPrompt = value.aggregatorPrompt === undefined ? undefined : validateSystemPrompt(value.aggregatorPrompt, "aggregatorPrompt");
  return { version: 1, model: rawModel.trim(), thinkingLevel, rolePrompts, aggregatorPrompt };
}

/**
 * 读取操作者配置。文件不存在时回退到内置默认而不是报错：开箱即用仍然成立，
 * 但被审查仓库无法参与“用哪个模型、用什么提示词”这个选择。
 */
export async function loadOperatorConfig(explicitPath?: string): Promise<{ config: OperatorConfig; path: string }> {
  const path = resolve(explicitPath ?? process.env.REPO_SENTINEL_OPERATOR_CONFIG ?? defaultOperatorConfigPath()); // 显式参数优先，其次环境变量，最后默认路径。
  try {
    return { config: validateOperatorConfig(JSON.parse(await readFile(path, "utf8")) as unknown), path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: validateOperatorConfig(DEFAULT_OPERATOR_CONFIG), path };
    throw error;
  }
}

const MAX_CHANGED_FILES = 1_000; // 单次审查允许的最大变更文件数。
const MAX_DIFF_BYTES = 5_000_000; // 单次审查允许读取的最大 Diff 字节数。
const MAX_OUTPUT_BYTES = 5_000_000; // 单次检查允许保存的最大输出字节数。

/**
 * 没有配置文件时使用的安全默认值。
 * 默认检查和资源上限都在代码中定义，避免空配置导致“无限制运行”。
 */
export const DEFAULT_CONFIG: SentinelConfig = {
  version: 1,
  checks: {
    test: { command: "npm test", required: true, timeoutSeconds: 120 },
    lint: { command: "npm run lint", required: false, timeoutSeconds: 120 },
    typecheck: { command: "npm run typecheck", required: false, timeoutSeconds: 120 },
    dependency: { command: "npm audit --json", required: false, timeoutSeconds: 120 },
    build: { command: "npm run build", required: false, timeoutSeconds: 120 },
  },
  commandPolicy: {
    allowed: ["npm test", "npm run lint", "npm run typecheck", "npm audit --json", "npm run build"],
    denyPathPatterns: [".env", ".env.*", "**/*.pem", "**/*.key", ".git/**"],
    maxOutputBytes: 200_000,
  },
  review: {
    maxChangedFiles: 80,
    maxDiffBytes: 500_000,
    maxAgentTurns: 40,
    // 轮次预算同时受两个因素影响，两者都会变，所以它必须留有余量：
    // 1) diff 规模：500,000 字节按 32,000 字符分页约 16 页；
    // 2) 模型行为：实测同样 diff 下 deepseek-v4-pro 每专家用 10-21 次工具调用，
    //    deepseek-v4-flash 用 22-35 次。换模型后应重新核对这个值。
    maxAgentSeconds: 600,
    // 上限按较慢的推理模型 + 长 Prompt 标定：实测 deepseek-v4-pro 单个专家约 60-95 秒，
    // 最重的 testing 角色（10-13 次工具调用）在并发争用下会超过 180 秒。
    // 默认模型是更快也更便宜的 deepseek-v4-flash，这些值平时只是尾部保险，不构成额外开销。
    // 4 个专家默认并发：实测串行 246s → 并发 ~88s，且专家之间没有共享可变状态。
    // Provider 不支持并发流或有限流时，把这里降到 1 即可回到串行执行。
    maxParallelAgents: 4,
    maxSpecialistSeconds: 300,
    maxAggregatorSeconds: 180,
    roles: defaultRoles,
  },
};

const categories: CheckCategory[] = ["test", "lint", "typecheck", "dependency", "build"];
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
  // 只遍历系统认识的固定类别，未知字段不会自动变成可执行命令。
  const checks = (value.checks ?? {}) as Record<string, unknown>; // 用户声明的检查配置。
  const normalizedChecks: SentinelConfig["checks"] = {}; // 经过校验和归一化后的检查配置。
  for (const category of categories) {
    const raw = checks[category];
    if (raw === undefined) continue;
    if (!raw || typeof raw !== "object") throw new Error(`checks.${category} 必须是对象`);
    const item = raw as Record<string, unknown>; // 当前检查的原始配置对象。
    if (typeof item.command !== "string" || item.command.trim() === "") throw new Error(`checks.${category}.command 无效`);
    if (forbiddenCommandTokens.test(item.command)) throw new Error(`checks.${category}.command 包含不允许的 Shell 语法`);
    const timeoutSeconds = item.timeoutSeconds ?? 120; // 当前检查的超时时间。
    if (typeof timeoutSeconds !== "number" || timeoutSeconds < 1 || timeoutSeconds > 900) throw new Error(`checks.${category}.timeoutSeconds 必须在 1 到 900 之间`);
    normalizedChecks[category] = {
      command: item.command.trim(),
      required: item.required === true,
      timeoutSeconds,
      enabled: item.enabled !== false,
    };
  }
  // commandPolicy 决定 Agent 最终能触发哪些确定性检查，是权限模型的一部分。
  const policy = (value.commandPolicy ?? {}) as Record<string, unknown>; // 命令和路径安全策略。
  const allowed = Array.isArray(policy.allowed) ? policy.allowed : DEFAULT_CONFIG.commandPolicy.allowed; // 允许执行的精确命令列表。
  if (!allowed.every((item) => typeof item === "string" && !forbiddenCommandTokens.test(item))) throw new Error("commandPolicy.allowed 包含非法命令");
  for (const [category, check] of Object.entries(normalizedChecks)) {
    if (check && !allowed.includes(check.command)) throw new Error(`checks.${category}.command 不在 commandPolicy.allowed 中`);
  }
  // Review 限制同时保护模型成本、进程资源和本地仓库稳定性。
  const review = (value.review ?? {}) as Record<string, unknown>; // Review 资源限制和角色配置。
  const maxChangedFiles = typeof review.maxChangedFiles === "number" ? review.maxChangedFiles : DEFAULT_CONFIG.review.maxChangedFiles; // 最大变更文件数。
  const maxDiffBytes = typeof review.maxDiffBytes === "number" ? review.maxDiffBytes : DEFAULT_CONFIG.review.maxDiffBytes;
  const maxAgentTurns = typeof review.maxAgentTurns === "number" ? review.maxAgentTurns : DEFAULT_CONFIG.review.maxAgentTurns;
  const maxAgentSeconds = typeof review.maxAgentSeconds === "number" ? review.maxAgentSeconds : DEFAULT_CONFIG.review.maxAgentSeconds;
  const maxParallelAgents = typeof review.maxParallelAgents === "number" ? review.maxParallelAgents : DEFAULT_CONFIG.review.maxParallelAgents;
  const maxSpecialistSeconds = typeof review.maxSpecialistSeconds === "number" ? review.maxSpecialistSeconds : typeof review.maxAgentSeconds === "number" ? review.maxAgentSeconds : DEFAULT_CONFIG.review.maxSpecialistSeconds;
  const maxAggregatorSeconds = typeof review.maxAggregatorSeconds === "number" ? review.maxAggregatorSeconds : typeof review.maxAgentSeconds === "number" ? review.maxAgentSeconds : DEFAULT_CONFIG.review.maxAggregatorSeconds;
  const rawRoles = review.roles ?? DEFAULT_CONFIG.review.roles; // 用户配置或默认的专家角色列表。
  if (!Array.isArray(rawRoles) || rawRoles.length < 1 || rawRoles.length > 8) throw new Error("review.roles 必须包含 1 到 8 个角色");
  const roleIds = new Set<string>(); // 用于检测重复角色 ID。
  const roles: AgentRoleConfig[] = rawRoles.map((raw, index) => { // 归一化每个专家角色。
    if (!raw || typeof raw !== "object") throw new Error(`review.roles[${index}] 必须是对象`);
    const item = raw as Record<string, unknown>; // 当前角色的原始配置。
    const id = typeof item.id === "string" ? item.id.trim() : ""; // 角色唯一标识。
    const instructions = typeof item.instructions === "string" ? item.instructions.trim() : ""; // 角色职责说明。
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(id)) throw new Error(`review.roles[${index}].id 无效`);
    if (roleIds.has(id)) throw new Error(`review.roles 包含重复角色：${id}`);
    if (instructions.length < 1 || instructions.length > 1000) throw new Error(`review.roles[${index}].instructions 必须为 1 到 1000 字`);
    roleIds.add(id);
    return { id, instructions, enabled: item.enabled !== false };
  });
  if (!roles.some((role) => role.enabled)) throw new Error("review.roles 至少启用一个角色");
  const maxOutputBytes = typeof policy.maxOutputBytes === "number" ? policy.maxOutputBytes : DEFAULT_CONFIG.commandPolicy.maxOutputBytes; // 检查输出的字节上限。
  if (![maxChangedFiles, maxDiffBytes, maxOutputBytes, maxAgentTurns, maxAgentSeconds, maxParallelAgents, maxSpecialistSeconds, maxAggregatorSeconds].every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)) throw new Error("review 和输出限制必须为有限正数");
  if (maxChangedFiles > MAX_CHANGED_FILES) throw new Error(`变更文件数最多 ${MAX_CHANGED_FILES}`);
  if (maxDiffBytes > MAX_DIFF_BYTES) throw new Error(`Diff 字节数最多 ${MAX_DIFF_BYTES}`);
  if (maxOutputBytes > MAX_OUTPUT_BYTES) throw new Error(`输出字节数最多 ${MAX_OUTPUT_BYTES}`);
  if (maxAgentTurns > 100 || maxAgentSeconds > 3600) throw new Error("Agent 轮次最多 100，运行时间最多 3600 秒");
  if (maxParallelAgents > 8) throw new Error("并行 Agent 最多 8 个");
  if (maxSpecialistSeconds > 900 || maxAggregatorSeconds > 900) throw new Error("专家和汇总 Agent 运行时间最多 900 秒");
  return {
    version: 1,
    checks: normalizedChecks,
    commandPolicy: {
      allowed: [...allowed] as string[],
      denyPathPatterns: effectiveDenyPathPatterns(Array.isArray(policy.denyPathPatterns) ? policy.denyPathPatterns.filter((item): item is string => typeof item === "string") : []),
      maxOutputBytes,
    },
    review: { maxChangedFiles, maxDiffBytes, maxAgentTurns, maxAgentSeconds, maxParallelAgents, maxSpecialistSeconds, maxAggregatorSeconds, roles },
  };
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

/** 创建示例配置；默认不覆盖已有配置，防止误删用户设置。 */
export async function initConfig(repoRoot: string, force = false): Promise<string> {
  const path = resolve(repoRoot, ".repo-sentinel/config.json"); // 配置文件的绝对路径。
  if (!force) {
    try { await access(path); throw new Error(`配置已存在：${path}，如需覆盖请使用 --force`); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  return path;
}

export function configDirectory(repoRoot: string): string {
  return dirname(resolve(repoRoot, ".repo-sentinel/config.json"));
}
