import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { runProcess } from "./process.js";
import { effectiveDenyPathPatterns, isPathAllowed, redactSensitiveText, sanitizedEnvironment } from "./policy.js";
import type { SentinelConfig } from "./types.js";

// 文件工具面向 Agent，所有上限都是防止一次调用读取过多内容的资源边界。
const MAX_READ_BYTES = 120_000; // 单次文件读取最多读取的字节数。
const MAX_SEARCH_BYTES = 80_000; // 单次文本搜索最多保存的输出字节数。
export const MAX_READ_LINE_NUMBER = 100_000; // 允许请求的最大行号。
export const MAX_READ_LINE_SPAN = 2_000; // 单次读取允许跨越的最大行数。

/** 把绝对/相对输入统一转换成仓库内的 POSIX 风格相对路径。 */
function relativePath(repoRoot: string, candidate: string): string {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(repoRoot, candidate); // 候选路径的绝对路径。
  const rel = relative(repoRoot, absolute).split(sep).join("/"); // 相对于仓库根目录的 POSIX 路径。
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`拒绝访问路径：${candidate}`);
  return rel;
}

/**
 * 路径安全检查包含 lexical 检查和 realpath 检查两层，
 * 用来防止 ../ 逃逸以及符号链接指向仓库外部。
 */
async function safePath(repoRoot: string, candidate: string, config: SentinelConfig): Promise<{ absolute: string; relative: string }> {
  const canonicalRoot = await realpath(repoRoot); // 解析符号链接后的真实仓库根目录。
  const relativeCandidate = relativePath(canonicalRoot, candidate); // 词法校验后的仓库内相对路径。
  const denied = effectiveDenyPathPatterns(config.commandPolicy.denyPathPatterns); // 合并系统和用户的禁止路径规则。
  if (!isPathAllowed(canonicalRoot, relativeCandidate, config)) throw new Error(`拒绝访问路径：${candidate}`);
  const absolute = await realpath(resolve(canonicalRoot, relativeCandidate)); // 解析候选文件的真实路径。
  const resolvedRelative = relativePath(canonicalRoot, absolute); // 真实路径对应的仓库内相对路径。
  if (!isPathAllowed(canonicalRoot, resolvedRelative, config) || denied.some((pattern) => pattern === resolvedRelative)) throw new Error(`拒绝访问路径：${candidate}`);
  return { absolute, relative: resolvedRelative };
}

/** 读取受控范围内的普通文件，并给每一行加行号，方便 Finding 引用位置。 */
export async function readRepositoryFile(repoRoot: string, candidate: string, config: SentinelConfig, startLine = 1, endLine?: number): Promise<{ path: string; content: string; truncated: boolean }> {
  if (!Number.isInteger(startLine) || startLine < 1 || startLine > MAX_READ_LINE_NUMBER) throw new Error(`起始行号超出允许范围：${candidate}:${startLine}`);
  if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1 || endLine > MAX_READ_LINE_NUMBER)) throw new Error(`结束行号超出允许范围：${candidate}:${endLine}`);
  if (endLine !== undefined && endLine < startLine) throw new Error(`行号范围无效：${candidate}:${startLine}-${endLine}`);
  if (endLine !== undefined && endLine - startLine + 1 > MAX_READ_LINE_SPAN) throw new Error(`单次读取行数超过上限：${MAX_READ_LINE_SPAN}`);
  // 先通过策略和 realpath 校验，再打开文件；不能直接使用用户传入的路径。
  const target = await safePath(repoRoot, candidate, config); // 通过路径安全策略后的目标文件。
  const stat = await lstat(target.absolute); // 目标文件的类型信息。
  if (!stat.isFile()) throw new Error(`只能读取普通文件：${candidate}`);
  const openFlags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW; // 防止跟随符号链接的只读打开标志。
  const handle = await open(target.absolute, openFlags); // 已通过安全检查的文件句柄。
  let raw: Buffer; // 文件原始字节内容。
  let truncated = false; // 文件是否超过读取上限。
  try {
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1); // 多申请一个字节，用于判断是否超限。
    const openedStat = await handle.stat(); // 再次确认打开后的对象仍是普通文件。
    if (!openedStat.isFile()) throw new Error(`只能读取普通文件：${candidate}`);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    truncated = bytesRead > MAX_READ_BYTES;
    raw = buffer.subarray(0, Math.min(bytesRead, MAX_READ_BYTES));
  } finally {
    await handle.close();
  }
  const content = redactSensitiveText(raw.toString("utf8")); // 解码并脱敏文件内容。
  const lines = content.split(/\r?\n/); // 按换行拆分，便于返回带行号的内容。
  const from = startLine;
  if (truncated && from > lines.length) throw new Error(`请求行范围超出可读取前缀：${candidate}:${from}；文件内容已截断，请缩小范围或使用搜索工具`);
  const to = endLine === undefined ? lines.length : Math.min(lines.length, endLine);
  return { path: target.relative, content: lines.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`).join("\n"), truncated };
}

/** 使用固定参数的 rg 搜索，敏感目录和仓库产物目录会被排除。 */
export async function searchRepository(repoRoot: string, query: string, config: SentinelConfig, candidatePath?: string): Promise<{ query: string; path?: string; output: string; truncated: boolean }> {
  if (!query.trim()) throw new Error("搜索关键词不能为空");
  const target = candidatePath ? (await safePath(repoRoot, candidatePath, config)).relative : "."; // 搜索目标路径，默认是整个仓库。
  const args = ["--line-number", "--no-heading", "--color", "never", "--fixed-strings", "--hidden", "--glob", "!.git/**", "--glob", "!.repo-sentinel/**"]; // rg 的固定安全参数。
  for (const pattern of effectiveDenyPathPatterns(config.commandPolicy.denyPathPatterns)) args.push("--glob", `!${pattern}`);
  // `--` 终止选项解析：否则以 "-" 开头的查询词会被 rg 当成 flag，导致工具被用来触发任意 rg 选项。
  args.push("--", query, target);
  const result = await runProcess("rg", args, { cwd: repoRoot, timeoutMs: 30_000, maxOutputBytes: MAX_SEARCH_BYTES, env: sanitizedEnvironment() }); // 执行受控文本搜索。
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(`搜索失败：${result.stderr || result.stdout}`);
  return { query, path: candidatePath, output: redactSensitiveText(result.stdout), truncated: result.outputTruncated };
}
