import type { AgentSessionLike } from "./contracts.js";
import { emptyTelemetry, recordUsage } from "./telemetry.js";
import type { AgentTelemetry } from "../types.js";
import { redactSensitiveText } from "../policy.js";
import { TraceRecorder } from "../trace.js";

/**
 * 只提取消息的可审计摘要，不把完整模型消息写入 Trace。
 * 这样既能排查生命周期问题，也能减少代码内容和敏感信息泄露。
 */
function summarizeAgentMessage(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== "object") return {};
  const value = message as Record<string, unknown>; // SDK 消息的通用对象视图。
  const content = Array.isArray(value.content) ? value.content : []; // 消息内容块列表。
  const textChars = content.reduce<number>((total, item) => { // 统计文本字符数，不保存完整正文。
    if (!item || typeof item !== "object") return total;
    const text = (item as Record<string, unknown>).text;
    return total + (typeof text === "string" ? text.length : 0);
  }, 0);
  return {
    role: typeof value.role === "string" ? value.role : undefined,
    stopReason: typeof value.stopReason === "string" ? value.stopReason : undefined,
    errorMessage: typeof value.errorMessage === "string" ? redactSensitiveText(value.errorMessage).slice(0, 300) : undefined,
    contentTypes: content.map((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).type === "string" ? (item as Record<string, unknown>).type : "unknown"),
    textChars,
    usage: value.usage,
  };
}

/** Session 生命周期控制参数；专家和汇总 Agent 共用这一套规则。 */
export interface SessionRunOptions {
  session: AgentSessionLike;
  trace: TraceRecorder;
  role: string;
  maxTurns: number;
  maxSeconds: number;
  /** 期望 Agent 调用的提交工具名，仅用于未提交时的错误描述。 */
  submitToolName?: string;
}

export interface SessionRunResult {
  telemetry: AgentTelemetry;
  submitted: unknown;
}

/** 统一处理专家和汇总 Session 的超时、轮次限制以及 Trace 事件。 */
export async function runSession(options: SessionRunOptions, prompt: string, getSubmitted: () => unknown): Promise<SessionRunResult> {
  // 从 Session 执行前开始计时，telemetry 才能覆盖完整生命周期。
  const startedAt = Date.now(); // Session 开始时间，用于计算完整耗时。
  const telemetry = emptyTelemetry(); // 当前 Session 的 token、工具调用和耗时统计。
  let turnCount = 0; // 已发生的 Agent 轮次数量。
  let limitReached = false; // 是否因为超时或轮次上限而中止。
  // 定时器负责兜底；正常提交时由 submit_review 主动 abort，超时则由这里 abort。
  const timeout = setTimeout(() => { // 超时保护定时器，防止 Provider 永久不返回。
    limitReached = true;
    void options.trace.record("agent_limit", { agentRole: options.role, reason: "timeout", maxSeconds: options.maxSeconds });
    void options.session.abort();
  }, options.maxSeconds * 1000).unref();

  let unsubscribe: (() => void) | undefined; // 事件监听取消函数，结束时必须释放。
  try {
    await options.trace.record("agent_session_ready", { agentRole: options.role, model: options.session.model?.id, activeTools: options.session.getActiveToolNames() });
    // 事件订阅是 telemetry 和 Trace 的统一入口，避免专家/汇总代码重复处理事件。
    unsubscribe = options.session.subscribe((event) => {
      if (event.type === "turn_start") {
        turnCount += 1;
        telemetry.turns = turnCount;
        if (turnCount > options.maxTurns && !limitReached) {
          limitReached = true;
          void options.trace.record("agent_limit", { agentRole: options.role, reason: "turns", maxTurns: options.maxTurns });
          void options.session.abort();
        }
        void options.trace.record(event.type, { agentRole: options.role, turn: turnCount });
      } else if (event.type === "tool_execution_start") {
        telemetry.toolCalls += 1;
        void options.trace.record(event.type, { agentRole: options.role, toolName: event.toolName, toolCallId: event.toolCallId });
      } else if (event.type === "message_end") {
        recordUsage(telemetry, event.message);
        void options.trace.record(event.type, { agentRole: options.role, ...summarizeAgentMessage(event.message) });
      } else {
        void options.trace.record(event.type, { agentRole: options.role });
      }
    });
    await options.trace.record("agent_start", { agentRole: options.role });
    try {
      // prompt 可能因为 Agent 主动 abort 而抛错；如果已经提交结果，这个错误可以安全忽略。
      await options.session.prompt(prompt);
    } catch (error) {
      if (getSubmitted() === undefined) throw (limitReached ? new Error(`Agent ${options.role} 超过限制：${turnCount} 轮或 ${options.maxSeconds} 秒`) : error);
    }
    if (getSubmitted() === undefined) throw new Error(`${options.role === "aggregator" ? "汇总 Agent" : `Agent ${options.role}`} 未调用 ${options.submitToolName ?? "submit_review"}`);
    telemetry.durationMs = Date.now() - startedAt;
    return { telemetry, submitted: getSubmitted() };
  } finally {
    // 无论成功、失败还是超时，都必须清理定时器、监听器和 Session。
    clearTimeout(timeout);
    unsubscribe?.();
    options.session.dispose();
  }
}
