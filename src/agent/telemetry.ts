import type { AgentTelemetry, AnyTelemetry, ReviewTelemetry } from "../types.js";
import { isReviewTelemetry } from "../types.js";

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

/** 运行级 telemetry 的零值；聚合失败时用它保留「未完成」而不是伪造质量指标。 */
export function emptyReviewTelemetry(totalDurationMs = 0): ReviewTelemetry {
  return { usageAvailable: false, specialistCount: 0, successfulSpecialists: 0, failedSpecialists: 0, specialistDurationMs: 0, totalDurationMs, turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 };
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

// 两种 telemetry 通过共享判别函数区分；这里只做安全的向下转型，不重复实现判别逻辑。
export function asAgentTelemetry(value: AnyTelemetry | undefined): AgentTelemetry | undefined {
  return value !== undefined && !isReviewTelemetry(value) ? value : undefined;
}

export function asReviewTelemetry(value: AnyTelemetry | undefined): ReviewTelemetry | undefined {
  return isReviewTelemetry(value) ? value : undefined;
}
