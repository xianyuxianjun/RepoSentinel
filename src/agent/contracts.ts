// 这里只引入 createAgentSession 的类型签名，不在这个契约模块里真正创建 Session。
// 这样 contracts.ts 不依赖具体运行流程，测试可以注入 Fake Session。
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { CheckResult, GitContext, OperatorConfig, ReviewResult, SentinelConfig } from "../types.js";
import type { ResolvedReviewModel } from "../model-runtime.js";
import { TraceRecorder } from "../trace.js";

/** Agent 编排层的输入契约；业务代码通过这些接口与 Pi SDK 解耦。 */
/**
 * 单个 Agent 运行所需的全部上下文。
 *
 * 学习提示：这是“依赖注入”的入口。Agent 不自己读取配置、创建 Trace 或寻找仓库，
 * 而是由上层把依赖准备好后传进来，因此单元测试可以替换真实 SDK。
 */
export interface AgentRunInput {
  repositoryRoot: string;
  context: GitContext;
  config: SentinelConfig;
  trace: TraceRecorder;
  initialChecks?: CheckResult[];
  maxTurns?: number;
  maxSeconds?: number;
  role?: string;
  instructions?: string;
  includeCheckTool?: boolean;
  includeContextTools?: boolean;
  /**
   * 本次运行显式选定的模型。
   * 未提供时 createAgentSession 会回退到 Pi 默认设置，测试注入的 Fake Session 也走这条路径。
   */
  agentModel?: ResolvedReviewModel;
  /**
   * 操作者级配置（模型与提示词）。
   * 刻意不来自被审查仓库的配置文件，避免 PR 自己改写审查用的模型和提示词。
   */
  operator?: OperatorConfig;
  /** 当前 Agent 的前段提示词覆盖；强制契约尾部由 prompts 模块始终追加。 */
  systemPrompt?: string;
  createAgentSession?: AgentSessionFactory;
}

/** 多专家编排在单 Agent 输入之上增加并发数和阶段级超时。 */
export interface MultiAgentRunInput extends AgentRunInput {
  maxParallelAgents?: number;
  specialistSeconds?: number;
  aggregatorSeconds?: number;
}

/** 一个专家角色和它提交的结构化结果，供汇总 Agent 使用。 */
export interface SpecialistResult {
  role: string;
  result: ReviewResult;
}

/** 专家未完成结构化审查时的显式失败分支；与成功分支构成可判别联合。 */
export interface SpecialistFailure {
  role: string;
  error: unknown;
}

/**
 * 单个专家角色的执行结果。
 * 旧实现只在成功分支里声明 result，失败分支靠 `"result" in outcome` 就地猜测；
 * 显式联合让「专家失败」在类型层面不可忽略。
 */
export type SpecialistOutcome = SpecialistResult | SpecialistFailure;

/** 生产 Session 和测试 Fake Session 共享的最小能力集合。 */
export interface AgentSessionLike {
  model?: { id?: string };
  getActiveToolNames(): string[];
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(message: string): Promise<void>;
  abort(): void | Promise<void>;
  dispose(): void;
}

// 使用 SDK 函数的参数类型，避免我们手工复制 SDK 配置并在 SDK 升级后失同步。
export type AgentSessionFactory = (options: Parameters<typeof createAgentSession>[0]) => Promise<{ session: AgentSessionLike }>;
