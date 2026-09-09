import type { Finding, ReviewResult, RunMetadata } from "./types.js";

const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

type SarifLevel = "error" | "warning" | "note" | "none";

/** 将 RepoSentinel 严重等级映射到 SARIF 消费者认识的 level。 */
function levelFor(severity: Finding["severity"]): SarifLevel {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}

/** 规则 ID 稳定且只使用安全字符，方便 Code Scanning 聚合同类结果。 */
function ruleIdFor(finding: Finding): string {
  const category = finding.category.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "finding"; // 转换成 SARIF 允许且稳定的分类名称。
  return `reposentinel/${category}`;
}

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: Array<Record<string, unknown>>;
}

/**
 * 将已校验的 ReviewResult 转成 SARIF。
 * 这是纯函数，不负责写文件，因此可以独立测试并复用到其他发布渠道。
 */
export function renderSarif(result: ReviewResult, metadata?: RunMetadata): SarifLog {
  // 相同 category 只生成一个 rule，具体问题放在 results 中。
  const rules = new Map<string, Record<string, unknown>>(); // 按 category 保存 SARIF 规则定义。
  const results = result.findings.map((finding) => { // 将每个 Finding 转成 SARIF result。
    const ruleId = ruleIdFor(finding); // 当前 Finding 对应的稳定规则 ID。
    if (!rules.has(ruleId)) {
      rules.set(ruleId, {
        id: ruleId,
        name: finding.category,
        shortDescription: { text: finding.category },
        help: { text: finding.suggestedFix },
        properties: { severity: finding.severity },
      });
    }
    return {
      ruleId,
      level: levelFor(finding.severity),
      message: { text: `${finding.title}: ${finding.summary}` },
      locations: [{ physicalLocation: {
        artifactLocation: { uri: finding.location.path },
        region: { startLine: finding.location.startLine, endLine: finding.location.endLine },
      } }],
      properties: {
        category: finding.category,
        severity: finding.severity,
        confidence: finding.confidence,
        verificationStatus: finding.verificationStatus,
        evidence: finding.evidence.map((evidence) => `${evidence.type}:${evidence.reference}`),
      },
    };
  });
  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [{
      tool: { driver: {
        name: "RepoSentinel",
        version: "0.1.0",
        informationUri: "https://github.com/",
        rules: [...rules.values()],
      } },
      results,
      automationDetails: metadata ? { id: metadata.runId } : undefined,
      properties: {
        recommendation: result.mergeRecommendation,
        summary: result.summary,
        findingCount: result.findings.length,
      },
    }],
  };
}
