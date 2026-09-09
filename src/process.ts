import { spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number | null;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  durationMs: number;
}

export interface ProcessOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * 运行一个不经过 Shell 的子进程。
 * file 和 args 分开传给 spawn，避免字符串拼接带来的命令注入风险。
 */
export function runProcess(file: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now(); // 子进程启动时间，用于计算执行耗时。
    const child = spawn(file, args, { // 实际执行的外部命令进程。
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; // 子进程标准输出。
    let stderr = ""; // 子进程标准错误输出。
    let bytes = 0; // stdout 和 stderr 已累计的字节数。
    let outputTruncated = false; // 输出是否超过最大字节上限。
    let timedOut = false; // 是否因为超时主动终止进程。
    let settled = false; // Promise 是否已经完成，防止重复 resolve/reject。
    // stdout/stderr 共用一个字节预算，防止异常命令用大量输出耗尽内存。
    const append = (target: "stdout" | "stderr", chunk: Buffer) => { // 按共享字节预算收集输出。
      if (bytes >= options.maxOutputBytes) { outputTruncated = true; return; }
      const remaining = options.maxOutputBytes - bytes; // 当前还允许写入的字节数。
      let text = chunk.subarray(0, remaining).toString("utf8"); // 截取本次允许保存的文本。
      while (Buffer.byteLength(text) > remaining && text.length > 0) text = text.slice(0, -1);
      bytes += Buffer.byteLength(text);
      if (target === "stdout") stdout += text;
      else stderr += text;
      if (Buffer.byteLength(text) < chunk.byteLength) outputTruncated = true;
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    // 先优雅终止进程组，给子进程清理机会；仍不退出时再强制 kill。
    const timeout = setTimeout(() => { // 外部命令的超时定时器。
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      setTimeout(() => { if (!settled) killProcessTree(child, "SIGKILL"); }, 1000).unref();
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal: signal ?? undefined, stdout, stderr, timedOut, outputTruncated, durationMs: Date.now() - started });
    });
  });
}

/** npm 等命令可能再创建子进程，所以 Unix 下按进程组终止。 */
function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* process may have exited */ }
  }
  child.kill(signal);
}
