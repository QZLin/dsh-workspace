# DSH 工作区 IPC / dsh-workspace

两个相互独立的组件：

- **Host 插件 `dsh-workspace-ipc`**：在已经运行的 DSH profile 内监听本地 IPC，通过 `ctx.workspaceRegistry` 管理工作区；不另开 DSH，不直接读写工作区注册表。
- **原生 CLI `dsh-workspace`**：Go 编译的独立可执行文件。运行时不需要 Node、Go 或 DSH CLI；只连接约定的 socket / 命名管道，不启动、扫描或切换 profile。

## 安装与编译

### Host 插件

通过当前 DSH 的插件管理器安装本项目目录或打包的 npm bundle，启用后在当前 Host 生效。不要通过另一个 `dsh --profile ...` 命令启动服务。

本包的 [安装补丁](cordis.patch.yml) 仅插入 `workspace-ipc` 一行；[插件入口](index.js) 明确声明 `inject: ['workspaceRegistry']`。当前 profile 必须已经提供该服务；插件不会为了满足依赖自行创建新的 profile 或启动另一个 registry。

本地目录安装是链接安装，必须保留该目录。分发时可以使用 `npm pack` 生成不可变的 bundle。Host 插件只有 Node 内建模块依赖，没有安装脚本。

### 原生 CLI

开发时需要 Go 1.22+ 和 Node 22+（Node 仅用于构建脚本/Host），Windows 命名管道使用 `go-winio`，依赖固定在 [Go 模块清单](cli/go.mod) 与 [依赖校验文件](cli/go.sum)。

```sh
# 当前系统的独立二进制
npm run build:cli

# Windows/Linux/macOS，各 amd64 和 arm64 的分发二进制
npm run build:cli -- --all
```

本机构建输出到 `dist/dsh-workspace`，Windows 输出 `dist/dsh-workspace.exe`。全平台输出到 `dist/<GOOS>-<GOARCH>/`，同时生成 SHA-256 校验列表。直接运行，或将对应二进制放入已有 PATH 目录；项目不会擅自改全局 PATH。

```powershell
# Windows：仅给当前 PowerShell 会话添加命令，不修改系统环境
$env:PATH = "$PWD\dist;$env:PATH"
dsh-workspace ping
dsh-workspace list
```

```sh
# Unix：将编译得到的二进制安装到自己的命令目录
install -m 0755 dist/dsh-workspace "$HOME/.local/bin/dsh-workspace"
dsh-workspace list
```

## 命令

| 命令 | 行为 |
| --- | --- |
| `add <path> [--title <title>]` | 注册现有目录；返回 `{id,path,title}`；重复添加复用原 id，**不改原标题** |
| `list` | 按 registry 的持久化展示顺序列出工作区 |
| `get <id>` | 获取工作区与 `createdAt`、`updatedAt`、`sessionIds` |
| `rename <id> <title>` | 改显示标题；重复同标题不写入、不改变 `updatedAt` |
| `remove <id>` | **只删除注册**；保留目录、文件和所有会话日志；未知 id 返回 `deleted:false`，退出 0 |
| `move <id> [--before <id>]` | 移至指定工作区之前；不提供锚点则追加到末尾 |
| `resolve <path>` | 按路径查询已有工作区，不创建；现有未注册目录返回 `null` |
| `status <id>` | 查询 `ok` / `missing-dir` |
| `ping` | 查询 IPC 服务和当前服务所属 profile 的可用名称（不可用时为 `null`） |
| `endpoint` | 离线显示将连接的端点，不发起任何请求 |

`remove` 也可写成 `delete` / `rm`。`--help` / `-h` 显示说明，`--version` / `-v` 显示版本。

```sh
dsh-workspace add /absolute/project --title "项目 A"
dsh-workspace add /absolute/project --title "不会覆盖已有标题"
dsh-workspace list --json
dsh-workspace get WORKSPACE_ID --json
dsh-workspace rename WORKSPACE_ID "新的标题"
dsh-workspace move WORKSPACE_ID --before ANOTHER_WORKSPACE_ID
dsh-workspace resolve /absolute/project --json
dsh-workspace status WORKSPACE_ID
dsh-workspace remove WORKSPACE_ID
```

Windows 示例：

```powershell
dsh-workspace add 'C:\Projects\项目 A' --title '项目 A'
dsh-workspace add 'C:\Projects\项目 A' --json
```

**业务路径永远不在客户端校验或规范化。** `add` 的参数原样送到 `ctx.workspaceRegistry.create(path, title?)`：不调用 `Abs/Clean/Stat/realpath`，不展开 `~`，不帮相对路径补当前目录。相对路径、盘符相对路径、缺失路径和普通文件都会由 DSH 拒绝，客户端以远端错误退出。`resolve` 同样原样交给 registry 的 `resolveByPath()`。如果要处理以 `-` 开头的参数，可以用 `--` 结束选项解析。

唯一允许的路径处理是 **IPC 端点 / DSH home 配置的发现**，这与业务目录路径严格分离。客户端只检查 JSON 的 UTF-8 可表示性及帧长度；无法编码的字符串以退出 2 拒绝，绝不由 JSON 编码器静默替换成其他路径。NUL 等可表示的业务字符串仍送到 registry，由它判定是否合法。

## 端点发现与 profile 绑定

优先级：

1. CLI `--endpoint <endpoint>` / 插件 `config.endpoint`。
2. Windows 环境变量 `DSH_WORKSPACE_PIPE`；Unix 环境变量 `DSH_WORKSPACE_SOCKET`。
3. CLI `--dshHome <home>`（也接受 `--dsh-home`）/ 插件 `config.dshHome`，然后 `DSH_HOME`，最后当前用户的 `~/.dsh`。

