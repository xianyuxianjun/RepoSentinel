import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { runProcess } from "./process.js";
import { effectiveDenyPathPatterns, isPathAllowed } from "./policy.js";
import type { GitChange, GitContext } from "./types.js";

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

/** 将 git diff --numstat 的文本转换为领域模型，供 Prompt 和报告使用。 */
function parseNumstat(raw: string): GitChange[] {
  return raw.split("\n").filter(Boolean).map((line) => {
    const [additions, deletions, ...pathParts] = line.split("\t");
    return {
      path: pathParts.join("\t"),
      status: "modified",
      additions: additions === "-" ? 0 : Number(additions),
      deletions: deletions === "-" ? 0 : Number(deletions),
    };
  });
}

/**
 * Diff 过滤发生在进入 Agent 之前。
 * 这比只在 read_file 工具中拦截更早，能覆盖首屏上下文和汇总链路。
 */
function filterSensitiveDiff(diff: string, repositoryRoot: string, denyPathPatterns: string[]): string {
  const effectivePatterns = effectiveDenyPathPatterns(denyPathPatterns); // 当前生效的敏感路径规则。
  const sections = diff.split(/(?=^diff --git )/m); // 按文件拆分 Diff，逐段过滤。
  return sections.map((section) => {
    const header = section.match(/^diff --git a\/(.+) b\/(.+)$/m); // 当前 Diff 段的文件头。
    if (!header) return section;
    const path = header[2]; // Diff 段对应的目标文件路径。
    if (!isPathAllowed(repositoryRoot, path, { commandPolicy: { denyPathPatterns: effectivePatterns } })) {
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
  const filteredDiff = filterSensitiveDiff(rawDiff, repositoryRoot, denyPathPatterns); // 进入 Agent 前先移除敏感文件内容。
  const diff = Buffer.byteLength(filteredDiff) > maxDiffBytes ? filteredDiff.slice(0, maxDiffBytes) : filteredDiff; // 应用最终 Diff 字节预算。
  return {
    repositoryRoot,
    currentBranch: currentBranchRaw.trim() || undefined,
    base: { ref: base, sha: baseSha },
    head: { ref: headRef, sha: headSha },
    dirty: status.trim().length > 0,
    changes: parseNumstat(await git(repositoryRoot, ["diff", "--numstat", `${base}...${headRef}`])),
    diff,
    diffTruncated: Buffer.byteLength(rawDiff) > maxDiffBytes,
  };
}
