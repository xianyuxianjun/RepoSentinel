// report 是公共 API 门面：校验、结论判定、Markdown 渲染和产物写出分别在 report/ 下。
export * from "./report/validate.js";
export * from "./report/recommend.js";
export * from "./report/markdown.js";
export * from "./report/write.js";
