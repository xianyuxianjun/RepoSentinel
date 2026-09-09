import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, validateConfig } from "../dist/config.js";
import { assertSafeCommand, isPathAllowed } from "../dist/policy.js";
import { computeRecommendation, renderMarkdown, validateReviewResult } from "../dist/report.js";
import { renderSarif } from "../dist/sarif.js";
import { runProcess } from "../dist/process.js";
import { MAX_READ_LINE_NUMBER, MAX_READ_LINE_SPAN, readRepositoryFile, searchRepository } from "../dist/files.js";
import { writeRun } from "../dist/report.js";
import { executeCheck } from "../dist/checks.js";
import { getContextChunk, runMultiAgentReview } from "../dist/agent.js";
import { executeChecksOnce } from "../dist/review.js";
import { compareEvalSummaries, runEvaluation } from "../dist/eval.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("rejects shell control syntax in configured checks", () => {
  assert.throws(() => validateConfig({ version: 1, checks: { test: { command: "npm test && curl evil", required: true } } }), /Shell/);
});

test("keeps paths inside repository and denies secrets", () => {
  assert.equal(isPathAllowed("/repo", "src/index.ts", DEFAULT_CONFIG), true);
  assert.equal(isPathAllowed("/repo", ".env", DEFAULT_CONFIG), false);
  assert.equal(isPathAllowed("/repo", ".env.local", DEFAULT_CONFIG), false);
  assert.equal(isPathAllowed("/repo", "certs/server.pem", DEFAULT_CONFIG), false);
  assert.equal(isPathAllowed("/repo", "../outside.txt", DEFAULT_CONFIG), false);
  assert.equal(isPathAllowed("/repo", ".env", { commandPolicy: { denyPathPatterns: [] } }), false);
  assert.equal(isPathAllowed("/repo", ".git/config", { commandPolicy: { denyPathPatterns: [] } }), false);
  assert.equal(isPathAllowed("/repo", "config/.env.production", { commandPolicy: { denyPathPatterns: [] } }), false);
});

test("allows only exact pre-approved commands", () => {
  assert.doesNotThrow(() => assertSafeCommand("npm test", DEFAULT_CONFIG.commandPolicy.allowed));
  assert.throws(() => assertSafeCommand("npm test; echo unsafe", DEFAULT_CONFIG.commandPolicy.allowed));
  assert.throws(() => assertSafeCommand("npm run unknown", DEFAULT_CONFIG.commandPolicy.allowed));
});

test("rejects invalid evidence types and unknown check references", () => {
  assert.throws(() => validateReviewResult({ summary: "bad", findings: [{ severity: "high", title: "x", summary: "x", location: { path: "src/x.ts", startLine: 1, endLine: 1 }, evidence: [{ type: "arbitrary", reference: "test", summary: "x" }], confidence: 1 }], limitations: [], nextActions: [] }, []), /evidence/);
  assert.throws(() => validateReviewResult({ summary: "bad", findings: [{ severity: "low", title: "x", summary: "x", location: { path: "src/x.ts", startLine: 1, endLine: 1 }, evidence: [null], confidence: 0.5 }], limitations: [], nextActions: [] }, []), /evidence/);
  assert.throws(() => validateReviewResult({ summary: "bad", findings: [{ severity: "low", title: "x", summary: "x", location: { path: "src/x.ts", startLine: 1, endLine: 1 }, evidence: ["not evidence"], confidence: 0.5 }], limitations: [], nextActions: [] }, []), /evidence/);
});

test("computes inconclusive on required check environment failure", () => {
  const result = computeRecommendation({ schemaVersion: 1, summary: "", checks: [{ checkId: "test", category: "test", commandId: "test", displayCommand: "npm test", status: "environment_error", startedAt: "", finishedAt: "", durationMs: 0, output: "", outputTruncated: false }], findings: [], limitations: [], nextActions: [] }, DEFAULT_CONFIG);
  assert.equal(result, "inconclusive");
});

test("rejects checks that are not in the command allowlist", () => {
  assert.throws(() => validateConfig({ version: 1, checks: { test: { command: "npm test", required: true } }, commandPolicy: { allowed: [] } }), /不在 commandPolicy.allowed/);
});

