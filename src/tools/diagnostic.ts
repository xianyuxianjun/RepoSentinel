import { createAgentSession, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveReviewModel, type ResolvedReviewModel } from "../model-runtime.js";

/** 诊断命令的窄结果模型，只报告 Session 是否能完成最小工具调用。 */
export interface AgentDiagnosticResult {
  ok: boolean;
  model?: string;
  activeTools: string[];
  toolCalls: number;
  messageSummaries: Array<Record<string, unknown>>;
  error?: string;
}

/** 诊断探针的可选参数。 */
export interface AgentDiagnosticOptions {
  /** 探针超时，默认 45 秒。 */
  timeoutMs?: number;
  /** 配置声明的模型引用；提供时先解析，解析失败直接作为诊断结论返回。 */
  modelReference?: string;
}

/** 诊断也只保留消息摘要，避免调试命令成为敏感信息出口。 */
function summarize(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== "object") return {};
  const value = message as Record<string, unknown>; // SDK 消息的通用对象视图。
  const content = Array.isArray(value.content) ? value.content : []; // 消息内容块列表。
  return {
    role: value.role,
    stopReason: value.stopReason,
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage.slice(0, 300).replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]") : undefined,
    contentTypes: content.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).type : "unknown"),
    textChars: content.reduce<number>((total, item) => {
      if (!item || typeof item !== "object") return total;
      const text = (item as Record<string, unknown>).text; // 当前消息块中的文本内容。
      return total + (typeof text === "string" ? text.length : 0);
    }, 0),
  };
}

/** 无副作用的探针只验证 Pi Provider、Session 和 Tool Calling 是否可用。 */
export async function runAgentDiagnostic(repositoryRoot: string, options: AgentDiagnosticOptions = {}): Promise<AgentDiagnosticResult> {
  const timeoutMs = options.timeoutMs ?? 45_000; // 探针等待模型的超时时间。
  let agentModel: ResolvedReviewModel | undefined; // 诊断显式使用的模型；未配置时为 undefined。
  if (options.modelReference) {
    try {
      agentModel = await resolveReviewModel(options.modelReference);
    } catch (error) {
      // 模型解析失败本身就是一条诊断结论，不应该抛出去变成一次普通崩溃。
      return { ok: false, model: options.modelReference, activeTools: [], toolCalls: 0, messageSummaries: [], error: error instanceof Error ? error.message : String(error) };
    }
  }
  let toolCalls = 0; // 诊断探针实际被调用的次数。
  const messageSummaries: Array<Record<string, unknown>> = []; // 只保存消息摘要，不保存正文。
  const probe = defineTool({ // 无副作用的诊断工具。
    name: "diagnostic_probe",
    label: "Diagnostic Probe",
    description: "A harmless probe. Call this exactly once during diagnostics.",
    promptSnippet: "Call the harmless diagnostic probe exactly once.",
    parameters: Type.Object({}),
    execute: async () => {
      toolCalls += 1;
      return { content: [{ type: "text", text: "probe_ok" }], details: {} };
    },
  });
  const { session } = await createAgentSession({ // 创建用于连通性诊断的 Pi Session。
    cwd: repositoryRoot,
    thinkingLevel: agentModel?.thinkingLevel,
    model: agentModel?.model,
    modelRuntime: agentModel?.modelRuntime,
    tools: ["diagnostic_probe"],
    customTools: [probe],
    sessionManager: SessionManager.inMemory(repositoryRoot),
  });
  const timeout = setTimeout(() => { void session.abort(); }, timeoutMs).unref(); // Provider 超时保护。
  try {
    session.subscribe((event) => { // 只监听消息结束事件，收集诊断摘要。
      if (event.type === "message_end") messageSummaries.push(summarize(event.message));
    });
    try {
      await session.prompt("Diagnostics only. Call diagnostic_probe exactly once, then reply with DONE. Do not explain before calling the tool.");
    } catch (error) {
      return { ok: false, model: session.model?.id, activeTools: session.getActiveToolNames(), toolCalls, messageSummaries, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: toolCalls > 0, model: session.model?.id, activeTools: session.getActiveToolNames(), toolCalls, messageSummaries, error: toolCalls > 0 ? undefined : "模型完成响应但未调用 diagnostic_probe" };
  } finally {
    clearTimeout(timeout);
    session.dispose();
  }
}
