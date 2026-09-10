import type { AgentRunInput } from "./contracts.js";
import { summarizeChecks, MAX_CONTEXT_PAGE_CHARS } from "../tools/context.js";

// Prompt 只负责告诉模型“应该怎么审查”，不能承担权限控制。
// 真正的路径、命令和输出限制必须在 tools 实现和策略层再次校验。

/** 构造专家 Prompt：首屏给摘要，详细 Diff 通过工具按需分页读取。 */
export function specialistPrompt(input: AgentRunInput): string {
  const role = input.role ?? "lead";
  const changedPaths = input.context.changes.map((change) => change.path);
  const checkText = summarizeChecks(input.initialChecks ?? []);
  const checkInstruction = input.includeCheckTool === false
    ? "所有已启用检查已由主控程序执行过一次。不要调用 run_check；直接使用下面的检查摘要作为证据。"
    : "先使用 list_checks，再按需使用 run_check 获取证据。";
  // 必须用模板字符串（反引号）：写在普通双引号字符串里的 ${...} 不会被求值，
  // 模型会看到字面量 "${MAX_CONTEXT_PAGE_CHARS}" 而不是真实数字。
  const contextInstruction = input.includeContextTools === false
    ? "本角色采用快速模式，不再调用文件工具；仅依据变更清单和检查摘要提交结果。"
    : `请先使用 get_change_context(offset=0, maxChars=${MAX_CONTEXT_PAGE_CHARS}) 分页读取 diff；如返回 nextOffset，继续读取后续分块，再使用 read_file/search_files 获取必要的非敏感上下文。每次尽量用满 maxChars（上限 ${MAX_CONTEXT_PAGE_CHARS}），以减少往返次数。`;
  // 前段（身份、职责、审查方法论）可由操作者配置完全替换；
  // 以下强制契约尾部始终追加，配置无权删除——删掉它 Agent 就不会再调用 submit_review。
  const preamble = input.systemPrompt ?? `You are RepoSentinel specialist agent: ${role}.\n\n你的职责：${input.instructions ?? "审查本次 Git 变更，识别有证据支持的问题。"}`;
  return `${preamble}

  首屏只提供变更清单和检查摘要，不嵌入完整 diff，以避免上下文截断。${contextInstruction}${checkInstruction}
不要执行任意 Shell 命令，不要读取敏感路径，不要修改仓库文件。

变更文件清单：
${JSON.stringify(input.context.changes)}

主控已收集的检查摘要：${checkText}

最终必须通过 submit_review 提交结构化结果。Finding 必须包含 title、summary、location、evidence、confidence、suggestedFix 和 verificationStatus；evidence.type 只能是 command、diff 或 source，severity 只能是 critical、high、medium、low 或 info；location.path 必须严格等于某个变更文件路径，不能填写目录。高等级问题必须有证据。无法确认时降低置信度并标记 needs_human_review。若 submit_review 返回校验错误，请根据错误修正结果后重新提交。

允许定位的变更文件路径：${JSON.stringify(changedPaths)}`;
}

/**
 * 构造汇总 Prompt。
 *
 * payload 已在 aggregator.ts 中裁剪并编好 ref。前段可由操作者配置替换，
 * 但“只引用已有 ref、不重写正文、必须调 submit_merge_plan”这些契约始终由代码强制。
 */
export function aggregatorPrompt(payload: unknown, failedRoles: string[], systemPrompt?: string): string {
  const preamble = systemPrompt ?? `你是 RepoSentinel 的汇总 Agent。你的任务是去重，不是重写。

汇总输入里的每条 Finding 都带一个 ref（形如 logic#2）。判断哪些 Finding 描述同一个根因，只保留证据最充分、位置最准确的一条，把保留项的 ref 放进 keep。`;
  return `${preamble}${failedRoles.length ? `

以下专家未完成，不要为它们补写结论：${failedRoles.join(", ")}。` : ""}

规则：
- keep 只能填写汇总输入中出现过的 ref，不能新增、不能编造 Finding。不要参考 Finding 原 id。
- 不要重复 Finding 正文、证据或严重等级：保留项的正文由主控按 ref 原样搬运，你写的正文会被忽略。
- high/critical 且 verified 的 Finding 由主控强制保留，你仍应把它们放进 keep。
- 至少保留一条 Finding；确实全部重复时才允许减少到一条。
- summary 不超过 500 字，只写合并后的结论；limitations 和 nextActions 只补充专家结果里没有明确的全局信息，不要复述。
- 不要新增没有出现在专家结果中的事实。检查结果由主控统一执行，不能修改 checks。

最终必须调用 submit_merge_plan 提交 summary、keep、limitations、nextActions。若返回校验错误，请根据错误修正后重新提交。

汇总输入：${JSON.stringify(payload)}`;
}