test("does not make optional check failures inconclusive", () => {
  const result = computeRecommendation({ schemaVersion: 1, summary: "", checks: [
    { checkId: "test", category: "test", commandId: "test", displayCommand: "npm test", status: "passed", startedAt: "", finishedAt: "", durationMs: 0, output: "", outputTruncated: false },
    { checkId: "lint", category: "lint", commandId: "lint", displayCommand: "npm run lint", status: "environment_error", startedAt: "", finishedAt: "", durationMs: 0, output: "", outputTruncated: false },
  ], findings: [], limitations: [], nextActions: [] }, DEFAULT_CONFIG);
  assert.equal(result, "approve");
});

test("requires every enabled required check to have a result", () => {
  const result = computeRecommendation({ schemaVersion: 1, summary: "", checks: [], findings: [], limitations: [], nextActions: [] }, DEFAULT_CONFIG);
  assert.equal(result, "inconclusive");
});

test("validates bounded multi-agent review settings", () => {
  assert.equal(DEFAULT_CONFIG.review.maxParallelAgents, 1);
  assert.equal(DEFAULT_CONFIG.review.maxSpecialistSeconds, 90);
  assert.equal(DEFAULT_CONFIG.review.maxAggregatorSeconds, 90);
  const config = validateConfig({ version: 1, review: { maxParallelAgents: 2, maxSpecialistSeconds: 30, maxAggregatorSeconds: 45 } });
  assert.equal(config.review.maxParallelAgents, 2);
  assert.equal(config.review.maxSpecialistSeconds, 30);
  assert.equal(config.review.maxAggregatorSeconds, 45);
  assert.throws(() => validateConfig({ version: 1, review: { maxParallelAgents: 9 } }), /并行 Agent/);
  assert.throws(() => validateConfig({ version: 1, review: { maxDiffBytes: 5_000_001 } }), /Diff 字节数/);
  assert.throws(() => validateConfig({ version: 1, commandPolicy: { maxOutputBytes: 5_000_001 } }), /输出字节数/);
  assert.throws(() => validateConfig({ version: 1, review: { maxDiffBytes: Infinity } }), /有限正数/);
});

test("validates configurable specialist roles", () => {
  const config = validateConfig({ version: 1, review: { roles: [
    { id: "logic", instructions: "检查业务逻辑", enabled: true },
    { id: "perf_v2", instructions: "检查性能", enabled: false },
  ] } });
  assert.deepEqual(config.review.roles, [
    { id: "logic", instructions: "检查业务逻辑", enabled: true },
    { id: "perf_v2", instructions: "检查性能", enabled: false },
  ]);
  assert.throws(() => validateConfig({ version: 1, review: { roles: [
    { id: "logic", instructions: "a" }, { id: "logic", instructions: "b" },
  ] } }), /重复角色/);
  assert.throws(() => validateConfig({ version: 1, review: { roles: [
    { id: "bad role", instructions: "a" },
  ] } }), /id 无效/);
  assert.throws(() => validateConfig({ version: 1, review: { roles: [
    { id: "logic", instructions: "a", enabled: false },
  ] } }), /至少启用/);
});

test("keeps documented phase limits and roles in the normalized config", () => {
  const config = validateConfig({ version: 1, review: {
    maxAgentSeconds: 300,
    maxSpecialistSeconds: 45,
    maxAggregatorSeconds: 60,
    maxParallelAgents: 2,
    roles: [{ id: "logic", instructions: "检查逻辑", enabled: true }],
  } });
  assert.equal(config.review.maxSpecialistSeconds, 45);
  assert.equal(config.review.maxAggregatorSeconds, 60);
  assert.equal(config.review.maxParallelAgents, 2);
  assert.equal(config.review.roles[0].id, "logic");
});

test("uses the global agent timeout as a phase fallback", () => {
  const config = validateConfig({ version: 1, review: { maxAgentSeconds: 42 } });
  assert.equal(config.review.maxSpecialistSeconds, 42);
  assert.equal(config.review.maxAggregatorSeconds, 42);
  const explicit = validateConfig({ version: 1, review: { maxAgentSeconds: 42, maxSpecialistSeconds: 17 } });
  assert.equal(explicit.review.maxSpecialistSeconds, 17);
  assert.equal(explicit.review.maxAggregatorSeconds, 42);
});

test("keeps recommendation inconclusive when orchestration is incomplete", () => {
  const result = computeRecommendation({ schemaVersion: 1, summary: "", checks: [
    { checkId: "test", category: "test", commandId: "test", displayCommand: "npm test", status: "passed", startedAt: "", finishedAt: "", durationMs: 0, output: "", outputTruncated: false },
  ], findings: [], limitations: ["agent_orchestration: aggregator unavailable"], nextActions: [] }, DEFAULT_CONFIG);
  assert.equal(result, "inconclusive");
});

