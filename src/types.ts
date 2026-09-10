// 领域类型集中在这里，避免配置、检查、报告和 Agent 各自定义不兼容的字符串。
export type CheckCategory =
  | "test"
  | "lint"
  | "typecheck"
  | "dependency"
  | "build";

export type CheckStatus =
  | "passed"
  | "failed"
  | "timed_out"
  | "blocked"
  | "skipped"
  | "environment_error";

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type VerificationStatus = "verified" | "inferred" | "needs_human_review";
export type Recommendation = "approve" | "approve_with_notes" | "needs_changes" | "blocked" | "inconclusive";

/** 单项检查的声明；command 仍需通过 config/policy 的 allowlist。 */
export interface CheckConfig {
  command: string;
  required: boolean;
  timeoutSeconds: number;
  enabled?: boolean;
}

/** 仓库级配置模型，加载后必须是这个已归一化形状。 */
export interface SentinelConfig {
  version: 1;
  checks: Partial<Record<CheckCategory, CheckConfig>>;
  commandPolicy: {
    allowed: string[];
    denyPathPatterns: string[];
    maxOutputBytes: number;
  };
  review: {
    maxChangedFiles: number;
    maxDiffBytes: number;
    maxAgentTurns: number;
    maxAgentSeconds: number;
    maxParallelAgents: number;
    maxSpecialistSeconds: number;
    maxAggregatorSeconds: number;
    roles: AgentRoleConfig[];
  };
}

export interface AgentRoleConfig {
  id: string;
  instructions: string;
  enabled: boolean;
}

/** SDK 支持的思考档位；具体模型只支持其中一部分，由 SDK 在运行时收敛。 */
export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 操作者级配置：审查模型与每个 Agent 的前段提示词。
 *
 * 这份配置存放在**被审查仓库之外**（默认 `~/.pi/agent/repo-sentinel.json`）。
 * 原因：仓库内的 `.repo-sentinel/config.json` 随 PR 一起变更，把它作为模型来源
 * 等于让被审查对象自己决定成本与数据出向；提示词同理，不应由被审查方改写。
 */
export interface OperatorConfig {
  version: 1;
  /** 模型引用，如 "deepseek/deepseek-v4-flash"，可带 ":high" 思考档位覆盖默认值。 */
  model: string;
  /** 思考档位；未设置时用模型引用里的档位，否则用内置默认。 */
  thinkingLevel?: ThinkingLevelName;
  /** 按角色 ID 替换专家提示词的前段；强制契约尾部始终追加，不能被删除。 */
  rolePrompts?: Record<string, string>;
  /** 替换汇总 Agent 提示词的前段；去重规则与输入格式仍由代码强制。 */
  aggregatorPrompt?: string;
}

export interface GitChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

/** 一次 Review 使用的不可变 Git 事实快照。 */
export interface GitContext {
  repositoryRoot: string;
  currentBranch?: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  dirty: boolean;
  changes: GitChange[];
  diff: string;
  diffTruncated: boolean;
}

/** 检查结果既记录通过，也记录失败、超时和环境错误。 */
export interface CheckResult {
  checkId: string;
  category: CheckCategory;
  commandId: string;
  displayCommand: string;
  status: CheckStatus;
  exitCode?: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  output: string;
  outputTruncated: boolean;
  error?: string;
}

export interface Evidence {
  type: "command" | "diff" | "source";
  reference: string;
  summary: string;
}

/** Agent 发现的问题；必须能追溯到变更文件和证据。 */
export interface Finding {
  id: string;
  severity: Severity;
  category: string;
  title: string;
  summary: string;
  location: { path: string; startLine: number; endLine: number };
  evidence: Evidence[];
  confidence: number;
  suggestedFix: string;
  verificationStatus: VerificationStatus;
}

/**
 * 汇总 Agent 提交的去重方案。
 *
 * 汇总阶段只决定“保留哪些专家 Finding”并写摘要，不重新生成 Finding 正文。
 * 这样模型输出从数万 token 降到数百 token，也避免转述证据时引入偏差。
 */
export interface MergePlan {
  /** 合并后的结论摘要，上限与单一 ReviewResult.summary 一致。 */
  summary: string;
  /** 需要保留的 Finding 引用，取值来自汇总输入中的 ref 字段。 */
  keep: string[];
  limitations: string[];
  nextActions: string[];
}

/** 单个 Agent Session 的运行统计；usageAvailable 区分未知和真实零值。 */
export interface AgentTelemetry {
  usageAvailable: boolean;
  durationMs: number;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
}

export interface ReviewTelemetry {
  usageAvailable: boolean;
  specialistCount: number;
  successfulSpecialists: number;
  failedSpecialists: number;
  specialistDurationMs: number;
  aggregatorDurationMs?: number;
  totalDurationMs: number;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
}

/** 一次审查的最终领域结果，也是 JSON/Markdown/SARIF 的共同输入。 */
export interface ReviewResult {
  schemaVersion: 1;
  mergeRecommendation: Recommendation;
  summary: string;
  checks: CheckResult[];
  findings: Finding[];
  limitations: string[];
  nextActions: string[];
  telemetry?: AgentTelemetry | ReviewTelemetry;
}

/** 产物目录中的运行元数据，描述输入快照、配置和最终状态。 */
export interface RunMetadata {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  repositoryRoot: string;
  currentBranch?: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  dirty: boolean;
  configHash: string;
  agent?: { provider?: string; model?: string; thinkingLevel?: string };
  /** 本次运行实际读取的操作者配置路径；缺失时为内置默认，便于事后审计模型来源。 */
  operatorConfigPath?: string;
}

/** JSONL Trace 的最小公共字段；具体事件允许附加字段。 */
export interface TraceEvent {
  timestamp: string;
  type: string;
  runId: string;
  [key: string]: unknown;
}
