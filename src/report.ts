// report 是公共 API 门面：校验、结论判定、Markdown 渲染和产物写出分别在 report/ 下。
//
// 为什么用同级 report.ts 而不是 report/index.ts：NodeNext 不做目录 index 回退，
// "./report.js" 必须对应真实文件；同级门面让调用点和 dist 产物路径都保持稳定（同 src/agent.ts）。
export * from "./report/validate.js";
export * from "./report/recommend.js";
export * from "./report/markdown.js";
export * from "./report/write.js";