test("does not approve when a specialist is missing", () => {
  const result = computeRecommendation({ schemaVersion: 1, summary: "", checks: [
    { checkId: "test", category: "test", commandId: "test", displayCommand: "npm test", status: "passed", startedAt: "", finishedAt: "", durationMs: 0, output: "", outputTruncated: false },
  ], findings: [], limitations: ["专家 Agent security 未完成结构化审查。"], nextActions: [] }, DEFAULT_CONFIG);
  assert.equal(result, "approve_with_notes");
});

test("caps process output by bytes for unicode text", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('中文中文')"], { cwd: process.cwd(), timeoutMs: 5000, maxOutputBytes: 5, env: process.env });
  assert.ok(Buffer.byteLength(result.stdout) <= 5);
  assert.equal(result.outputTruncated, true);
});

test("reads and searches repository files without exposing denied paths", async () => {
  const repo = await mkdtemp(join(tmpdir(), "repo-sentinel-files-"));
  await writeFile(join(repo, "source.ts"), "const needle = 1;\nconst other = 2;\nconst TOKEN = secret-value;\n");
  await writeFile(join(repo, ".env"), "needle=secret\n");
  const config = { ...DEFAULT_CONFIG, commandPolicy: { ...DEFAULT_CONFIG.commandPolicy, denyPathPatterns: [".env"] } };
  const file = await readRepositoryFile(repo, "source.ts", config);
  assert.match(file.content, /1: const needle/);
  assert.doesNotMatch(file.content, /secret-value/);
  const results = await searchRepository(repo, "needle", config);
  assert.match(results.output, /source.ts/);
  assert.doesNotMatch(results.output, /\.env/);
  const secretSearch = await searchRepository(repo, "secret-value", config);
  assert.doesNotMatch(secretSearch.output, /secret-value/);
});

test("classifies unavailable npm scripts as environment errors", async () => {
  const result = await executeCheck(process.cwd(), DEFAULT_CONFIG, "lint");
  assert.equal(result.status, "environment_error");
  assert.match(result.error, /缺少 npm script/);
});

test("executes each configured check once even when a runner fails", async () => {
  const calls = [];
  const results = await executeChecksOnce("/repo", DEFAULT_CONFIG, ["test", "lint"], async (_repo, _config, checkId) => {
    calls.push(checkId);
    if (checkId === "lint") throw new Error("runner failed");
    return { checkId, category: checkId, commandId: checkId, displayCommand: "npm test", status: "passed", startedAt: "", finishedAt: "", durationMs: 1, output: "", outputTruncated: false };
  });
  assert.deepEqual(calls.sort(), ["lint", "test"]);
  assert.equal(results.find((item) => item.checkId === "lint").status, "environment_error");
  assert.equal(results.find((item) => item.checkId === "test").status, "passed");
});

test("runs specialist and aggregator orchestration through an injectable session factory", async () => {
  let sessionCount = 0;
  const createAgentSession = async (options) => {
    sessionCount += 1;
    const submit = options.customTools.find((tool) => tool.name === "submit_review");
    let listener;
    return {
      session: {
        model: { id: "fake-agent" },
        getActiveToolNames: () => options.tools,
        subscribe: (next) => { listener = next; return () => {}; },
        abort: () => {},
        dispose: () => {},
        prompt: async (message) => {
          listener?.({ type: "turn_start" });
          listener?.({ type: "tool_execution_start", toolName: "submit_review", toolCallId: `call-${sessionCount}` });
          listener?.({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.002 } } } });
          const result = { summary: message.includes("汇总 Agent") ? "aggregated" : "specialist", findings: [], limitations: [], nextActions: [], mergeRecommendation: "approve" };
          await submit.execute("fake-submit", { result });
          listener?.({ type: "agent_settled" });
        },
      },
    };
  };
  const config = {
    ...DEFAULT_CONFIG,
    checks: { test: DEFAULT_CONFIG.checks.test },
    review: { ...DEFAULT_CONFIG.review, maxParallelAgents: 1, roles: [
      { id: "logic", instructions: "检查逻辑", enabled: true },
      { id: "security", instructions: "检查安全", enabled: true },
    ] },
  };
  const context = {
    repositoryRoot: process.cwd(), currentBranch: "feature", dirty: false,
    base: { ref: "main", sha: "base" }, head: { ref: "HEAD", sha: "head" },
    changes: [{ path: "src/change.ts", status: "modified", additions: 1, deletions: 0 }],
    diff: "diff --git a/src/change.ts b/src/change.ts", diffTruncated: false,
  };
  const initialChecks = [{ checkId: "test", category: "test", commandId: "test", displayCommand: "npm test", status: "passed", startedAt: "", finishedAt: "", durationMs: 1, output: "", outputTruncated: false }];
  const result = await runMultiAgentReview({
    repositoryRoot: process.cwd(), context, config, trace: { record: async () => {} }, initialChecks,
    maxTurns: 3, maxParallelAgents: 1, specialistSeconds: 1, aggregatorSeconds: 1, createAgentSession,
  });
  assert.equal(sessionCount, 3);
  assert.equal(result.summary, "aggregated");
  assert.equal(result.findings.length, 0);
  assert.equal(result.telemetry.successfulSpecialists, 2);
  assert.equal(result.telemetry.failedSpecialists, 0);
  assert.equal(result.telemetry.toolCalls, 3);
  assert.equal(result.telemetry.inputTokens, 30);
  assert.equal(result.telemetry.outputTokens, 12);
  assert.equal(result.telemetry.totalCost, 0.006);
});

