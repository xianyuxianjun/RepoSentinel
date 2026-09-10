// 兼容出口：诊断探针属于 tools 层，公共 API 路径保持不变。
export type { AgentDiagnosticResult, AgentDiagnosticOptions } from "./tools/diagnostic.js";
export { runAgentDiagnostic } from "./tools/diagnostic.js";
