import type { AgentTelemetry, ReviewTelemetry } from "../types.js";

// Provider 返回的 usage 形状可能不同，因此先把未知值归一化为安全数字。
// 注意：usage 缺失不能等价于真实的 0 成本，usageAvailable 会保留这个区别。
function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 从 SDK 消息中提取可比较的 token/cost 字段。 */
function summarizeUsage(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>; // Provider 返回的 usage 对象。
  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : undefined; // 可选的成本明细。
  return {
    inputTokens: numberValue(usage.input),
    outputTokens: numberValue(usage.output),
    cacheReadTokens: numberValue(usage.cacheRead),
    cacheWriteTokens: numberValue(usage.cacheWrite),
    totalTokens: numberValue(usage.totalTokens),
    totalCost: numberValue(cost?.total),
  };
}

export function emptyTelemetry(): AgentTelemetry {
  return { usageAvailable: false, durationMs: 0, turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 };
}

export function recordUsage(telemetry: AgentTelemetry, message: unknown): void {
  const value = message && typeof message === "object" ? message as Record<string, unknown> : undefined; // SDK 消息对象。
  const usage = summarizeUsage(value?.usage); // 从消息中提取可用的 token 和成本数据。
  if (!usage) return;
  telemetry.usageAvailable = true;
  telemetry.inputTokens += usage.inputTokens;
  telemetry.outputTokens += usage.outputTokens;
  telemetry.cacheReadTokens += usage.cacheReadTokens;
  telemetry.cacheWriteTokens += usage.cacheWriteTokens;
  telemetry.totalCost += usage.totalCost;
}

/** 把多个 Session 的指标相加，供一次 Review 的总 telemetry 使用。 */
export function combineTelemetry(items: AgentTelemetry[]): AgentTelemetry {
  return items.reduce((total, item) => { // 将多个 Session 的统计累加到 total。
    total.durationMs += item.durationMs;
    total.usageAvailable ||= item.usageAvailable;
    total.turns += item.turns;
    total.toolCalls += item.toolCalls;
    total.inputTokens += item.inputTokens;
    total.outputTokens += item.outputTokens;
    total.cacheReadTokens += item.cacheReadTokens;
    total.cacheWriteTokens += item.cacheWriteTokens;
    total.totalCost += item.totalCost;
    return total;
  }, emptyTelemetry());
}

// 两种 telemetry 通过 specialistCount 区分；这里的类型守卫让编排器不用重复断言。 
export function asAgentTelemetry(value: AgentTelemetry | ReviewTelemetry | undefined): AgentTelemetry | undefined {
  return value && !("specialistCount" in value) ? value : undefined;
}

export function asReviewTelemetry(value: AgentTelemetry | ReviewTelemetry | undefined): ReviewTelemetry | undefined {
  return value && "specialistCount" in value ? value : undefined;
}
