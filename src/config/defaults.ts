import { APPROVED_COMMAND_NAMES } from "../commands.js";
import { BASELINE_DENY_PATH_PATTERNS } from "../policy.js";
import type { AgentRoleConfig, OperatorConfig, SentinelConfig } from "../types.js";

/**
 * 内置专家角色：按关注点分工，而不是让一个 Agent 同时承担所有审查任务。
 * 角色配置化后用户可以增删职责，但仍受数量、ID 格式和「至少启用一个」的约束。
 */
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

/** 缺少操作者配置时的默认值：内置模型、无提示词覆盖。 */
export const DEFAULT_OPERATOR_CONFIG: OperatorConfig = { version: 1, model: DEFAULT_MODEL_REFERENCE };

/**
 * 没有配置文件时使用的安全默认值。
 * 默认检查和资源上限都在代码中定义，避免空配置导致「无限制运行」。
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
    // 允许列表与「本版本真正能执行的命令目录」保持同源，避免配置通过但执行时报不支持。
    allowed: [...APPROVED_COMMAND_NAMES],
    // 基线由 policy 模块持有；仓库配置只能追加，不能删除。
    denyPathPatterns: [...BASELINE_DENY_PATH_PATTERNS],
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

/** 配置中允许出现的检查类别；未知字段不会自动变成可执行命令。 */
export const CHECK_CATEGORIES = ["test", "lint", "typecheck", "dependency", "build"] as const;
