# 自动适配 DSH 版本（无 LLM）

本项目使用 [dsh-migrate-bot v1.0.0-rc.4](https://github.com/royenheart/dsh-migrate-bot/releases/tag/v1.0.0-rc.4) 的官方 `check` 入口，配合本仓库的确定性版本更新脚本。**不调用 `run`，不启动 agent session，不用 LLM 审查或修复升级错误。** 上游 `run` 入口会在开始时要求 DeepSeek API key，且 `repair.maxAttempts` 最小为 1，因此不能把它配置成零次修复来实现无 LLM。

## 自动运行

[工作流](../.github/workflows/dsh-migrate.yml)在默认分支运行：

- 每天 **03:00 UTC（北京时间 11:00）**检查新版本。
- GitHub Actions 的 **dsh-migrate → Run workflow** 可手动触发。
- 修改工作流、[bot 配置](../.github/dsh-migrate.yml)、[更新脚本](../scripts/dsh-migrate.mjs)或[回归测试](../test/dsh-migrate.test.mjs)并推送到 `main` 时，自动验证一次。
- `dsh_release` 留空使用 `latest`，也接受 `0.2.2-rc.1` 或 `dsh-v0.2.2-rc.1`。
- `migrate_again: true` 只重新检查当前版本；不会降级，也不会触发修复。

`latest` 与 bot 的策略一致：按 semver 选择上游最大的 `dsh-v*` 标签，**包括 alpha / rc 等预发布版本**，不是只选择 GitHub 标记为 stable 的 release。

## 更新内容与安全边界

[更新脚本](../scripts/dsh-migrate.mjs)只更新[包清单](../package.json)的 `engines.dsh`：

1. 将最低适配版本提高到目标版本。
2. 保留原有上界；目标达到上界时，DSH `0.x` 使用下一个 minor 为上界，DSH `1.x+` 使用下一个 major。
3. 不改插件源码、不升插件自身的 `version`、不修改 Node / Go 依赖，也不发布 npm 包或替换本机 DSH。
4. 已处理版本默认跳过；旧版本输入明确拒绝，不能通过 `migrate_again` 绕过。

工作流分为两项任务：

- **verify（只读）**：检出默认分支的精确提交，不保留 checkout 凭证；运行 Go CLI 测试并编译静态原生 CLI，再由 bot 运行包检查和 Node 测试。[Host 启动探针](../scripts/check-dsh-host.mjs)随后使用同一固定 bot 容器的 `startWebHost` / `ensureDsh`，在目标 DSH 的真实 Web profile 中加载插件，并用原生 CLI 的只读 `ping` 确认插件已激活。Web server-ready 和正确的 IPC 服务 / 协议身份两者缺一不可；不启动浏览器，也不调用模型。
- **publish（可写）**：仅在所有检查成功且版本清单有变化时运行。下载同一次运行的清单并验证 SHA-256，只提交该清单，然后普通推送到默认分支。检查过程中默认分支若有其他提交，推送会被拒绝；不会强制覆盖，也不会在未重新检查的情况下自动 rebase。

同一仓库的工作流串行运行。发布版本清单不会再次触发自身的 `push` 条件，避免循环。

## 为什么使用真实 Web profile

插件的硬依赖 `workspaceRegistry` 由目标版本的 [Web bundle](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/bundle/web-app/cordis.patch.yml)提供。bot 的默认 headless 探针只加载 base + headless，因而会报告 `pending: workspaceRegistry`；内置 Web 检查又会跳过没有 `dsh.client` 的 Host 插件。因此[bot 配置](../.github/dsh-migrate.yml)禁用这两个不适用的内置入口，改为工作流中**必须成功的真实 Web profile + 原生 IPC 握手检查**，并非跳过插件启动验证。插件源码及其注入契约保持不变。

## 凭证与设置

不需要 `DEEPSEEK_API_KEY_DSH_MIGRATE_BOT`、模型余额或任何 LLM secret。GitHub 工作流只使用 GitHub 自动生成的 `GITHUB_TOKEN`：读取上游标签的任务只有 `contents: read`，发布任务单独申请 `contents: write`。本次接入使用的个人访问令牌不写入仓库、Git 配置或工作流 secret。

因为你选择**通过检查后直接提交默认分支**，不需要开启 Actions 创建 / 审批 PR 的权限。仓库需保持 Actions 可运行，并允许该工作流写入默认分支；若日后开启分支保护导致普通推送被拒绝，需按保护策略改为 PR 方式。

## 检查失败时

任何版本解析、GitHub API、Go 测试、bot 检查、清单摘要或推送错误都会使工作流失败。失败时不会发布升级，不会调用 LLM 修复；查看运行日志和 `dsh-check-logs` artifact 后由维护者处理。该 artifact 保留 7 天，包含 bot 的完整 mechanical 检查日志，以及真实 Web Host / 原生 IPC 探针能产生的诊断。

bot 的启动探针使用占位凭证和不可用的本地模型端点，目的是证明插件加载和激活，不发送实际模型请求。[官方检查实现](https://github.com/royenheart/dsh-migrate-bot/blob/v1.0.0-rc.4/src/activities/check-tree.ts)与[启动探针](https://github.com/royenheart/dsh-migrate-bot/blob/v1.0.0-rc.4/src/verify/boot.ts)说明了这一点。

这里只使用 bot 的检查能力，不使用它的 proposal / state / merge-report / preview 流程，也不创建对应状态分支。

## 本地验证

```sh
npm run check
npm test
go -C cli test ./...

# 只查看机械升级计划，不写入包清单
node scripts/dsh-migrate.mjs --target 0.2.2-rc.1 --dry-run
```

[回归测试](../test/dsh-migrate.test.mjs)覆盖预发布版本排序、分页查询、非法输入、拒绝降级、兼容上界、清单更新、dry run 和无 LLM 工作流约束。完整目标 DSH 的启动检查由 GitHub 的 Linux Docker runner 执行，不会启动或修改你的当前 DSH profile。

所有 Action 固定到已核实的提交 SHA，bot 版本固定为 `v1.0.0-rc.4`。升级 bot 本身需另行更新其 SHA 和配置；DSH 目标版本则自动跟随 `latest`。
