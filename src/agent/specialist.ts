import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CheckResult, ReviewResult } from "../types.js";
import { validateReviewResult } from "../report.js";
import { runSession } from "./session.js";
import { specialistPrompt } from "./prompts.js";
import type { AgentRunInput } from "./contracts.js";
import { createSpecialistTools, type ReviewToolState } from "../tools/review.js";

/**
 * 运行一个专家角色。
 *
 * Agent 层只负责 Session 生命周期和最终结果处理；受控读取、检查和提交能力由 tools 层提供。
 */
export async function runReviewAgent(input: AgentRunInput): Promise<ReviewResult> {
  // 复制数组，避免某个专家通过 run_check 修改上层传入的 initialChecks。
  const checkResults: CheckResult[] = [...(input.initialChecks ?? [])]; // 当前专家可引用的检查结果副本。
  const role = input.role ?? "lead"; // 当前专家的角色名称。
  const changedPaths = input.context.changes.map((change) => change.path); // 本次变更涉及的文件路径。
  const state: ReviewToolState = { submitted: undefined }; // Tool 与 Session 共享的提交状态。
  const { customTools, toolNames } = createSpecialistTools({ // 根据权限配置创建当前专家可用的工具。
    repositoryRoot: input.repositoryRoot,
    context: input.context,
    config: input.config,
    trace: input.trace,
    role,
    checkResults,
    changedPaths,
  }, state, { includeCheckTool: input.includeCheckTool, includeContextTools: input.includeContextTools });

  const sessionFactory = input.createAgentSession ?? createAgentSession; // 生产环境或测试环境使用的 Session 创建函数。
  // SessionManager 使用内存实现，避免本地审查把对话持久化到不必要的位置。
  // model/modelRuntime 只在配置里显式声明了模型时才传入，未声明时保持 Pi 默认行为。
  const { session } = await sessionFactory({
    cwd: input.repositoryRoot,
    thinkingLevel: input.agentModel?.thinkingLevel ?? "low",
    model: input.agentModel?.model,
    modelRuntime: input.agentModel?.modelRuntime,
    tools: toolNames,
    customTools,
    sessionManager: SessionManager.inMemory(input.repositoryRoot),
  }); // 当前专家的 Pi 会话。
  state.activeSession = session;
  try {
    const run = await runSession({ session, trace: input.trace, role, maxTurns: input.maxTurns ?? 12, maxSeconds: input.maxSeconds ?? 300 }, specialistPrompt(input), () => state.submitted); // 执行 Prompt、工具调用和生命周期限制。
    const validated = validateReviewResult(run.submitted, checkResults, changedPaths); // 对 Agent 提交的结果做最终业务校验。
    const telemetry = { ...run.telemetry, durationMs: run.telemetry.durationMs || 0 }; // 补齐当前专家的运行统计。
    await input.trace.record("agent_end", { agentRole: role, findings: validated.findings.length, checks: validated.checks.length, telemetry });
    return { ...validated, telemetry };
  } catch (error) {
    // 保持原有错误语义，由上层编排器决定是降级还是终止。
    throw error;
  }
}
