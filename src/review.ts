// review 是公共 API 门面：主流程和生命周期状态分别实现在 review/ 下。
//
// 为什么用同级 review.ts 而不是 review/index.ts：NodeNext 不做目录 index 回退，
// "./review.js" 必须对应真实文件；同级门面让调用点和 dist 产物路径都保持稳定（同 src/agent.ts）。
export * from "./review/service.js";
export * from "./review/lifecycle.js";
