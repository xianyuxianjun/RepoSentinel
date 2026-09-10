# RepoSentinel

RepoSentinel 是一个基于 Pi Agent SDK 的本地代码变更验证 Agent。它读取 Git 分支差异，通过受控工具执行项目检查，并生成带证据的 Markdown、JSON 和事件 Trace 报告。

## 当前状态

当前版本是本地 CLI MVP：

- 支持 Node.js / TypeScript 项目的本地 review。
- 支持测试、Lint、TypeScript 类型检查、依赖审计和构建命令。
- Agent 只能按 `checkId` 运行预先配置的检查，不接受任意 Shell 命令。
- Agent 可通过受控的 `read_file` / `search_files` 工具查看仓库源码；工具会校验仓库边界、符号链接和敏感路径。
- 必要检查在 Agent 启动前确定性执行，模型不能通过遗漏检查伪造通过结论。
- 审查模型与每个 Agent 的前段提示词由**操作者配置**决定（默认 `~/.pi/agent/repo-sentinel.json`，位于被审查仓库之外），不随 PR 变更；内置默认模型为 `deepseek/deepseek-v4-flash`，解析失败会在创建 Session 前明确报错，不会静默回退到其他模型。
- 默认使用 4 个专业 Agent 并发分工审查逻辑、测试、安全和工程质量，再由汇总 Agent 去重；汇总 Agent 只提交“保留哪些 Finding 的引用 + 摘要”，Finding 正文由主控按引用原样搬运，因此汇总阶段既不会篡改证据，也不受重新生成正文的输出量限制；角色和并行度均可配置（默认并发 4，可用 `review.maxParallelAgents` 降到 1 回到串行以兼容不支持并发流的 Provider），每个 Agent 都有独立轮次和时间上限。
- 默认拒绝 dirty worktree、敏感路径、仓库外路径和源代码写操作。
- 结论由确定性规则重算，模型不能自行宣布通过：必需的检查未完成、或某个专家 Agent 未完成时返回 `inconclusive`（无法完成验证）；已经拿到 `high`/`critical` 且 `verified` 的证据时优先返回 `needs_changes`，避免因为专家缺失而丢掉阻断结论。覆盖是否完整由结构化字段 `incompleteSpecialists` / `orchestrationError` 表达，`limitations` 只作为人类可读说明，不作为控制通道。
- 输出 `run.json`、`report.md`、`report.sarif`、`checks.json` 和 `trace.jsonl`；SARIF 可被 GitHub Code Scanning 等工具消费。
- `run.json` 和 Trace 汇总 Agent 轮次、工具调用、输入/输出 token、缓存 token、成本及时延；无法从 Provider 取得的 usage 按 0 记录并以 `usageAvailable`/`telemetryAvailableCases` 区分。
- 敏感路径基线（`.env`、密钥/证书和 `.git`）始终拒绝访问，`denyPathPatterns` 只能追加规则，不能清空或覆盖基线。
- 采用分层上下文：首屏只注入变更清单和限长检查摘要，Diff 通过 `get_change_context(offset, maxChars)` 分页读取；每次分块读取写入 `context_chunk_read` Trace，避免大变更一次性截断。单页上限 32,000 字符且默认用满上限，让 Agent 用尽量少的轮次读完 diff（页太小会把轮次预算耗在翻页上，而不是用于提交结论）。
- 变更清单使用 `git diff --name-status` 的真实状态（`added`/`deleted`/`modified`/`renamed`/`copied`/`type_changed`），不再把所有文件标成 `modified`。
- 汇总阶段同样设有输入预算：每个专家最多传入 30 条 Finding，长文本和证据摘要做限长处理，并记录 `aggregator_context_bounded` Trace。每条 Finding 在汇总输入里获得一个稳定的 `ref`（形如 `logic#2`），汇总方案只能引用这些 ref；模型引用了不存在的 ref、或把所有 Finding 都丢掉时会被工具拒绝并要求重新提交。保留决定记录在 `aggregator_merge_plan` Trace 中，可审计去重结果。

## 模块结构

```
src/
  commands.ts        预批准命令目录：命令字符串 -> 固定 file/args 的唯一来源
  config.ts          config/ 的门面：默认值、操作者配置、仓库配置
  review.ts          review/ 的门面：主流程 service 与生命周期 lifecycle
  report.ts          report/ 的门面：validate / recommend / markdown / write
  eval.ts            eval/ 的门面：types / score / run
  agent/             Agent 编排：contracts / orchestrator / specialist / aggregator / session / prompts / telemetry
  tools/             受控工具：context / review（submit 工具与校验）/ schema / diagnostic
  policy.ts          路径与命令策略、脱敏、错误消息归一化
```

分层原则：`tools` 和 `agent` 只消费已校验的输入；权限、预算和确定性结论都在 service / report 层落地，模型只能提供证据。

## 安装

要求 Node.js 20+，并且已配置 Pi 可用的模型认证。

```bash
npm install
npm run build
```

## 使用

在目标仓库中初始化配置：

```bash
repo-sentinel init --repo /path/to/project
```

预览 Git 变更和检查计划，不调用模型：

```bash
repo-sentinel review --repo /path/to/project --base main --dry-run
```

运行实际审查：