空白环境变量视为未设置；显式空白配置报错。**非空配置中的空格保留**。仅传输配置展开当前用户 `~`、`~/`、`~\`，随后解析为绝对位置；不展开命名用户或任意环境变量表达式。端点覆盖生效时，`--dshHome` 不会覆盖它。

Unix 默认：

```text
~/.dsh/.dsh-workspace.sock
$DSH_HOME/.dsh-workspace.sock
```

Windows 默认：

```text
\\.\pipe\dsh-workspace-<24 位 SHA-256 十六进制前缀>
```

哈希输入是解析后的绝对 DSH home：Windows 分隔符、去掉所有末尾 `\`、只将 ASCII `A-Z` 变小写。相同 home 使用相同 pipe；不同 home 隔离端点。覆盖必须是完整的 **本机** `\\.\pipe\NAME`，不接受远程命名管道或 TCP 地址。`--pipe` / `--socket` 可作为 `--endpoint` 的平台相关别名。

```powershell
# 服务和客户端都必须使用相同配置；服务环境在启动当前 Host 前设置
$env:DSH_WORKSPACE_PIPE = '\\.\pipe\my-current-dsh-workspace'
dsh-workspace endpoint
dsh-workspace list --timeout 5000 --json
```

```sh
DSH_HOME=/data/dsh dsh-workspace list
# 或直接指定端点，仅选择连接目标，不启动任何进程
dsh-workspace list --endpoint /data/dsh/.dsh-workspace.sock
```

**一个默认端点只能有一个监听者。** 若两个 profile 同时运行且使用相同 home，第二个监听者会报端点占用，而不是抢走第一份 registry。多个运行实例需在各自 Host 与对应客户端配置不同的显式端点。CLI 忽略 `DSH_PROFILE` 对目标的选择，不扫描 profiles、不自动回退至另一份 registry；它只作用于所连端点的当前运行实例。`ping` 可核对该实例的 profile 信息。

## 超时、输出与退出码

`--timeout <正整数毫秒>` 默认 **5000 ms**，覆盖连接、写请求、读响应的同一次总截止时间。成功结果输出到 stdout；`--json` 仅输出 JSON 结果，诊断写 stderr。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功，包括重复添加、移除未知 id、未注册路径查询结果 `null` |
| 1 | 远端 JSON-RPC / workspaceRegistry 拒绝 |
| 2 | 命令行参数或端点配置错误 |
| 3 | 连接失败 / IO 断开 |
| 4 | 超时 |
| 5 | 响应协议错误（畸形 JSON、错误 id、非法响应等） |

**写出请求后超时或断开，并不代表操作没有提交。** DSH 可能已经完成注册或其他修改。CLI 不会重连后重发任何请求；请先用 `list/get/resolve` 查状态，再由调用者决定下一步。删除注册后重新 `add` 是新的工作区身份，不属于重复 `add` 的幂等保证。

## 安全与生命周期

- 只监听 Unix domain socket / 本机 Windows named pipe，不开 HTTP/TCP 端口。
- Unix socket 为 **0600**，新建端点父目录请求 **0700**；已有目录权限不被扩大或擅自改动。
- Windows 不开启 `readableAll/writableAll`，使用进程 token 默认命名管道 ACL；同一账户内此 IPC 是有权限的管理接口，不提供跨用户授权服务。
- 活跃端点不会被删除；Unix 只回收已证明拒绝连接、归当前用户且 inode 未变化的 stale socket，拒绝替换普通文件、目录、symlink 或其他用户的 socket。
- Unix 内部使用同目录 **0700 随机私有目录中的 socket**，在 chmod0600 后原子发布硬链接作为公共端点，不修改进程级 umask。这样 libuv 关闭时只自动清理私有名称；插件按 inode 清理公共 socket，不删除被替换的公共文件。正常 dispose 清理两者及空私有目录；stale 恢复也清理同 inode 的旧私有别名。
- Host 的 `ctx.effect` 负责 dispose：停止接收、关闭现有连接、释放监听器、清理自己拥有的 socket；重复 dispose 无副作用。已经执行的 registry 操作不能回滚或自动重放。
- 限制请求 64 KiB、响应 8 MiB、连接数、待处理请求和响应缓冲；空闲连接 30 秒关闭。协议详情见 [JSON-RPC 协议](docs/protocol.md)。

请保持 DSH home 和端点父目录为可信、当前用户控制的位置；不要把这个有修改权限的接口暴露给不可信账户。Unix 长 socket 路径有操作系统长度上限（macOS 103、Linux 107 UTF-8 字节），必要时使用更短的显式端点。

## 开发与验证

```sh
npm run check
npm test
go -C cli test ./...
npm run build:cli

# 必须已在当前运行 profile 安装插件；仅对 CLI 进行实际连接测试
node scripts/verify-live.mjs

npm pack --dry-run
```

[Node 测试](test) 不启动 DSH，用注入的 registry double 和真实本地 IPC 测试协议、路径保真、幂等、错误、限流与 dispose。[Go 测试](cli) 验证独立 CLI 的参数、端点、IO、超时、协议与退出码。[跨平台 CI](.github/workflows/test.yml) 覆盖 Windows/macOS/Linux 与 Node 22/24；非 Unix 机器会明确跳过 chmod/stale/hardlink 的实机 Unix 测试，不把跳过写成通过。

[实际验证脚本](scripts/verify-live.mjs) 保存当前注册顺序，创建一个独立临时测试目录，检查 CLI 增查改序删和错误，再只移除它自己创建的工作区注册，并核对原注册列表完全恢复。它不创建 DSH profile，不删除真实项目目录或会话。连接不确定时不重试修改；会报告需要人工核对的测试 id。

源码与原创图标均按 [MIT 许可证](LICENSE) 提供。
