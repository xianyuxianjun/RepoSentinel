import { createAgentSession, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveReviewModel, type ResolvedReviewModel } from "../model-runtime.js";
import { redactSensitiveText } from "../policy.js";
import type { ThinkingLevelName } from "../types.js";

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
  /** 探针超时，默认 45 秒；同时覆盖模型解析阶段。 */
  timeoutMs?: number;
  /** 操作者配置声明的模型引用；提供时先解析，解析失败直接作为诊断结论返回。 */
  modelReference?: string;
  /** 操作者配置声明的思考档位。 */
  thinkingLevel?: ThinkingLevelName;
}

/** 兼容早期的 runAgentDiagnostic(repo, timeoutMs) 调用形式，避免破坏公共 API。 */
function normalizeOptions(options: AgentDiagnosticOptions | number): AgentDiagnosticOptions {
  return typeof options === "number" ? { timeoutMs: options } : options;
}

/** 给不返回 Promise 边界的等待加一个上限（凭据/目录刷新可能卡住）。 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined; // 超时定时器句柄。
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 诊断也只保留消息摘要，避免调试命令成为敏感信息出口。 */
function summarize(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== "object") return {};
  const value = message as Record<string, unknown>; // SDK 消息的通用对象视图。
  const content = Array.isArray(value.content) ? value.content : []; // 消息内容块列表。
  return {
    role: value.role,
    stopReason: value.stopReason,
    errorMessage: typeof value.errorMessage === "string" ? redactSensitiveText(value.errorMessage).slice(0, 300) : undefined,
    contentTypes: content.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).type : "unknown"),
    textChars: content.reduce<number>((total, item) => {
      if (!item || typeof item !== "object") return total;
      const text = (item as Record<string, unknown>).text; // 当前消息块中的文本内容。
      return total + (typeof text === "string" ? text.length : 0);
    }, 0),
  };
}

/** 无副作用的探针只验证 Pi Provider、Session 和 Tool Calling 是否可用。 */
export async function runAgentDiagnostic(repositoryRoot: string, options: AgentDiagnosticOptions | number = {}): Promise<AgentDiagnosticResult> {
  const settings = normalizeOptions(options); // 归一化后的探针参数。
  const timeoutMs = settings.timeoutMs ?? 45_000; // 探针等待模型的超时时间。
  let agentModel: ResolvedReviewModel | undefined; // 诊断显式使用的模型；未配置时为 undefined。
  if (settings.modelReference) {
    try {
      // 解析阶段也会做凭据/目录刷新，必须同样受超时约束，否则 diagnose 会在这里无限等待。
      agentModel = await withTimeout(resolveReviewModel(settings.modelReference, { thinkingLevel: settings.thinkingLevel }), timeoutMs, `模型解析超过 ${timeoutMs} ms`);
    } catch (error) {
      // 模型解析失败本身就是一条诊断结论，不应该抛出去变成一次普通崩溃。
      return { ok: false, model: settings.modelReference, activeTools: [], toolCalls: 0, messageSummaries: [], error: error instanceof Error ? error.message : String(error) };
    }
  }
  // model 字段在所有分支上统一为 provider/modelId，避免调用方拿到两种语义。
  const resolvedModelName = (session: { model?: { id?: string } }): string | undefined => agentModel?.reference ?? session.model?.id;
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
      return { ok: false, model: resolvedModelName(session), activeTools: session.getActiveToolNames(), toolCalls, messageSummaries, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: toolCalls > 0, model: resolvedModelName(session), activeTools: session.getActiveToolNames(), toolCalls, messageSummaries, error: toolCalls > 0 ? undefined : "模型完成响应但未调用 diagnostic_probe" };
  } finally {
    clearTimeout(timeout);
    session.dispose();
  }
}
