// 这里只引入 createAgentSession 的类型签名，不在这个契约模块里真正创建 Session。
// 这样 contracts.ts 不依赖具体运行流程，测试可以注入 Fake Session。
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { CheckResult, GitContext, ReviewResult, SentinelConfig } from "../types.js";
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
