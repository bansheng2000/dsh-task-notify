# dsh-task-notify

任务完成 / 失败 / 取消时，通过 `@xmanrui/dsh-im` 推一条微信通知。

- **判定来源**：事件订阅 `session/event` 的 `turn/end`，零轮询，**覆盖全部工作区的全部会话**。
- **投递通道**：复用 dsh-im 已有的渠道配置与发送逻辑（`ctx.dshIm.send`），不新建任何通道。
- **文案**：单行极简，失败 / 取消追加原因短语。
- **未绑定**：跳过 + 记日志 + 计数，不报错打断监听。
- **去重**：会话级——同一 `sessionId` + 同一结束原因只推一次。

## 通知长什么样

```
✅ 任务完成 | task-notify | 工作区 ziyongchajian | 会话 6f2292c8-6b95-4d3d-ae8c-f73da0d9ad9e
❌ 任务失败 | task-notify | 工作区 default-workspace | 会话 b2d7c70c-... | 502 bad gateway
⚠️ 任务已取消 | task-notify | 工作区 ziyongchajian | 会话 6f2292c8-... | 用户主动终止
```

| 结束原因（`turn/end` 的 `reason.kind`） | 前缀 | 追加短语 |
| --- | --- | --- |
| `completed` | ✅ 任务完成 | 无 |
| `error` | ❌ 任务失败 | `error.message` / `error.code` |
| `aborted` | ⚠️ 任务已取消 | cause：用户主动终止 / 上级会话取消 / 插件中断 / 会话释放 / 未知 |
| `blocked` | ⛔ 任务被拦截 | 无 |
| `max-tokens` | ⚠️ 任务中断（超出最大长度） | 无 |
| `interrupted` | ⚠️ 任务中断 | 无 |
| `forked` | 🔀 任务已分叉 | 无 |

## 配置

插件不调 `ctx.settings.register()`，直接导出 `Config`；配置写在 loader 条目 `task-notify` 的 `config.rules` 下（见 `cordis.patch.yml`），也可被设置卡片覆盖。

```yaml
config:
  rules:
    enabled: true          # 总开关
    channel: weixin        # 只对 listBots() 里这个 channel 的机器人生效
    format: plain          # plain | markdown
    skipSubagents: true    # 只报顶层任务，subagent 的轮次结束不推
    target:                # 默认投递目标；botId / targetId 任一为空 = 未绑定
      botId: "wx_0123456789abcdef01234567"
      targetId: "tgt_1a2b3c4d5e6f7890"
    workspaces:            # 按工作区覆盖目标，键为完整 cwd 或工作区目录名
      ziyongchajian:
        botId: "wx_0123456789abcdef01234567"
        targetId: "tgt_1a2b3c4d5e6f7890"
      "E:/文档/deepseek-harness/default-workspace":
        botId: "wx_0123456789abcdef01234567"
        targetId: "tgt_1a2b3c4d5e6f7890"
```

### 工作区与微信账号的关联方式

dsh-im **没有**对外暴露「工作区 → botId」的查询接口（`bot-workspace-store.mjs` 不在包的 `exports` 里），所以关联关系由本插件配置显式声明，匹配顺序：

1. `workspaces` 里键 === `session.header.cwd`（完整路径）
2. `workspaces` 里键 === cwd 的目录名（如 `ziyongchajian`）
3. `target`（默认目标）

**botId / targetId 从哪来**：在 dsh-im 的微信设置里配好机器人与接收目标后，从 dsh-im 的目标列表取 `botId`（形如 `wx_` + 24 位十六进制）与 `targetId`（形如 `tgt_` + 16 位十六进制）。

## 安装

前提：本机已装 `@xmanrui/dsh-im`（本插件 `inject: ["dshIm"]`，没有它会跳过并在日志里说明）。

1. 在 DSH profile 的 `package.json` 里加依赖与 bundle：

