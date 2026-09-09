import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TraceEvent } from "./types.js";

/** 递归脱敏 Trace payload；Trace 是诊断数据，也必须遵守最小暴露原则。 */
function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
      .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
      .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED KEY]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /key|token|secret|password|cookie|auth/i.test(key) ? "[REDACTED]" : redact(item)]));
  return value;
}

/**
 * JSONL Trace 记录器。
 * ready 链保证并发 record 调用按顺序写盘，避免多 Agent 事件互相覆盖。
 */
export class TraceRecorder {
  private readonly path: string;
  private readonly runId: string;
  private ready: Promise<void>;

  constructor(outputDir: string, runId: string) {
    this.path = join(outputDir, "trace.jsonl");
    this.runId = runId;
    this.ready = (async () => {
      await mkdir(outputDir, { recursive: true });
    })();
  }

  /** 每条事件都自动附带时间和 runId，便于跨 Session 还原执行顺序。 */
  async record(type: string, details: Record<string, unknown> = {}): Promise<void> {
    const event: TraceEvent = { timestamp: new Date().toISOString(), type, runId: this.runId, ...redact(details) as Record<string, unknown> }; // 添加时间、运行 ID 和脱敏后的事件内容。
    this.ready = this.ready.then(async () => {
      await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    });
    await this.ready;
  }
}
