# RepoSentinel

RepoSentinel 是一个基于 Pi Agent SDK 的本地代码变更验证 Agent。它读取 Git 分支差异，通过受控工具执行项目检查，并生成带证据的 Markdown、JSON 和事件 Trace 报告。

## 当前状态

当前版本是本地 CLI MVP：

- 支持 Node.js / TypeScript 项目的本地 review。
- 支持测试、Lint、TypeScript 类型检查、依赖审计和构建命令。
- Agent 只能按 `checkId` 运行预先配置的检查，不接受任意 Shell 命令。
- Agent 可通过受控的 `read_file` / `search_files` 工具查看仓库源码；工具会校验仓库边界、符号链接和敏感路径。
- 必要检查在 Agent 启动前确定性执行，模型不能通过遗漏检查伪造通过结论。
- 默认使用 `deepseek/deepseek-v4-pro` 执行审查，可通过配置项 `review.model` 换成任意已认证的模型；解析失败会在创建 Session 前明确报错，不会静默回退到其他模型。
- 默认使用 4 个专业 Agent 并发分工审查逻辑、测试、安全和工程质量，再由汇总 Agent 去重；汇总 Agent 只提交“保留哪些 Finding 的引用 + 摘要”，Finding 正文由主控按引用原样搬运，因此汇总阶段既不会篡改证据，也不受重新生成正文的输出量限制；角色和并行度均可配置（默认并发 4，可用 `review.maxParallelAgents` 降到 1 回到串行以兼容不支持并发流的 Provider），每个 Agent 都有独立轮次和时间上限。
- 默认拒绝 dirty worktree、敏感路径、仓库外路径和源代码写操作。
- 结论由确定性规则重算，模型不能自行宣布通过：必需的检查未完成、或某个专家 Agent 未完成时返回 `inconclusive`（无法完成验证）；已经拿到 `high`/`critical` 且 `verified` 的证据时优先返回 `needs_changes`，避免因为专家缺失而丢掉阻断结论。
- 输出 `run.json`、`report.md`、`report.sarif`、`checks.json` 和 `trace.jsonl`；SARIF 可被 GitHub Code Scanning 等工具消费。
- `run.json` 和 Trace 汇总 Agent 轮次、工具调用、输入/输出 token、缓存 token、成本及时延；无法从 Provider 取得的 usage 按 0 记录并以 `usageAvailable`/`telemetryAvailableCases` 区分。
- 敏感路径基线（`.env`、密钥/证书和 `.git`）始终拒绝访问，`denyPathPatterns` 只能追加规则，不能清空或覆盖基线。
- 采用分层上下文：首屏只注入变更清单和限长检查摘要，Diff 通过 `get_change_context(offset, maxChars)` 分页读取；每次分块读取写入 `context_chunk_read` Trace，避免大变更一次性截断。单页上限 32,000 字符且默认用满上限，让 Agent 用尽量少的轮次读完 diff（页太小会把轮次预算耗在翻页上，而不是用于提交结论）。
- 汇总阶段同样设有输入预算：每个专家最多传入 30 条 Finding，长文本和证据摘要做限长处理，并记录 `aggregator_context_bounded` Trace。每条 Finding 在汇总输入里获得一个稳定的 `ref`（形如 `logic#2`），汇总方案只能引用这些 ref；模型引用了不存在的 ref、或把所有 Finding 都丢掉时会被工具拒绝并要求重新提交。保留决定记录在 `aggregator_merge_plan` Trace 中，可审计去重结果。

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

检查全局 Pi 配置是否支持自定义工具调用，并验证 `review.model` 指向的模型是否可用：

```bash
repo-sentinel diagnose --repo /path/to/project
```

`diagnose` 复用与 review 相同的配置和模型，因此它通过就说明 review 的模型链路是通的。

报告默认写入目标仓库的 `.repo-sentinel/runs/<run-id>/`。

仓库提供只读 GitHub Actions 示例 `.github/workflows/repo-sentinel.yml`：它构建项目、运行 review 并上传完整报告 artifact。真实 Agent 运行仍需要在仓库或组织中配置 Pi Provider 的认证；工作流不会自动评论、提交、推送或修改 PR。

## 配置

配置文件为目标仓库下的 `.repo-sentinel/config.json`。检查命令必须使用 MVP 支持的预定义 npm 命令。默认不允许 Shell 管道、重定向、命令替换或网络工具。检查摘要会脱敏 token、密码、Bearer 凭据和 PEM 私钥。

多 Agent 运行参数位于 `review`：`model`（默认 `deepseek/deepseek-v4-pro`）指定本次审查使用的模型，支持 `provider/modelId` 形式以及 `:thinkingLevel` 后缀（如 `deepseek/deepseek-v4-pro:high`）；`maxParallelAgents`（默认 4；Provider 有限流或串行化流式请求时调到 1）、`maxSpecialistSeconds`（默认 300）和 `maxAggregatorSeconds`（默认 180）分别限制并发数、单个专家和汇总 Agent 的运行时间；`maxAgentTurns`（默认 24）仍限制每个 Session 的轮次；它必须与 `maxDiffBytes` 和分页上限匹配，否则大 diff 会在读完之前耗尽轮次。

`review.model` 只接受 Pi 中已配置认证的模型（`~/.pi/agent/auth.json`）。解析失败会直接终止本次审查并写入报告，不会回退到其他模型。实际使用的 `provider/modelId` 和思考档位记录在 `run.json` 的 `agent` 字段和 `trace.jsonl` 的 `agent_model_resolved` 事件中。

资源边界也由配置校验强制限制：`maxChangedFiles` 不超过 1,000，`maxDiffBytes` 和 `commandPolicy.maxOutputBytes` 各不超过 5,000,000，所有限制必须是有限正数。

专家角色通过 `review.roles` 配置。每个角色包含唯一的 `id`、职责提示词 `instructions` 和 `enabled` 开关，支持在不改代码的情况下增删领域专家；角色数限制为 1-8，至少启用一个角色。每次运行的 `trace.jsonl` 会记录角色列表、成功/失败数量、并发上限和专家阶段耗时。

上游模型服务会接收 Agent 运行所需的代码上下文。使用私有仓库前，请确认组织的数据处理和模型服务政策，不要将未经授权的代码发送给第三方服务。

## 测试

```bash
npm run build
npm test
```

测试包含 Pi Faux Provider 的本地集成场景：真实 `ModelRuntime`、Agent Session 和 Tool Calling 会完成两轮模型调用，并验证 `message_end` usage 与最终 `agent_settled` 事件。该测试不访问网络，也不代表真实 Provider 的 HTTP 行为。