test("scores evaluation telemetry and latency through an injectable runner", async () => {
  const dataset = await mkdtemp(join(tmpdir(), "repo-sentinel-eval-"));
  for (const [id, title] of [["clean", undefined], ["bug", "null dereference"]]) {
    const directory = join(dataset, id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "case.json"), JSON.stringify({ id, repository: "repository", head: "HEAD" }));
    await writeFile(join(directory, "expected.json"), JSON.stringify({ findings: title ? [{ title, path: "src/change.ts" }] : [], recommendation: title ? "needs_changes" : "approve" }));
  }
  const reviewRunner = async (options) => {
    const hasBug = options.repo.endsWith("/bug/repository");
    const finding = { id: "finding_1", severity: "high", category: "logic_risk", title: "null dereference", summary: "unsafe access", location: { path: "src/change.ts", startLine: 1, endLine: 1 }, evidence: [{ type: "diff", reference: "src/change.ts", summary: "changed" }], confidence: 0.9, suggestedFix: "guard", verificationStatus: "inferred" };
    return {
      result: {
        schemaVersion: 1, mergeRecommendation: hasBug ? "needs_changes" : "approve", summary: "fake", checks: [{ checkId: "test", category: "test", commandId: "test", displayCommand: "npm test", status: "passed", startedAt: "", finishedAt: "", durationMs: 1, output: "", outputTruncated: false }], findings: hasBug ? [finding] : [], limitations: [], nextActions: [],
        telemetry: { usageAvailable: true, specialistCount: 1, successfulSpecialists: 1, failedSpecialists: 0, specialistDurationMs: hasBug ? 40 : 20, aggregatorDurationMs: 10, totalDurationMs: hasBug ? 50 : 30, turns: 2, toolCalls: 3, inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, totalCost: 0.01 },
      }, outputDir: `/tmp/${hasBug ? "bug" : "clean"}`,
    };
  };
  const summary = await runEvaluation(dataset, { configPath: undefined, allowDirty: false, dryRun: false }, reviewRunner);
  assert.equal(summary.completed, 2);
  assert.equal(summary.scored, true);
  assert.equal(summary.findingPrecision, 1);
  assert.equal(summary.findingRecall, 1);
  assert.equal(summary.recommendationAccuracy, 1);
  assert.equal(summary.averageDurationMs, 40);
  assert.equal(summary.p95DurationMs, 50);
  assert.equal(summary.totalInputTokens, 200);
  assert.equal(summary.averageInputTokens, 100);
  assert.equal(summary.checkExecutionSuccessRate, 1);
  assert.equal(summary.totalCost, 0.02);
  assert.equal(summary.telemetryAvailableCases, 2);
});

