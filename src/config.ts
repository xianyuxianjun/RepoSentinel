// config 是公共 API 门面：默认值、操作者配置和仓库配置分别实现在 config/ 下，
// 外部调用方仍然从 "./config.js" 导入，不需要了解内部文件组织。
//
// 为什么用同级 config.ts 而不是 config/index.ts：NodeNext 不做目录 index 回退，
// "./config.js" 必须对应真实文件；同级门面让调用点和 dist 产物路径都保持稳定（同 src/agent.ts）。
export * from "./config/defaults.js";
export * from "./config/operator.js";
export * from "./config/repo.js";
