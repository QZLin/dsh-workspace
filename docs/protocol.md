# Workspace IPC 协议 v1

传输是 UTF-8 **NDJSON / JSON-RPC 2.0**：每个请求和响应各占一行，以 LF 结束，接收端也接受 CRLF。JSON 字符串内的换行必须转义；跨多次 write、跨多字节 UTF-8 边界不会改变消息含义。每行最多一个对象，不支持数组 batch。没有 `id` 的合法请求为 notification，执行但不返回任何成功或错误响应。

```json
{"jsonrpc":"2.0","id":"a1","method":"workspace.add","params":{"path":"/absolute/existing/project","title":"Project"}}
{"jsonrpc":"2.0","id":"a1","result":{"id":"workspace-id","path":"/canonical/project","title":"Project"}}
```

```json
{"jsonrpc":"2.0","id":"a2","error":{"code":-32001,"message":"Workspace path is not fully qualified: 'relative'","data":{"name":"TypeError"}}}
```

合法 id 为 string、有限 number（允许小数）或 `null`。成功和错误必须二选一，响应原样对应请求 id。独立 CLI 每次连接只发送一条带随机 string id 的请求，并严格校验响应。它不重新发送请求，不扫描其他端点，不启动 DSH。

没有换行结束的请求不会执行业务方法。Unix 半关闭可返回 `-32700`；Windows named pipe 的对端关写可能同时完全关闭管道，因此 EOF 后只能无输出关闭（回复可能失败为 EPIPE）。CLI 始终写 LF 并保持连接读取响应，不依赖半关闭。

## 方法

参数必须为对象；省略参数等同于 `{}`，`null` / 数组不合法。额外的业务参数也拒绝。除列出的可选字段外，字段必须为 string，字符串内容原样传到 registry，**不存在客户端路径预校验或规范化**。

| 方法 | 参数 | 结果 | registry 调用 |
| --- | --- | --- | --- |
| `workspace.add` | `{path,title?}` | `{id,path,title}` | `create(path,title?)` |
| `workspace.list` | `{}` | `[{id,path,title}]` | `list()` |
| `workspace.get` | `{id}` | `{id,path,title,createdAt,updatedAt,sessionIds}` | `get(id)` |
| `workspace.rename` | `{id,title}` | `{id,path,title}` | `get(id).setTitle(title)`，同标题跳过写入 |
| `workspace.remove` | `{id}` | `{id,deleted:boolean}` | `delete(id)` |
| `workspace.move` | `{id,beforeId?}` | `{order:[id]}` | `insertBefore(id,beforeId?)` |
| `workspace.resolve` | `{path}` | `{id,path,title}` 或 `null` | `resolveByPath(path)` |
| `workspace.status` | `{id}` | `{id,status:'ok'\|'missing-dir'}` | `get(id).status()` |
| `workspace.ping` | `{}` | `{service:'dsh-workspace',protocolVersion:1,profile:string\|null}` | 无业务修改 |

`createdAt/updatedAt` 是 ISO 8601 string；`sessionIds` 是只读投影的拷贝。`get/rename/status` 未知 id 报 `-32004`；`remove` 未知 id 返回 `false`，是幂等 no-op；移动未知源或锚点由 registry 拒绝。

**工作区权限/合法性由 registry 持有。** `create()` 验证 fully qualified 现存目录，并通过 realpath 维护唯一身份。插件不创建缺失目录、猜测相对路径、访问 registry 的内部存储或提供任意方法反射。重复添加不改 title；移除后再添加会创建新身份。

## 错误

| JSON-RPC code | 含义 |
| --- | --- |
| `-32700` | 无法解析 UTF-8 JSON / 未以换行结束的残缺帧 |
| `-32600` | 非法 envelope、非法 id、非 2.0、batch 等 |
| `-32601` | 未知方法 |
| `-32602` | 参数形状、必需字段类型、未知字段错误 |
| `-32603` | 序列化或分帧内部错误 |
| `-32001` | registry 的业务/存储失败；消息保留，`data` 仅包含安全的 error name / code，不发 stack |
| `-32004` | 工作区或排序锚点不存在 |
| `-32005` | 帧过大、请求队列已满、响应过大 |
| `-32006` | listener dispose 中，已排队但未执行的请求被拒绝 |

畸形 JSON 无法恢复 id 时用 `id:null`。合法 notification 的方法、参数或业务失败均不返回响应；非法 envelope 不视为 notification。CLI 所用退出码与 JSON-RPC code 是不同层次：见 [使用说明](../README.md#超时输出与退出码)。

## 资源限制

默认值定义于 [分帧与分发模块](../src/rpc.js) 与 [服务实现](../src/server.js)：

- 请求 JSON 帧最多 **64 KiB**，响应 JSON 帧最多 **8 MiB**；LF / 单个尾随 CR 不计入 payload。
- 最多 **32** 连接、全局 **128** 待处理请求、每连接 **16** 请求。
- 响应输出缓冲有独立上限，慢读客户端不能无限累积 JSON。
- 空闲连接 **30 s** 关闭；stale 检查 **250 ms**，任何超时/权限错误都不是可删除监听者的证明。
- 请求过大/排队溢出：返回 `-32005` 后关闭连接，过大帧不执行业务方法。
- 响应过大：返回与原 id 对应的 `-32005`，可继续使用连接。若连错误 envelope 都放不下，直接关闭，不违反配置的响应上限。
- 客户端总 deadline 默认 **5 s**。写请求后断开或超时是结果未知，不证明操作未提交。

IPC 调用经短有界队列序列化，registry 自身仍是唯一的持久化与业务幂等性保证。收到合法完整请求后即可能被接受；关闭客户端不等于撤销请求。服务不会重放、回滚或尝试停止 registry 已在执行的修改。服务 dispose 不再开始排队操作，并释放所有 IPC 句柄。

## 生命周期与 Unix 公共名称

[插件入口](../index.js) 使用 `ctx.effect()` 管理监听器，并硬注入 `workspaceRegistry`。启动流程不使用 DSH CLI，不创建另一份 profile。

Unix 公共路径默认 `~/.dsh/.dsh-workspace.sock`，以 0600 提供。实际 bind 在同目录随机 **0700 私有目录**的 `s` socket，公共路径用 `link()` 在 chmod0600 后原子发布（不会覆盖已存在的入口）。该策略避免 [libuv `uv__pipe_close` 无条件 unlink bind 路径](https://raw.githubusercontent.com/libuv/libuv/v1.x/src/unix/pipe.c) 删除被外部替换的公共文件：服务只自动清理其私有地址，公共 socket 按 uid/dev/ino 验证后清理。普通文件、symlink、其他所有者和活跃 socket 都不被当成 stale 文件回收。私有目录确保 chmod 前也不可被其他账户访问，**不修改进程级 umask**；已有目录权限不被扩展。dispose 只清理自身 inode 和空的私有目录，不递归删除外来文件。

Windows 使用本机 named pipe，不创建或删除 socket 文件，不启用扩大 ACL 的 readableAll/writableAll。默认 pipe 由 DSH home 派生，`DSH_WORKSPACE_PIPE` 可以覆盖。客户端与 Host 必须共享同一端点配置；两个 active profile 不能共享一个默认监听者，第二个会明确失败，不夺取第一份 registry。
