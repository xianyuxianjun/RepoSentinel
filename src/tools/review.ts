import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CheckResult, GitContext, ReviewResult, SentinelConfig } from "../types.js";
import { executeCheck, listChecks } from "../checks.js";
import { validateReviewResult } from "../report.js";
import { MAX_READ_LINE_NUMBER, readRepositoryFile, searchRepository } from "../files.js";
import { getContextChunk } from "./context.js";
import { reviewResultSchema } from "./schema.js";
import { TraceRecorder } from "../trace.js";

/**
 * Tool 的共享状态由 Agent Session 持有，工具只通过这个窄接口改变状态。
 * 这样工具不需要知道 specialist/aggregator 的编排细节。
 */
export interface ReviewToolState {
  submitted: unknown;
  activeSession?: { abort(): void | Promise<void> };
}

export interface ReviewToolContext {
  repositoryRoot: string;
  context: GitContext;
  config: SentinelConfig;
  trace: TraceRecorder;
  role: string;
  checkResults: CheckResult[];
  changedPaths: string[];
}

export interface SubmitReviewToolContext {
  trace: TraceRecorder;
  role: string;
  checkResults: CheckResult[];
  changedPaths: string[];
  merged: boolean;
}

/** 把 SDK 工具的共性配置集中在工具层，Agent 层只决定何时装配它们。 */
function toolBundle(...tools: ToolDefinition[]): { customTools: ToolDefinition[]; toolNames: string[] } {
  const customTools = tools; // 传给 Pi Session 的完整工具定义。
  const toolNames = tools.map((tool) => tool.name); // Session 需要启用的工具名称列表。
  return { customTools, toolNames };
}

/**
 * 创建专家可以使用的受控工具。
 * 权限、路径和检查 allowlist 都在这里落地，Prompt 只负责描述使用方式。
 */
export function createSpecialistTools(input: ReviewToolContext, state: ReviewToolState, options: { includeCheckTool?: boolean; includeContextTools?: boolean } = {}): { customTools: ToolDefinition[]; toolNames: string[] } {
  const getContext = defineTool({
    name: "get_change_context", label: "Get Change Context", description: "Read one bounded page of the Git change context for this review.",
    promptSnippet: "Read the Git diff in bounded pages; continue from nextOffset when present.",
    parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })), maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 12_000 })) }),
    execute: async (_id, params) => {
      const value = params as { offset?: number; maxChars?: number }; // Tool 参数经过 schema 后的类型视图。
      const chunk = getContextChunk(input.context, value.offset, value.maxChars); // 读取一页受限 Diff。
      await input.trace.record("context_chunk_read", { agentRole: input.role, offset: chunk.offset, chars: chunk.diff.length, nextOffset: chunk.nextOffset });
      return { content: [{ type: "text", text: JSON.stringify({ base: input.context.base, head: input.context.head, changes: chunk.offset === 0 ? input.context.changes.slice(0, 100) : [], changesTruncated: chunk.offset === 0 && input.context.changes.length > 100, ...chunk }) }], details: {} };
    },
  });
  const listChecksTool = defineTool({
    name: "list_checks", label: "List Checks", description: "List pre-approved checks that may be executed.", promptSnippet: "List the pre-approved checks available for this review.", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: JSON.stringify(listChecks(input.config)) }], details: {} }),
  });
  const readFileTool = defineTool({
    name: "read_file", label: "Read Repository File", description: "Read a bounded, non-sensitive text file inside the repository.", promptSnippet: "Read a bounded non-sensitive source file when context is needed.",
    parameters: Type.Object({ path: Type.String(), startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINE_NUMBER })), endLine: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINE_NUMBER })) }),
    execute: async (_id, params) => {
      const value = params as { path: string; startLine?: number; endLine?: number }; // 文件路径和可选行号范围。
      const result = await readRepositoryFile(input.repositoryRoot, value.path, input.config, value.startLine, value.endLine); // 执行路径安全检查后读取文件。
      await input.trace.record("file_read", { agentRole: input.role, path: result.path, truncated: result.truncated });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  });
  const searchFilesTool = defineTool({
    name: "search_files", label: "Search Repository Files", description: "Search repository text for a fixed string while excluding sensitive paths.", promptSnippet: "Search non-sensitive repository text for a fixed string.", parameters: Type.Object({ query: Type.String(), path: Type.Optional(Type.String()) }),
    execute: async (_id, params) => {
      const value = params as { query: string; path?: string }; // 搜索文本和可选目录。
      const result = await searchRepository(input.repositoryRoot, value.query, input.config, value.path); // 执行固定参数的仓库搜索。
      await input.trace.record("file_search", { agentRole: input.role, path: value.path, queryLength: value.query.length, truncated: result.truncated });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  });
  const runCheckTool = defineTool({
    name: "run_check", label: "Run Check", description: "Run one pre-approved check by checkId. Never accepts a shell command.", promptSnippet: "Run one pre-approved check by checkId to obtain evidence.", parameters: Type.Object({ checkId: Type.String() }),
    execute: async (_id, params) => {
      const checkId = params.checkId as string; // Agent 请求执行的检查标识。
      const configuredCheck = listChecks(input.config).find((item) => item.checkId === checkId); // 从 allowlist 中查找检查配置。
      if (!configuredCheck) throw new Error(`checkId 不在已启用检查列表中：${checkId}`);
      const existing = input.checkResults.find((item) => item.checkId === checkId); // 主控已经执行过的检查结果。
      const result = existing ?? await executeCheck(input.repositoryRoot, input.config, configuredCheck.checkId); // 缺失时才执行一次检查。
      if (!existing) {
        input.checkResults.push(result);
        await input.trace.record("check_result", { agentRole: input.role, ...result as unknown as Record<string, unknown> });
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  });
  const submitReview = createSubmitReviewTool({ trace: input.trace, role: input.role, checkResults: input.checkResults, changedPaths: input.changedPaths, merged: false }, state); // 创建最终结果提交工具。

  const tools: ToolDefinition[] = []; // 当前专家最终拥有的工具定义。
  if (options.includeContextTools !== false) {
    tools.push(getContext);
    if (options.includeCheckTool !== false) tools.push(listChecksTool);
    tools.push(readFileTool, searchFilesTool);
  }
  if (options.includeCheckTool !== false) tools.push(runCheckTool);
  tools.push(submitReview);
  return toolBundle(...tools);
}

/** submit_review 是 Agent 到确定性业务层的唯一交界点，所有结果必须在工具层校验。 */
export function createSubmitReviewTool(input: SubmitReviewToolContext, state: ReviewToolState): ToolDefinition {
  return defineTool({
    name: "submit_review", label: "Submit Review", description: input.merged ? "Submit the merged structured review result." : "Submit the final structured review result.",
    promptSnippet: input.merged ? "Submit the merged structured review; if validation fails, correct it and submit again." : "Submit the structured review; if validation fails, correct it and submit again.",
    parameters: Type.Object({ result: reviewResultSchema }),
    execute: async (_id, params) => {
      if (state.submitted !== undefined) throw new Error(`${input.merged ? "Merged review" : "Review"} 已经提交，不允许重复提交`); // 一个 Session 只允许提交一次。
      try {
        validateReviewResult(params.result, input.checkResults, input.changedPaths);
      } catch (error) {
        await input.trace.record("agent_submit_rejected", { agentRole: input.role, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      state.submitted = params.result; // 保存已校验的结构化结果。
      void state.activeSession?.abort(); // 提交成功后立即停止模型继续生成。
      return { content: [{ type: "text", text: input.merged ? "Merged review submitted for validation." : "Review submitted for validation." }], details: {} };
    },
  });
}
