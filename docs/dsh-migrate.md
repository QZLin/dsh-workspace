# 自动适配 DSH 版本（dsh-migrate-bot v3，无 LLM）

本项目使用 [QZLin/dsh-migrate-bot v3](https://github.com/QZLin/dsh-migrate-bot/tree/v3) 的标准 `bump` / state / proposal 流程，引用为 `QZLin/dsh-migrate-bot@v3`（当前指向 `v3.0.3` / `4d304388ccdd0e26ddacc92a3fd52e39517a6695`）。v3 是 composite Action：它不调用模型、不启动 agent session、不修复源码，也不依赖容器镜像。

**迁移配置内联在[工作流](../.github/workflows/dsh-migrate.yml)里，仓库不再保留单独的配置文件。** 工作流先用 heredoc 把配置写进 `.tmp/dsh-migrate-config.yml`，再用 `config:` 把该路径交给 Action；`.tmp/` 已被 Git 忽略，因此这份配置不会被 v3 提交进 proposal 分支。

## 自动运行

[工作流](../.github/workflows/dsh-migrate.yml)在默认分支上：

- **仅手动触发**：GitHub Actions 的 **dsh-migrate → Run workflow**。定时 `schedule` 目前在工作流中注释掉，需要恢复时取消注释即可。
- `dsh_release` 留空时使用内联配置中的 `target: latest`，也可填写 `0.2.2-rc.1` 或 `dsh-v0.2.2-rc.1`。
- `latest` 按 semver 选择最大的 `dsh-v*` 标签，包括 alpha / rc 等预发布版本。
- `bump_again: true` 可重新处理已记录的版本；该版本的 proposal PR 仍打开时不会覆盖它。

同一仓库的运行通过 concurrency group 串行执行，不会并发写 state 或 proposal 分支。

## 最低支持范围

[包清单](../package.json)同时用 `engines.dsh` 和 `peerDependencies` 声明 DSH 兼容范围，两者的范围必须一致：

```json
"engines": {
  "dsh": ">=0.2.0 <0.3.0"
},
"peerDependencies": {
  "@deepseek-ai/dsh-workspace": ">=0.2.0 <0.3.0"
},
"peerDependenciesMeta": {
  "@deepseek-ai/dsh-workspace": { "optional": true }
}
```

- `engines.dsh` 是宿主侧的门槛，用于判断当前 DSH 是否在支持范围内；**v3 从不改写它**。
- `peerDependencies` 指名本插件注入的 `workspaceRegistry` 由哪个包提供（`@deepseek-ai/dsh-workspace`）。`peerDependenciesMeta.optional` 让它在安装时不被自动拉取——该包是受限发布的 harness 包，应由 DSH profile 提供，而不是随插件安装。
- `>=0.2.0` 是项目声明的最低支持版本，自动迁移**不得提高这个下限**；是否放弃旧版支持或扩大上界由维护者根据实际验证结果决定。

v3 对 `@deepseek-ai/dsh-*` 包的更新策略与上面一致：

- `peerDependencies`、`dependencies`、`optionalDependencies` 保留原下限；当前范围不包含目标版本时才追加 `|| ^<target>` 兼容分支。
- `devDependencies` 移到目标版本。
- 本项目设置 `bump.ownVersion: false`，因此不会自动提高插件自身版本。

所以目标版本超出当前范围时，proposal 只会在 `peerDependencies` 上追加分支，`engines.dsh` 保持原样。若目标版本不能实际加载，检查失败，不会自动放宽任何范围。

## state、proposal 与 PR

v3 将持久状态写入 `dsh-migrate/state`，每次迁移一份事件日志，并生成 `badge.json`。该分支只用于 bot 状态，不应合并到默认分支。

- 工作树没有变化且全部检查通过：迁移结束为 `compatible`，目标版本直接记为已验证。
- 有变化且检查通过：更新 `dsh-migrate/proposal` 并创建或更新可审阅的 PR。
- 有变化但检查失败：仍发布同一 proposal，但 PR 为 draft，并附上失败信息；bot 不尝试修复。
- 没有变化且检查失败：任务失败，没有可提交的 proposal。
- proposal 合并后对应版本才记为已验证；关闭但不合并则不验证。

新版本通常复用同一个 proposal、Issue 和 PR，而不是不断新建。若维护者已在 proposal 分支追加提交，v3 不会强制覆盖这些提交。

## 项目专用检查

工作流内联的迁移配置用以下命令替换 v3 的默认 mechanical suite，任一失败都会停止迁移：

1. `npm run check`
2. `npm test`
3. `go -C cli test ./...`
4. 编译 Linux 静态原生 CLI 到 `.tmp/dsh-workspace-probe`
5. 运行[真实 Web Host 探针](../scripts/check-dsh-host.mjs)

本插件的硬依赖 `workspaceRegistry` 来自 DSH Web composition（由 `@deepseek-ai/dsh-workspace` 提供）。v3 的内置 headless boot profile 不提供该服务，而本插件又没有 `dsh.client` 浏览器入口，因此配置关闭内置 `boot` / `web` 检查，改用必须成功的项目专用探针：

- 从固定的 v3 Action checkout 导入 `ensureDsh` 与 `startWebHost`。
- 安装并启动本次迁移已解析出的目标 DSH，在真实 Web profile 中加载插件。
- 等待 Web server-ready 后，通过刚编译的独立原生 CLI 执行只读 `ping`。
- 同时校验 IPC 服务名 `dsh-workspace` 与协议版本 `1`；只有 Web 启动和 IPC 身份都正确才通过。

探针不打开浏览器。它使用占位 API key 和不可用的本地模型端点，只验证 composition 与插件激活，不会发送真实模型请求。v3 在运行 mechanical 命令前也会移除 Action 持有的凭证。

## 权限与仓库设置

不需要 DeepSeek API key、模型余额或任何 LLM secret。工作流只把 GitHub 自动生成的 `GITHUB_TOKEN` 交给 v3，并申请：

- `contents: write`：写 state / proposal 分支；
- `issues: write`：创建或更新迁移 Issue；
- `pull-requests: write`：创建、更新以及切换 proposal PR 的 draft 状态。

仓库需在 **Settings → Actions → General → Workflow permissions** 中启用 **Allow GitHub Actions to create and approve pull requests**，否则 proposal 分支和 Issue 可能已经写入，但创建 PR 会返回 HTTP 403。

## 失败与诊断

v3 在第一个失败检查处停止，不重试、不调用 LLM、不改插件源码。摘要和 proposal 会保留有界的错误片段；完整检查日志同时上传为 `dsh-migrate-check-logs` artifact，保留 7 天。Web 启动 URL 中的会话 token 在落盘前会被清除。

## 本地验证

```sh
npm run check
npm test
go -C cli test ./...
node --check scripts/check-dsh-host.mjs
```

完整目标 DSH 的 Web Host / IPC 检查需要 v3 Action 提供已编译的检查模块和目标版本环境变量，正常由 GitHub 的 Linux runner 执行，不会启动或修改本机当前的 DSH profile。

[回归测试](../test/dsh-migrate.test.mjs)覆盖 v3 工作流约束、内联配置的键与检查命令、`engines.dsh` 与 `peerDependencies` 的一致性、`>=0.2.0` 下限保持，以及 Web profile 与 IPC 握手的失败路径。升级 bot 本身时需重新核对 v3 schema、`@v3` 指向的版本与这些项目专用导入路径。
