import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { runProcess } from "./process.js";
import { matchesDenyPath } from "./policy.js";
import type { ChangeStatus, GitChange, GitContext } from "./types.js";

/** Git 命令统一走参数数组和固定环境，不允许 Agent 直接拼接 Shell。 */
async function git(repo: string, args: string[], maxOutputBytes = 1_000_000): Promise<string> {
  const result = await runProcess("git", args, { // 执行固定参数的 Git 子进程。
    cwd: repo,
    timeoutMs: 30_000,
    maxOutputBytes,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C", LC_ALL: "C" },
  });
  if (result.exitCode !== 0) throw new Error(`Git 命令失败：git ${args.join(" ")}\n${result.stderr || result.stdout}`);
  return result.stdout;
}

// Git 的 --name-status 字母到领域状态的映射；未知字母归为 unknown，不猜测。
const STATUS_BY_LETTER: Readonly<Record<string, ChangeStatus>> = { A: "added", D: "deleted", M: "modified", R: "renamed", C: "copied", T: "type_changed" };

/** numstat 在重命名时输出 `old => new` 或 `pre/{old => new}/post`，取出新路径。 */
function newPathFromRename(rawPath: string): string {
  const braced = rawPath.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`;
  const arrow = rawPath.split(" => ");
  return arrow.length > 1 ? arrow[arrow.length - 1] : rawPath;
}

/** 把 git diff --name-status 解析成 path -> 变更状态。 */
function parseNameStatus(raw: string): Map<string, ChangeStatus> {
  const statuses = new Map<string, ChangeStatus>();
  for (const line of raw.split("\n").filter(Boolean)) {
    const [letter, ...pathParts] = line.split("\t");
    const path = pathParts[pathParts.length - 1]; // 重命名时取新路径。
    if (letter && path) statuses.set(path, STATUS_BY_LETTER[letter[0]] ?? "unknown");
  }
  return statuses;
}

/** 将 git diff --numstat 的文本转换为领域模型，供 Prompt 和报告使用。 */
function parseNumstat(raw: string, statuses: ReadonlyMap<string, ChangeStatus>): GitChange[] {
  return raw.split("\n").filter(Boolean).map((line) => {
    const [additions, deletions, ...pathParts] = line.split("\t");
    const path = newPathFromRename(pathParts.join("\t")); // 重命名时归一到新路径，才能与 name-status 对齐。
    return {
      path,
      // 旧实现把所有文件硬编码为 modified，导致「新增/删除」在报告里全部失真。
      status: statuses.get(path) ?? "unknown",
      additions: additions === "-" ? 0 : Number(additions),
      deletions: deletions === "-" ? 0 : Number(deletions),
    };
  });
}

/**
 * Diff 过滤发生在进入 Agent 之前。
 * 这比只在 read_file 工具中拦截更早，能覆盖首屏上下文和汇总链路。
 */
function filterSensitiveDiff(diff: string, denyPathPatterns: string[]): string {
  const sections = diff.split(/(?=^diff --git )/m); // 按文件拆分 Diff，逐段过滤。
  return sections.map((section) => {
    const header = section.match(/^diff --git a\/(.+) b\/(.+)$/m); // 当前 Diff 段的文件头。
    if (!header) return section;
    const path = header[2]; // Diff 段对应的目标文件路径。
    // 保留路径包含性防线：绝对路径或含 .. 的异常头同样按敏感处理。
    const denied = path.startsWith("/") || path.split("/").includes("..") || matchesDenyPath(path, denyPathPatterns);
    if (denied) {
      return `diff --git a/${path} b/${path}\n[RepoSentinel omitted sensitive file content]\n`;
    }
    return section;
  }).join("");
}

// ref 虽然最终作为独立参数传给 Git，仍需拒绝选项样式和控制字符输入。
function assertRef(value: string, label: string): void {
  if (!value || value.startsWith("-") || /[\u0000\n\r]/.test(value)) throw new Error(`${label} ref 无效`);
}

/**
 * 收集一次审查所需的确定性 Git 事实：base/head、工作区状态、变更清单和 Diff。
 * Agent 只消费这里产生的上下文，不自行决定审查范围。
 */
export async function collectGitContext(repoPath: string, baseRef: string | undefined, headRef: string, maxDiffBytes: number, denyPathPatterns: string[] = []): Promise<GitContext> {
  assertRef(headRef, "head");
  if (baseRef) assertRef(baseRef, "base");
  const repositoryRoot = await realpath(resolve(repoPath)); // 真实仓库根目录。
  const currentBranchRaw = await git(repositoryRoot, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""); // 当前分支名称原文。
  const base = baseRef ?? (await git(repositoryRoot, ["show-ref", "--verify", "--quiet", "refs/heads/main"]).then(() => "main").catch(async () => { // 本次比较使用的 base 引用。
    await git(repositoryRoot, ["show-ref", "--verify", "--quiet", "refs/heads/master"]);
    return "master";
  }));
  const baseSha = (await git(repositoryRoot, ["rev-parse", `${base}^{commit}`])).trim(); // base 的提交 SHA。
  const headSha = (await git(repositoryRoot, ["rev-parse", `${headRef}^{commit}`])).trim(); // head 的提交 SHA。
  const status = await git(repositoryRoot, ["status", "--porcelain=v1"]); // 工作区状态文本。
  // 多读取 1 个字节用于判断是否超限，但最终只把 maxDiffBytes 内的内容交给后续模块。
  const rawDiff = await git(repositoryRoot, ["diff", "--no-ext-diff", "--no-color", `${base}...${headRef}`], maxDiffBytes + 1); // 原始 Git Diff，多读取一个字节判断是否超限。
  const filteredDiff = filterSensitiveDiff(rawDiff, denyPathPatterns); // 进入 Agent 前先移除敏感文件内容。
  const diff = Buffer.byteLength(filteredDiff) > maxDiffBytes ? filteredDiff.slice(0, maxDiffBytes) : filteredDiff; // 应用最终 Diff 字节预算。
  // 变更状态和增删行数来自两次不同的 Git 输出，按路径合并成同一份领域模型。
  const statuses = parseNameStatus(await git(repositoryRoot, ["diff", "--name-status", `${base}...${headRef}`]));
  return {
    repositoryRoot,
    currentBranch: currentBranchRaw.trim() || undefined,
    base: { ref: base, sha: baseSha },
    head: { ref: headRef, sha: headSha },
    dirty: status.trim().length > 0,
    changes: parseNumstat(await git(repositoryRoot, ["diff", "--numstat", `${base}...${headRef}`]), statuses),
    diff,
    diffTruncated: Buffer.byteLength(rawDiff) > maxDiffBytes,
  };
}
