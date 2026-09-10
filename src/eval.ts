// eval 是公共 API 门面：类型、指标计算和 runner 分别在 eval/ 下。
//
// 为什么用同级 eval.ts 而不是 eval/index.ts：NodeNext 不做目录 index 回退，
// "./eval.js" 必须对应真实文件；同级门面让调用点和 dist 产物路径都保持稳定（同 src/agent.ts）。
export * from "./eval/types.js";
export * from "./eval/score.js";
export * from "./eval/run.js";