test("marks dry-run evaluation metrics as unscored instead of reporting false quality numbers", async () => {
  const dataset = await mkdtemp(join(tmpdir(), "repo-sentinel-eval-dry-run-"));
  const directory = join(dataset, "case");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "case.json"), JSON.stringify({ id: "case", repository: "repository" }));
  await writeFile(join(directory, "expected.json"), JSON.stringify({ findings: [{ title: "expected" }], recommendation: "needs_changes" }));
  const reviewRunner = async () => ({ result: { schemaVersion: 1, mergeRecommendation: "inconclusive", summary: "dry", checks: [], findings: [], limitations: [], nextActions: [] }, outputDir: "/tmp/case" });
  const summary = await runEvaluation(dataset, { configPath: undefined, allowDirty: false, dryRun: true }, reviewRunner);
  assert.equal(summary.scored, false);
  assert.equal(summary.findingPrecision, null);
  assert.equal(summary.findingRecall, null);
  assert.equal(summary.recommendationAccuracy, null);
  assert.equal(summary.totalCost, null);
  assert.equal(summary.results[0].truePositive, null);
});

test("compares scored eval summaries and ignores unavailable metrics", () => {
  const baseline = { scored: true, findingPrecision: 0.9, findingRecall: 0.8, falsePositiveRate: 0.1, recommendationAccuracy: 1, evidenceCoverage: 1, checkExecutionSuccessRate: 1, p95DurationMs: 100 };
  const improved = compareEvalSummaries({ ...baseline, findingPrecision: 0.88, p95DurationMs: 115 }, baseline);
  assert.equal(improved.compared, true);
  assert.equal(improved.passed, true);
  const regressed = compareEvalSummaries({ ...baseline, findingRecall: 0.7, falsePositiveRate: 0.2, p95DurationMs: 130 }, baseline);
  assert.equal(regressed.passed, false);
  assert.deepEqual(regressed.violations.map((item) => item.metric), ["findingRecall", "falsePositiveRate", "p95DurationMs"]);
  const dryRun = compareEvalSummaries({ ...baseline, scored: false, findingPrecision: null }, baseline);
  assert.equal(dryRun.compared, false);
  assert.equal(dryRun.passed, true);
});

test("renders review telemetry in the human-readable report", () => {
  const markdown = renderMarkdown(
    { schemaVersion: 1, runId: "run", startedAt: "", status: "completed", repositoryRoot: "/repo", base: { ref: "main", sha: "base" }, head: { ref: "HEAD", sha: "head" }, dirty: false, configHash: "hash" },
    { schemaVersion: 1, mergeRecommendation: "approve", summary: "ok", checks: [], findings: [], limitations: [], nextActions: [], telemetry: { usageAvailable: true, specialistCount: 2, successfulSpecialists: 2, failedSpecialists: 0, specialistDurationMs: 10, aggregatorDurationMs: 4, totalDurationMs: 14, turns: 3, toolCalls: 5, inputTokens: 100, outputTokens: 20, cacheReadTokens: 2, cacheWriteTokens: 1, totalCost: 0.01 } },
    { repositoryRoot: "/repo", base: { ref: "main", sha: "base" }, head: { ref: "HEAD", sha: "head" }, dirty: false, changes: [], diff: "", diffTruncated: false },
  );
  assert.match(markdown, /## Telemetry/);
  assert.match(markdown, /input 100, output 20/);
});

test("maps findings to SARIF with severity, location, and evidence metadata", () => {
  const sarif = renderSarif({
    schemaVersion: 1, mergeRecommendation: "needs_changes", summary: "unsafe change", checks: [], limitations: [], nextActions: [],
    findings: [{ id: "finding_1", severity: "high", category: "security", title: "Credential leak", summary: "secret is logged", location: { path: "src/auth.ts", startLine: 12, endLine: 13 }, evidence: [{ type: "source", reference: "src/auth.ts:12", summary: "source" }], confidence: 0.95, suggestedFix: "remove log", verificationStatus: "verified" }],
  }, { schemaVersion: 1, runId: "run-1", startedAt: "", status: "completed", repositoryRoot: "/repo", base: { ref: "main", sha: "base" }, head: { ref: "HEAD", sha: "head" }, dirty: false, configHash: "hash" });
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].results[0].ruleId, "reposentinel/security");
  assert.equal(sarif.runs[0].results[0].level, "error");
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, "src/auth.ts");
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine, 12);
  assert.deepEqual(sarif.runs[0].results[0].properties.evidence, ["source:src/auth.ts:12"]);
});

test("serves bounded diff chunks with a continuation offset", () => {
  const context = {
    base: { ref: "main", sha: "base" }, head: { ref: "HEAD", sha: "head" },
    changes: [], diff: "0123456789abcdefghij", diffTruncated: false,
  };
  const first = getContextChunk(context, 0, 8);
  assert.equal(first.diff, "01234567");
  assert.equal(first.nextOffset, 8);
  assert.equal(first.truncated, true);
  const second = getContextChunk(context, first.nextOffset, 8);
  assert.equal(second.diff, "89abcdef");
  assert.equal(second.nextOffset, 16);
  const last = getContextChunk(context, second.nextOffset, 8);
  assert.equal(last.diff, "ghij");
  assert.equal(last.nextOffset, undefined);
  assert.equal(getContextChunk(context, 0, 99999).limit, 12000);
});

