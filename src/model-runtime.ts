import { ModelRuntime, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelName } from "./types.js";

/** 未显式指定思考档位时使用的内置默认值。 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevelName = "low";

/**
 * 一次 Review 实际使用的模型对象、思考档位和解析它的 Runtime。
 *
 * 这个模块刻意放在顶层而不是 agent/ 下：tools/ 和 agent/ 都需要它，
 * 放在任一侧都会让两个目录互相依赖。
 */
export interface ResolvedReviewModel {
  /** SDK 解析出的模型对象，可直接传给 createAgentSession。 */
  model: ScopedModel["model"];
  /** 模型引用中显式声明的思考档位或操作者配置的档位；都没有时为内置默认。 */
  thinkingLevel: ScopedModel["thinkingLevel"];
  /** 解析出该模型的 Runtime；复用它可以避免每个 Session 重复加载模型目录。 */
  modelRuntime: ModelRuntime;
  /** 形如 provider/modelId 的引用，用于 Trace 和报告，不含思考档位。 */
  reference: string;
}

/**
 * 把配置里的模型引用解析成 SDK 模型对象。
 *
 * 这里只解析和校验，不做静默降级：解析失败说明配置或认证有问题，
 * 应该在创建任何 Session 之前就失败，并给出可操作的信息。
 */
export async function resolveReviewModel(reference: string, options: { modelRuntime?: ModelRuntime; thinkingLevel?: ThinkingLevelName } = {}): Promise<ResolvedReviewModel> {
  const runtime = options.modelRuntime ?? (await ModelRuntime.create()); // 复用调用方传入的 Runtime，避免重复加载模型目录。
  // 只在“已配置认证”的模型里查找，避免把认证问题推迟到某个专家 Session 才暴露。
  const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics([reference], runtime);
  const resolved = scopedModels[0]; // 模型引用应当唯一命中；多个候选时取 SDK 认为最合适的一个。
  if (!resolved) {
    const detail = diagnostics.map((diagnostic) => diagnostic.message).join("；") || "未找到匹配的模型";
    throw new Error(`无法解析模型 "${reference}"：${detail}。请检查操作者配置的 model 和 Pi 模型认证`);
  }
  return {
    model: resolved.model,
    // 优先级：模型引用里的 :档位 > 操作者配置的档位 > 内置默认。
    thinkingLevel: resolved.thinkingLevel ?? options.thinkingLevel ?? (DEFAULT_THINKING_LEVEL as ScopedModel["thinkingLevel"]),
    modelRuntime: runtime,
    reference: `${resolved.model.provider}/${resolved.model.id}`,
  };
}