```bash
repo-sentinel review --repo /path/to/project --base main
```

如果确认检查当前提交且工作区存在未提交文件：

```bash
repo-sentinel review --repo /path/to/project --base main --allow-dirty
```

检查 Pi Provider 能否完成自定义工具调用，并验证操作者配置里的模型是否可用：

```bash
repo-sentinel diagnose --repo /path/to/project
```

输出中会带 `operatorConfigPath`，可以确认本次用的是哪份操作者配置。

`diagnose` 复用与 review 相同的配置和模型，因此它通过就说明 review 的模型链路是通的。

报告默认写入目标仓库的 `.repo-sentinel/runs/<run-id>/`。

仓库提供只读 GitHub Actions 示例 `.github/workflows/repo-sentinel.yml`：它构建项目、运行 review 并上传完整报告 artifact。真实 Agent 运行仍需要在仓库或组织中配置 Pi Provider 的认证；工作流不会自动评论、提交、推送或修改 PR。

## 配置

配置文件为目标仓库下的 `.repo-sentinel/config.json`。检查命令必须使用 MVP 支持的预定义 npm 命令。默认不允许 Shell 管道、重定向、命令替换或网络工具。检查摘要会脱敏 token、密码、Bearer 凭据和 PEM 私钥。

多 Agent 运行参数位于 `review`：`maxParallelAgents`（默认 4；Provider 有限流或串行化流式请求时调到 1）、`maxSpecialistSeconds`（默认 300）和 `maxAggregatorSeconds`（默认 180）分别限制并发数、单个专家和汇总 Agent 的运行时间；`maxAgentTurns`（默认 40）仍限制每个 Session 的轮次；它既要和 `maxDiffBytes` 与分页上限匹配，也取决于所选模型的话多少——实测同样 diff 下 flash 的工具调用次数约为 pro 的两倍，换模型后应重新核对。

`review.model` 已废弃：模型现在只从操作者配置读取，写在仓库配置里不会被使用（见下一节）。

资源边界也由配置校验强制限制：`maxChangedFiles` 不超过 1,000，`maxDiffBytes` 和 `commandPolicy.maxOutputBytes` 各不超过 5,000,000，所有限制必须是有限正数。

### 操作者配置（模型与 Agent 提示词）

模型和每个 Agent 的提示词**不在仓库配置里**，而在仓库之外的操作者配置中：

- 默认路径：`~/.pi/agent/repo-sentinel.json`
- 环境变量：`REPO_SENTINEL_OPERATOR_CONFIG`
- 命令行：`--operator-config <path>`（优先级最高）

```json
{
  "version": 1,
  "model": "deepseek/deepseek-v4-flash",
  "thinkingLevel": "low",
  "rolePrompts": {
    "logic": "你是一名资深后端工程师，重点关注业务逻辑、边界条件与潜在回归。"
  },
  "aggregatorPrompt": "你是 RepoSentinel 的汇总 Agent。"
}
```

- `model`：支持 `provider/modelId`，也可带 `:high` 之类的档位后缀；档位优先级为「引用里的档位 > `thinkingLevel` > 内置默认」。模型必须在 Pi 中已配置认证（`~/.pi/agent/auth.json`），解析失败会直接终止本次审查并写入报告。
- `rolePrompts`：按**角色 ID** 替换专家的前段提示词（角色 ID 来自仓库配置的 `review.roles[].id`）。
- `aggregatorPrompt`：替换汇总 Agent 的前段提示词。
- 文件不存在时回退到内置默认，开箱即用仍然成立。

**为什么放在仓库之外**：仓库内的 `.repo-sentinel/config.json` 随 PR 一起变更，如果模型写在那里，就等于让被审查对象自己决定审查成本和代码会被送到哪个端点。把 `model` 写进仓库配置也不会被读取（有测试锁定这个行为）。

**强制契约不可覆盖**：提示词只能替换前段（身份、职责、审查方法论）。必须调用 `submit_review` / `submit_merge_plan`、证据类型与严重等级取值、允许定位的变更文件路径、禁用 shell 这些尾部约束始终由代码追加，配置无权删除——否则 Agent 不会再提交结构化结果，流水线直接失效。

实际使用的 `provider/modelId`、思考档位和 `operatorConfigPath` 记录在 `run.json`，`trace.jsonl` 的 `agent_model_resolved` 事件会同时记录角色提示词覆盖了哪些 Agent。

专家角色通过 `review.roles` 配置。每个角色包含唯一的 `id`、职责提示词 `instructions` 和 `enabled` 开关，支持在不改代码的情况下增删领域专家；角色数限制为 1-8，至少启用一个角色。每次运行的 `trace.jsonl` 会记录角色列表、成功/失败数量、并发上限和专家阶段耗时。

上游模型服务会接收 Agent 运行所需的代码上下文。使用私有仓库前，请确认组织的数据处理和模型服务政策，不要将未经授权的代码发送给第三方服务。

## 测试

```bash
npm run build
npm test
```

测试包含 Pi Faux Provider 的本地集成场景：真实 `ModelRuntime`、Agent Session 和 Tool Calling 会完成两轮模型调用，并验证 `message_end` usage 与最终 `agent_settled` 事件。该测试不访问网络，也不代表真实 Provider 的 HTTP 行为。