test("bounds repository file reads before decoding content", async () => {
  const repo = await mkdtemp(join(tmpdir(), "repo-sentinel-large-file-"));
  await writeFile(join(repo, "large.txt"), "x".repeat(200_000));
  const result = await readRepositoryFile(repo, "large.txt", DEFAULT_CONFIG);
  assert.equal(result.truncated, true);
  assert.ok(result.content.length <= 120_020);
  await assert.rejects(() => readRepositoryFile(repo, "large.txt", DEFAULT_CONFIG, 2), /超出可读取前缀/);
  await assert.rejects(() => readRepositoryFile(repo, "large.txt", DEFAULT_CONFIG, MAX_READ_LINE_NUMBER + 1), /起始行号超出允许范围/);
  await assert.rejects(() => readRepositoryFile(repo, "large.txt", DEFAULT_CONFIG, 1, MAX_READ_LINE_SPAN + 1), /单次读取行数超过上限/);
});

test("does not expose credentials in check summaries", async () => {
  const { redactSensitiveText } = await import("../dist/policy.js");
  const redacted = redactSensitiveText("TOKEN=secret Bearer abc123 password: hunter2");
  assert.doesNotMatch(redacted, /secret|abc123|hunter2/);
  assert.match(redacted, /REDACTED/);
});

test("redacts credentials from persisted run artifacts", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "repo-sentinel-report-"));
  const meta = { schemaVersion: 1, runId: "run", startedAt: "", status: "completed", repositoryRoot: "/repo", base: { ref: "main", sha: "base" }, head: { ref: "HEAD", sha: "head" }, dirty: false, configHash: "hash" };
  const result = { schemaVersion: 1, mergeRecommendation: "approve", summary: "", checks: [{ checkId: "test", category: "test", commandId: "test", displayCommand: "npm test", status: "passed", startedAt: "", finishedAt: "", durationMs: 0, output: "TOKEN=secret", outputTruncated: false, error: "Bearer abc123" }], findings: [], limitations: [], nextActions: [] };
  const context = { repositoryRoot: "/repo", base: meta.base, head: meta.head, dirty: false, changes: [], diff: "", diffTruncated: false };
  await writeRun(outputDir, meta, result, context);
  const runJson = await readFile(join(outputDir, "run.json"), "utf8");
  const checksJson = await readFile(join(outputDir, "checks.json"), "utf8");
  assert.doesNotMatch(`${runJson}${checksJson}`, /secret|abc123/);
  assert.match(`${runJson}${checksJson}`, /REDACTED/);
});

test("redacts model-generated finding text in all persisted report formats", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "repo-sentinel-finding-redaction-"));
  const meta = { schemaVersion: 1, runId: "run", startedAt: "", status: "completed", repositoryRoot: "/repo", base: { ref: "main", sha: "base" }, head: { ref: "HEAD", sha: "head" }, dirty: false, configHash: "hash" };
  const result = { schemaVersion: 1, mergeRecommendation: "approve_with_notes", summary: "TOKEN=secret", checks: [], findings: [{ id: "finding_1", severity: "low", category: "security", title: "Bearer abc123", summary: "password: hunter2", location: { path: "src/auth.ts", startLine: 1, endLine: 1 }, evidence: [{ type: "source", reference: "src/auth.ts", summary: "TOKEN=secret" }], confidence: 0.5, suggestedFix: "remove password: hunter2", verificationStatus: "needs_human_review" }], limitations: ["password: hunter2"], nextActions: ["TOKEN=secret"] };
  const context = { repositoryRoot: "/repo", base: meta.base, head: meta.head, dirty: false, changes: [], diff: "", diffTruncated: false };
  await writeRun(outputDir, meta, result, context);
  const persisted = `${await readFile(join(outputDir, "run.json"), "utf8")}\n${await readFile(join(outputDir, "report.md"), "utf8")}\n${await readFile(join(outputDir, "report.sarif"), "utf8")}`;
  assert.doesNotMatch(persisted, /secret|abc123|hunter2/);
  assert.match(persisted, /REDACTED/);
});
