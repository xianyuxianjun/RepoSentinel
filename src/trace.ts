import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { redactPayload } from "./policy.js";
import type { TraceEvent } from "./types.js";

/**
 * JSONL Trace 记录器。
 * ready 链保证并发 record 调用按顺序写盘，避免多 Agent 事件互相覆盖。
 * payload 统一走 policy 的 redactPayload，脱敏规则只有一份实现。
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
    const event: TraceEvent = { timestamp: new Date().toISOString(), type, runId: this.runId, ...redactPayload(details) as Record<string, unknown> }; // 添加时间、运行 ID 和脱敏后的事件内容。
    this.ready = this.ready.then(async () => {
      await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    });
    await this.ready;
  }
}
