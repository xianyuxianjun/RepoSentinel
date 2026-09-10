// index.ts 是公共 API 门面：外部调用方从这里导入，不需要了解内部文件组织。
export * from "./types.js";
export * from "./config.js";
export * from "./model-runtime.js";
export * from "./git.js";
export * from "./policy.js";
export * from "./checks.js";
export * from "./report.js";
export * from "./review.js";
export * from "./eval.js";
export * from "./sarif.js";
export * from "./files.js";
export * from "./diagnose.js";

/** 保留给示例/冒烟测试的最小公共函数。 */
export function demoReviewTarget(input: string): string {
  return input.trim();
}
