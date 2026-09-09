import { Type } from "typebox";
import { MAX_READ_LINE_NUMBER } from "../files.js";

/** Pi 工具使用的运行时 schema；最终业务校验仍由 report 模块负责。 */
export const reviewResultSchema = Type.Object({ // Agent 提交结果的运行时结构约束。
  summary: Type.String(),
  findings: Type.Array(Type.Object({
    id: Type.Optional(Type.String()), severity: Type.String({ pattern: "^(critical|high|medium|low|info)$" }), category: Type.String(), title: Type.String(), summary: Type.String(),
    location: Type.Object({ path: Type.String(), startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINE_NUMBER })), endLine: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINE_NUMBER })) }),
    evidence: Type.Array(Type.Object({ type: Type.String({ pattern: "^(command|diff|source)$" }), reference: Type.String(), summary: Type.String() })), confidence: Type.Number({ minimum: 0, maximum: 1 }),
    suggestedFix: Type.Optional(Type.String()), verificationStatus: Type.Optional(Type.String({ pattern: "^(verified|inferred|needs_human_review)$" })),
  })),
  limitations: Type.Array(Type.String()), nextActions: Type.Array(Type.String()), mergeRecommendation: Type.Optional(Type.String()),
});
