import type { CheckResult, GitContext } from "../types.js";
import { redactSensitiveText } from "../policy.js";

/** 一页 Diff 的返回值；nextOffset 存在时说明调用方还需要继续读取。 */
export interface ContextChunk {
  offset: number;
  limit: number;
  nextOffset?: number;
  diff: string;
  truncated: boolean;
}

/** 将检查输出压缩成首屏摘要，避免把完整命令输出直接交给模型。 */
export function summarizeChecks(checks: CheckResult[]): string {
  return JSON.stringify(checks.map((check) => ({
    checkId: check.checkId,
    status: check.status,
    exitCode: check.exitCode,
    command: check.displayCommand,
    output: boundedPreview(redactSensitiveText(check.output), 1_200),
    outputTruncated: check.outputTruncated || check.output.length > 1_200,
  })));
}

/** 保留文本首尾，裁掉中间部分，控制工具返回的上下文预算。 */
export function boundedPreview(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = Math.ceil(maxChars / 2); // 保留在文本开头的字符数量。
  const tail = Math.floor(maxChars / 2); // 保留在文本结尾的字符数量。
  return `${value.slice(0, head)}\n...[RepoSentinel preview truncated]...\n${value.slice(-tail)}`;
}

/**
 * 单页 Diff 的字符上限。
 *
 * 工具 schema、默认页大小和实际裁剪都以这个常量为唯一来源；三处各写一个数字
 * 会让“schema 允许的页大小”和“实际返回的页大小”漂移。
 * 上限刻意设得很大：Agent 的轮次预算有限，实测 71KB 的 diff 按 8,000 字符分页
 * 需要 9-11 次往返，会把 12 轮预算全部吃光导致无法提交。
 */
export const MAX_CONTEXT_PAGE_CHARS = 32_000;

/** Diff 通过 offset 分页读取，保证大变更不会一次性突破上下文预算。 */
export function getContextChunk(context: GitContext, offset = 0, limit = MAX_CONTEXT_PAGE_CHARS): ContextChunk {
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0; // 防止模型传入负数或非整数偏移量。
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_CONTEXT_PAGE_CHARS) : MAX_CONTEXT_PAGE_CHARS; // 限制单页最大字符数。
  const metadataBudget = 2_000; // 为 base、head 和文件清单预留的字符预算。
  const diffBudget = safeLimit <= metadataBudget ? safeLimit : safeLimit - metadataBudget; // 实际分配给 Diff 的预算。
  const diff = context.diff.slice(safeOffset, safeOffset + diffBudget); // 当前页的 Diff 内容。
  const nextOffset = safeOffset + diff.length < context.diff.length ? safeOffset + diff.length : undefined; // 下一页起始位置；没有下一页时为 undefined。
  return { offset: safeOffset, limit: safeLimit, nextOffset, diff, truncated: Boolean(nextOffset) || context.diffTruncated };
}
