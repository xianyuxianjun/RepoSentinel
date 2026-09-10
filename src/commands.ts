/**
 * 预批准命令目录：一次性定义「允许执行的命令字符串 -> 固定 file/args」的映射。
 *
 * 这里是检查执行的唯一事实来源，配置默认值、执行映射和 npm script 预检都从它派生：
 * - config 的 commandPolicy.allowed 默认值来自 APPROVED_COMMAND_NAMES；
 * - checks 执行时只按命令字符串查表，绝不把命令字符串交给 shell；
 * - 需要 npm script 的命令通过 npmScript 标记，缺失时前置判定为 environment_error。
 *
 * 之前的实现把同一份映射拆到 config（正则猜 script 名）和 checks（手写 commandMap）两处，
 * 两边一旦漂移就会出现「配置校验通过但执行阶段不支持」的死角。
 */
export interface ApprovedCommand {
  /** 直接交给 spawn 的可执行文件。 */
  file: string;
  /** 直接交给 spawn 的参数数组。 */
  args: string[];
  /** 该命令依赖的 npm script 名；npm 内置子命令（如 audit）没有 script。 */
  npmScript?: string;
}

export const APPROVED_COMMANDS: Readonly<Record<string, ApprovedCommand>> = Object.freeze({
  "npm test": { file: "npm", args: ["test"], npmScript: "test" },
  "npm run lint": { file: "npm", args: ["run", "lint"], npmScript: "lint" },
  "npm run typecheck": { file: "npm", args: ["run", "typecheck"], npmScript: "typecheck" },
  "npm audit --json": { file: "npm", args: ["audit", "--json"] },
  "npm run build": { file: "npm", args: ["run", "build"], npmScript: "build" },
});

/** 预批准命令字符串列表，顺序稳定，可直接作为 commandPolicy.allowed 的默认值。 */
export const APPROVED_COMMAND_NAMES: readonly string[] = Object.keys(APPROVED_COMMANDS);

/** 查表；未登记的命令返回 undefined，调用方必须显式处理而不是猜测。 */
export function resolveApprovedCommand(command: string): ApprovedCommand | undefined {
  return Object.prototype.hasOwnProperty.call(APPROVED_COMMANDS, command) ? APPROVED_COMMANDS[command] : undefined;
}
