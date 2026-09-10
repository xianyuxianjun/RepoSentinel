import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_MODEL_REFERENCE, DEFAULT_OPERATOR_CONFIG } from "./defaults.js";
import type { OperatorConfig, ThinkingLevelName } from "../types.js";

const MAX_MODEL_REFERENCE_LENGTH = 200; // 模型引用长度上限，防止异常配置进入 Trace 和报告。
const MAX_SYSTEM_PROMPT_CHARS = 4_000; // 单个 Agent 提示词前段的长度上限。
const thinkingLevels: ThinkingLevelName[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]; // SDK 支持的档位全集。

function validateSystemPrompt(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_SYSTEM_PROMPT_CHARS) throw new Error(`操作者配置的 ${label} 必须是 1 到 ${MAX_SYSTEM_PROMPT_CHARS} 字的字符串`);
  return value;
}

/**
 * 操作者配置是本地文件，但同样按外部输入校验：
 * 模型引用与提示词都会进入 SDK 调用和 Trace，必须限制长度并拒绝控制字符。
 */
export function validateOperatorConfig(input: unknown): OperatorConfig {
  if (!input || typeof input !== "object") throw new Error("操作者配置必须是 JSON 对象");
  const value = input as Record<string, unknown>; // 操作者配置的对象视图。
  if (value.version !== 1) throw new Error("不支持的操作者配置 version，当前只支持 1");
  const rawModel = value.model ?? DEFAULT_MODEL_REFERENCE; // 未声明模型时用内置默认。
  if (typeof rawModel !== "string" || rawModel.trim() === "" || rawModel.length > MAX_MODEL_REFERENCE_LENGTH || /[\u0000-\u001f\u007f]/.test(rawModel)) throw new Error(`操作者配置的 model 必须为 1 到 ${MAX_MODEL_REFERENCE_LENGTH} 字的模型引用，例如 ${DEFAULT_MODEL_REFERENCE}`);
  let thinkingLevel: ThinkingLevelName | undefined; // 可选的全局思考档位。
  if (value.thinkingLevel !== undefined) {
    if (typeof value.thinkingLevel !== "string" || !thinkingLevels.includes(value.thinkingLevel as ThinkingLevelName)) throw new Error(`操作者配置的 thinkingLevel 只能是 ${thinkingLevels.join("、")}`);
    thinkingLevel = value.thinkingLevel as ThinkingLevelName;
  }
  const rolePrompts = validateRolePrompts(value.rolePrompts); // 按角色 ID 的前段提示词覆盖。
  const aggregatorPrompt = value.aggregatorPrompt === undefined ? undefined : validateSystemPrompt(value.aggregatorPrompt, "aggregatorPrompt");
  return { version: 1, model: rawModel.trim(), thinkingLevel, rolePrompts, aggregatorPrompt };
}

function validateRolePrompts(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("操作者配置的 rolePrompts 必须是对象");
  const rolePrompts: Record<string, string> = {};
  for (const [roleId, prompt] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(roleId)) throw new Error(`rolePrompts 的角色 ID 无效：${roleId}`);
    rolePrompts[roleId] = validateSystemPrompt(prompt, `rolePrompts.${roleId}`);
  }
  return rolePrompts;
}

/** 操作者配置的默认路径：与 Pi 自身的 agent 配置放在一起，位于被审查仓库之外。 */
export function defaultOperatorConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE; // 当前用户的主目录。
  // 不回退到 cwd：cwd 往往就是被审查仓库，那等于把模型配置又交回 PR 控制。
  if (!home) throw new Error("无法确定主目录（HOME/USERPROFILE 未设置）；请用 --operator-config 或 REPO_SENTINEL_OPERATOR_CONFIG 显式指定操作者配置");
  return join(home, ".pi", "agent", "repo-sentinel.json");
}

/**
 * 读取操作者配置。文件不存在时回退到内置默认而不是报错：开箱即用仍然成立，
 * 但被审查仓库无法参与「用哪个模型、用什么提示词」这个选择。
 */
export async function loadOperatorConfig(explicitPath?: string): Promise<{ config: OperatorConfig; path: string }> {
  const requested = explicitPath ?? process.env.REPO_SENTINEL_OPERATOR_CONFIG; // 调用方显式指定的路径。
  const path = resolve(requested ?? defaultOperatorConfigPath());
  try {
    return { config: validateOperatorConfig(JSON.parse(await readFile(path, "utf8")) as unknown), path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // 显式指定却不存在必须报错：静默用内置默认会让操作者以为自己换的模型生效了。
      if (requested) throw new Error(`操作者配置不存在：${path}`);
      return { config: validateOperatorConfig(DEFAULT_OPERATOR_CONFIG), path };
    }
    throw error;
  }
}
