import type { AgentRunInput } from "./contracts.js";
import { summarizeChecks } from "../tools/context.js";

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
  return `You are RepoSentinel specialist agent: ${role}.

你的职责：${input.instructions ?? "审查本次 Git 变更，识别有证据支持的问题。"}

  首屏只提供变更清单和检查摘要，不嵌入完整 diff，以避免上下文截断。${input.includeContextTools === false ? "本角色采用快速模式，不再调用文件工具；仅依据变更清单和检查摘要提交结果。" : "请先使用 get_change_context(offset=0, maxChars=8000) 分页读取 diff；如返回 nextOffset，继续读取后续分块，再使用 read_file/search_files 获取必要的非敏感上下文。"}${checkInstruction}
不要执行任意 Shell 命令，不要读取敏感路径，不要修改仓库文件。

变更文件清单：
${JSON.stringify(input.context.changes)}

主控已收集的检查摘要：${checkText}

最终必须通过 submit_review 提交结构化结果。Finding 必须包含 title、summary、location、evidence、confidence、suggestedFix 和 verificationStatus；evidence.type 只能是 command、diff 或 source，severity 只能是 critical、high、medium、low 或 info；location.path 必须严格等于某个变更文件路径，不能填写目录。高等级问题必须有证据。无法确认时降低置信度并标记 needs_human_review。若 submit_review 返回校验错误，请根据错误修正结果后重新提交。

允许定位的变更文件路径：${JSON.stringify(changedPaths)}`;
}

/** 构造汇总 Prompt；payload 已在 aggregator.ts 中裁剪，这里不再接收完整专家对象。 */
export function aggregatorPrompt(payload: unknown, failedRoles: string[]): string {
  return `你是 RepoSentinel 的汇总 Agent。请合并多个专家 Agent 的结构化审查结果，去除同一根因的重复 Finding，保留证据最充分、位置最准确的一条。不要新增没有出现在专家结果中的事实。${failedRoles.length ? `以下专家未完成：${failedRoles.join(", ")}。` : ""}

检查结果已经由主控程序统一执行，不能修改 checks。最终必须调用 submit_review，输出 summary、findings、limitations、nextActions。evidence.type 只能是 command、diff 或 source；location.path 必须是本次变更文件路径。高等级 Finding 必须保留 evidence，无法确认的结论标记 needs_human_review。若 submit_review 返回校验错误，请根据错误修正后重新提交。

专家结果：${JSON.stringify(payload)}`;
}
