import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { collectGitContext } from "../dist/git.js";
import { runReview } from "../dist/review.js";

const exec = promisify(execFile);
async function git(cwd, ...args) { await exec("git", ["-C", cwd, ...args]); }

test("collects a real branch diff and writes a dry-run report", async () => {
  const repo = await mkdtemp(join(tmpdir(), "repo-sentinel-"));
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "RepoSentinel Test");
  await (await import("node:fs/promises")).writeFile(join(repo, "index.ts"), "export const value = 1;\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "base");
  await git(repo, "checkout", "-qb", "feature");
  await (await import("node:fs/promises")).writeFile(join(repo, "index.ts"), "export const value = 2;\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "change");

  const context = await collectGitContext(repo, "main", "HEAD", 10000);
  assert.equal(context.changes.length, 1);
  assert.equal(context.changes[0].path, "index.ts");
  assert.equal(context.changes[0].status, "modified"); // 状态来自 --name-status，不再是硬编码。
  assert.match(context.diff, /value = 2/);

  const run = await runReview({ repo, base: "main", head: "HEAD", allowDirty: false, dryRun: true });
  assert.equal(run.result.mergeRecommendation, "inconclusive");
  assert.match(await readFile(join(run.outputDir, "report.md"), "utf8"), /Dry run/);
  for (const file of ["run.json", "report.md", "trace.jsonl", "checks.json"]) assert.ok(await readFile(join(run.outputDir, file)));
});

test("reports real add/delete/modify statuses instead of a single hardcoded status", async () => {
  const repo = await mkdtemp(join(tmpdir(), "repo-sentinel-status-"));
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "RepoSentinel Test");
  await (await import("node:fs/promises")).writeFile(join(repo, "keep.ts"), "export const keep = 1;\n");
  await (await import("node:fs/promises")).writeFile(join(repo, "gone.ts"), "export const gone = 1;\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "base");
  await git(repo, "checkout", "-qb", "feature");
  const fs = await import("node:fs/promises");
  await fs.writeFile(join(repo, "keep.ts"), "export const keep = 2;\n");
  await fs.writeFile(join(repo, "added.ts"), "export const added = 1;\n");
  await fs.rm(join(repo, "gone.ts"));
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "mixed change");

  const context = await collectGitContext(repo, "main", "HEAD", 10000);
  const byPath = Object.fromEntries(context.changes.map((change) => [change.path, change.status]));
  assert.deepEqual(byPath, { "keep.ts": "modified", "added.ts": "added", "gone.ts": "deleted" });
});

test("omits sensitive file content from agent diff context", async () => {
  const repo = await mkdtemp(join(tmpdir(), "repo-sentinel-secret-"));
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "RepoSentinel Test");
  await (await import("node:fs/promises")).writeFile(join(repo, "app.ts"), "export const ok = true;\n");
  await (await import("node:fs/promises")).writeFile(join(repo, ".env"), "API_KEY=super-secret\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "base");
  await git(repo, "checkout", "-qb", "feature");
  await (await import("node:fs/promises")).writeFile(join(repo, ".env"), "API_KEY=changed-secret\n");
  await git(repo, "add", ".env");
  await git(repo, "commit", "-qm", "secret change");
  const context = await collectGitContext(repo, "main", "HEAD", 10000, []);
  assert.doesNotMatch(context.diff, /changed-secret/);
  assert.match(context.diff, /omitted sensitive file content/);
});