```jsonc
{
  "dsh": { "profile": { "bundles": ["...", "dsh-task-notify"] } },
  "dependencies": {
    "dsh-task-notify": "file:E:/文档/deepseek-harness/dsh-task-notify"
  }
}
```

> 路径必须是**绝对正斜杠**路径。相对路径会报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`。

2. 重装依赖（pnpm 装进 profile 的是**真实拷贝**，改了 repo 文件必须重跑）：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "F:\Programs\DeepSeek Harness\DeepSeek Harness.exe" `
  "F:\Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.mjs" `
  --dir "C:\Users\12576\.dsh\profiles\desktop" install `
  --config.minimumReleaseAge=0
```

3. 重启 DSH。

bundle 自带的 `cordis.patch.yml` 用 `- insert:` 创建 loader 条目，**不要**手改成顶层扁平 `- id:`——扁平形态只会改已有条目，条目不存在时静默空操作，插件永不挂载。

## 验证

```powershell
# 1) 插件自检（不依赖 DSH 宿主）
cd E:\文档\deepseek-harness\dsh-task-notify
& "F:\Programs\DeepSeek Harness\DeepSeek Harness.exe" test\selftest.mjs
# 期望：dsh-task-notify selftest: ok

# 2) 确认已挂载：apply() 跑了才会注册状态路由
curl http://127.0.0.1:19387/_task-notify/status
```

状态路由返回当前生效配置与计数：

```json
{
  "ok": true, "active": true, "channel": "weixin",
  "defaultTarget": { "botId": "wx_...", "targetId": "tgt_..." },
  "workspaces": {}, "skipSubagents": true,
  "dshImInstalled": true,
  "seen": 12, "notified": 3, "failed": 0, "skippedUnbound": 9, "deduped": 1,
  "last": { "sessionId": "...", "reason": "completed", "at": "..." }
}
```

## 常见问题排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `/_task-notify/status` 返回 404 | `apply()` 没跑：包没进 profile、bundles 没加、或 patch 写成了顶层扁平 `- id:`。查 plugin manager 的 `list_plugins`，应有 `include:task-notify` + `fiberPhase: active`。 |
| `skippedUnbound` 一直涨 | 没配 `target`/`workspaces`，或 botId/targetId 有一项为空 → 判定为未绑定跳过。填上 dsh-im 里的 botId + targetId。 |
| `skippedUnbound` 涨且日志有 `not connected` | dsh-im 的微信机器人没连上（`dshIm.listBots()` 里没有这个 botId，或 channel 不是 `weixin`）。去 dsh-im 里连机器人。 |
| `notified` 涨但微信没收到 | `{sent:true}` 只代表平台接口接受，不代表送达。微信主动投递还需要用户消息里携带过的 `context_token`；先给机器人发一条微信消息再触发。 |
| `failed` 涨 | 看日志里的 `send not accepted: ...` / `send failed: ...`，dsh-im 会带 `code`（`bot-not-connected` / `target-rejected` / `delivery-failed` 等）。 |
| 通知太吵 | `skipSubagents: true` 过滤 subagent；同会话同原因本来就只推一次。fork / 多轮会推多条，确需收敛可把去重键加上 turn。 |
| 某个工作区没通知、别的有 | 检查 `workspaces` 的键：先按完整 `cwd` 匹配、再按目录名匹配，两者都没命中才回落默认 `target`。 |
| 改了 repo 代码但行为没变 | pnpm 装进 profile 的是真实拷贝。重新跑上面的 install，或直接改 `node_modules\dsh-task-notify\lib\index.js`。 |

## 文件

```
lib/index.js       插件本体（Config / apply / 文案 / 去重 / 状态路由）
cordis.patch.yml   bundle patch（- insert: 创建 loader 条目 + 默认配置示例）
package.json       main=lib/index.js, dsh.bundle.patch=cordis.patch.yml
README.md          本文件
test/selftest.mjs  自检（21 项断言）
```
