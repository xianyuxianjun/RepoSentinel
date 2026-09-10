// config 是公共 API 门面：默认值、操作者配置和仓库配置分别实现在 config/ 下，
// 外部调用方仍然从 "./config.js" 导入，不需要了解内部文件组织。
export * from "./config/defaults.js";
export * from "./config/operator.js";
export * from "./config/repo.js";
