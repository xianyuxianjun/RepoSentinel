// Agent 子模块的兼容出口：外部调用方无需感知内部目录拆分。
export type { AgentRunInput, MultiAgentRunInput, SpecialistResult, AgentSessionLike, AgentSessionFactory } from "./agent/contracts.js";
export { getContextChunk } from "./tools/context.js";
export type { ContextChunk } from "./tools/context.js";
export { runReviewAgent } from "./agent/specialist.js";
export { runMultiAgentReview } from "./agent/orchestrator.js";
