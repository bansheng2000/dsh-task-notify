# dsh-task-notify

任务完成 / 失败 / 取消时，通过 `@xmanrui/dsh-im` 推通知，支持**多渠道、多账户**同时投递。

- **判定来源**：事件订阅 `session/event` 的 `turn/end`，零轮询，**覆盖全部工作区的全部会话**。
- **投递通道**：复用 dsh-im 已有的渠道与账户配置（`ctx.dshIm.send`），不新建任何通道。
- **多渠道**：一条通知扇出到 `targets` 列表里的每一个目标（渠道 + 账户 + 收件目标），某个目标失败不影响其它目标。
- **按通道 + 账户启停**：每个目标自带 `enabled`；`false` 只停用它，其它目标照发。状态路由顺手列出**哪些通道有账户**（`channels`）。
- **文案**：首行「状态 | task-notify | 会话标题」，正文逐行「字段: 值」；失败 / 取消补一行「原因: ...」。
- **未绑定 / 账户未连接**：跳过 + 记日志 + 计数，不报错打断监听。
- **去重**：会话级——同一 `sessionId` + 同一结束原因只推一次（整批算一次，不是每个目标一次）。

## 通知长什么样

```
✅ 任务完成 | task-notify | 任务完成通知插件对接 dsh-im
工作区: ziyongchajian

❌ 任务失败 | task-notify | prompt-optimizer 我想改一下系统提示词
工作区: default-workspace
原因: OpenCode's free tier can only be used from within OpenCode.

⚠️ 任务已取消 | task-notify | 微信文案微调
工作区: ziyongchajian
原因: 用户主动终止
```

首行第三段是**会话标题**——就是侧栏会话列表里那一行文字（宿主 `sessionTitle` 服务折叠出的最新标题），**完整不截断**，用来认出「这次在干什么」。

标题服务没挂载、或标题还是空白时，首行退回工作区名（不拿 session id 凑数，那串 uuid 只会占地方看不懂）。

各渠道收到的文案完全一致（同一 format 下）。

| 结束原因（`turn/end` 的 `reason.kind`） | 首行前缀 | 追加的「原因:」行 | 设置项 |
| --- | --- | --- | --- |
| `completed` | ✅ 任务完成 | 无 | `statuses.completed` |
| `error` | ❌ 任务失败 | `error.message` / `error.code` | `statuses.error` |
| `aborted` | ⚠️ 任务已取消 | cause：用户主动终止 / 上级会话取消 / 插件中断 / 会话释放 / 未知 | `statuses.aborted` |
| `blocked` | ⛔ 任务被拦截 | 无 | `statuses.blocked` |
| `max-tokens` | ⚠️ 任务中断（超出最大长度） | 无 | `statuses."max-tokens"` |
| `interrupted` | ⚠️ 任务中断 | 无 | `statuses.interrupted` |
| `forked` | 🔀 任务已分叉 | 无 | `statuses.forked` |

## 配置

插件不调 `ctx.settings.register()`，直接导出 `Config`；配置写在 loader 条目 `task-notify` 的 `config.rules` 下（见 `cordis.patch.yml`），也可被设置卡片覆盖。

```yaml
config:
  rules:
    enabled: true          # 总开关
    format: plain          # plain | markdown，所有目标共用
    skipSubagents: true    # 只报顶层任务，subagent 的轮次结束不推

    # 每种结束原因一个开关，全开。关掉哪种就不再推哪种，
    # 被拦下的轮次计入 /_task-notify/status 的 filtered。
    statuses:
      completed: true       # ✅ 任务完成
      error: true           # ❌ 任务失败
      aborted: true         # ⚠️ 任务已取消
      blocked: true         # ⛔ 任务被拦截
      max-tokens: true      # ⚠️ 超出最大长度
      interrupted: true     # ⚠️ 任务中断
      forked: true          # 🔀 任务已分叉

    # 投递目标列表：一条通知扇出到全部项。三者都取自 dsh-im：
    #   channel  = 渠道名（weixin / telegram / slack / email / feishu / ...）
    #   botId    = dsh-im 里的「账户」，形如 wx_<24 hex>
    #   targetId = dsh-im 里的收件目标，形如 tgt_<16 hex>
    #   enabled  = 这一条开不开；false 只是停用，别的目标照发（缺省 true）
    # 任一项缺 botId / targetId 会被丢弃（等于该目标不投递）。
    targets:
      - channel: weixin
        botId: "wx_0123456789abcdef01234567"
        targetId: "tgt_1a2b3c4d5e6f7890"
        enabled: true
      - channel: telegram
        botId: "tg_0123456789abcdef01234567"
        targetId: "tgt_0f1e2d3c4b5a6978"
        enabled: false          # 配好了但先不发

    # 按工作区覆盖目标列表。键可以是完整 cwd，也可以只写工作区目录名。
    workspaces:
      ziyongchajian:
        - channel: weixin
          botId: "wx_0123456789abcdef01234567"
          targetId: "tgt_1a2b3c4d5e6f7890"
      "E:/文档/deepseek-harness/default-workspace":
        - channel: slack
          botId: "sl_0123456789abcdef01234567"
          targetId: "tgt_0f1e2d3c4b5a6978"
```

`targets` / `workspaces` 里每一项都能配不同渠道、不同账户，并各自用 `enabled` 单独开关。写多个微信账户就多写几项 `channel: weixin`，`botId` 各不相同——插件不做去重，全发。

想「换个渠道发」不用删配置：把旧目标 `enabled: false`，新目标 `enabled: true`，随时改回来。全关（或目标都被停用）= 该工作区视为未绑定，走「跳过 + 计数」那条路。

### 渠道与账户从哪来

dsh-im **没有**对外暴露「工作区 → 账户」的查询接口（`bot-workspace-store.mjs` 不在包的 `exports` 里），所以关联关系由本插件配置显式声明。三段信息都在 dsh-im 侧维护：

- `channel`：`ctx.dshIm.listBots()` 返回的 `[{ botId, channel }]` 里的 `channel`。
- `botId`（账户）：同上返回的 `botId`，形如 `wx_` + 24 位十六进制。
- `targetId`（收件目标）：dsh-im 的目标列表里自建的收件目标，形如 `tgt_` + 16 位十六进制。

装好后先看状态路由里的 `channels`（哪些通道有账户、各有几个）和 `bots`（逐个账户），照着填最省事：

```bash
curl http://127.0.0.1:19387/_task-notify/status
```

### 工作区匹配顺序

1. `workspaces` 里键 === `session.header.cwd`（完整路径）
2. `workspaces` 里键 === cwd 的目录名（如 `ziyongchajian`）
3. `targets`（默认列表）

## 安装

前提：本机已装 `@xmanrui/dsh-im`（本插件 `inject: ["dshIm"]`，没有它会跳过并在日志里说明）。

1. 在 DSH profile 的 `package.json` 里加依赖与 bundle：

```jsonc
{
  "dsh": { "profile": { "bundles": ["...", "dsh-task-notify"] } },
  "dependencies": {
    "dsh-task-notify": "https://codeload.github.com/bansheng2000/dsh-task-notify/tar.gz/refs/tags/v0.4.0"
  }
}
```

> 规格选择（三条都实测过，本机 `pnpm v11.7.0`）：
>
> | 规格 | 场景 | 说明 |
> | --- | --- | --- |
> | `https://codeload.github.com/bansheng2000/dsh-task-notify/tar.gz/refs/tags/v0.2.1` | **异地机器推荐** | 纯 HTTPS 下载，不碰 git，不需要任何凭据 |
> | `github:bansheng2000/dsh-task-notify` | 追 `main` 最新提交 | pnpm 会走 `git ls-remote git+ssh://git@github.com/...`，没配 ssh key 的机器 exit 128。修法：`git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"` |
> | `file:E:/文档/deepseek-harness/dsh-task-notify` | 本机开发 | 必须**绝对正斜杠**路径，相对路径报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND` |
>
> `#semver:` 前缀（`...#semver:^0.2.1`）只对 `github:` / `git+https:` 规格有意义，tarball URL 用版本号本身固定。

2. 在 profile 目录装依赖：

```powershell
cd C:\Users\12576\.dsh\profiles\desktop
pnpm install
```

> DSH 自带的 pnpm 在 `F:\Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.mjs`，
> 需要 `$env:ELECTRON_RUN_AS_NODE = "1"` 才能直接跑。
> pnpm 装进 profile 的是**真实拷贝**：改了 repo 文件必须重跑 install 才生效。

3. 重启 DSH。

> 装完确认一下：`node_modules/dsh-task-notify/` 下应有 `lib/index.js` 与 `cordis.patch.yml`。

bundle 自带的 `cordis.patch.yml` 用 `- insert:` 创建 loader 条目，**不要**手改成顶层扁平 `- id:`——扁平形态只会改已有条目，条目不存在时静默空操作，插件永不挂载。

## 更新

```powershell
cd C:\Users\12576\.dsh\profiles\desktop
# tarball 规格：先把依赖里的版本号改掉（v0.2.1 → 新版本），再
pnpm install
# 裸 github: 规格跟 main，无需改任何东西
pnpm update dsh-task-notify
```

然后重启 DSH——不重启内存里跑的还是旧代码。

## 验证

```powershell
# 1) 插件自检（不依赖 DSH 宿主，34 项断言）
cd E:\文档\deepseek-harness\dsh-task-notify
& "F:\Programs\DeepSeek Harness\DeepSeek Harness.exe" test\selftest.mjs
# 期望：dsh-task-notify selftest: ok

# 2) 确认已挂载：apply() 跑了才会注册状态路由
curl http://127.0.0.1:19387/_task-notify/status
```

状态路由返回生效配置、dsh-im 在线账户与计数：

```json
{
  "ok": true, "active": true, "format": "plain", "skipSubagents": true,
  "statuses": { "completed": true, "error": true, "aborted": true, "blocked": true,
                "max-tokens": true, "interrupted": true, "forked": true },
  "targets": [{ "channel": "weixin", "botId": "wx_...", "targetId": "tgt_...", "enabled": true }],
  "workspaces": {},
  "bots": [{ "botId": "wx_...", "channel": "weixin" }],
  "channels": [{ "channel": "weixin", "accounts": 1, "botIds": ["wx_..."] }],
  "dshImInstalled": true,
  "seen": 12, "notified": 6, "failed": 0, "skippedUnbound": 3, "deduped": 1, "filtered": 0,
  "last": { "sessionId": "...", "turn": 3, "reason": "completed", "at": "..." }
}
```

`notified` 按**目标条数**计数（两个渠道都成功 = 2），不是按通知条数。

## 常见问题排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `/_task-notify/status` 返回 404 | `apply()` 没跑：包没进 profile、bundles 没加、或 patch 写成了顶层扁平 `- id:`。查 plugin manager 的 `list_plugins`，应有 `include:task-notify` + `fiberPhase: active`。 |
| 加载时报 `Cannot find package '@deepseek-ai/schemastery'` | `@deepseek-ai/schemastery` 同时写进 `dependencies` 和 `peerDependencies` 时，pnpm 按 peer 处理、**不会**装进依赖树。本机因别的插件把它提升到 profile 根而假绿，干净机器上必炸。宿主侧 bare import 只能写进 `dependencies`，`peerDependencies` 留给宿主运行时自己提供的东西。 |
| `skippedUnbound` 一直涨 | `targets` / `workspaces` 缺 botId 或 targetId（半截配置会被整项丢弃），或该 `botId` 不在 `bots` 里 / `channel` 对不上。对照状态路由的 `bots` 核对。 |
| `notified` 涨但某个渠道没收到 | 单个目标失败不会影响其它目标，但只会在日志里留一条 warn（`send not accepted: ...` / `send failed: ...`，带 `code`）。按 `targetId` 搜日志定位是哪个目标。 |
| 微信 notified 但没收到 | `{sent:true}` 只代表平台接口接受，不代表送达。微信主动投递还需要用户消息里携带过的 `context_token`；先给机器人发一条微信消息再触发。 |
| 某个通道 / 账户不想收了 | 把那条目标 `enabled: false`（不用删配置）；全停用等于该工作区未绑定，`skippedUnbound` 会涨、日志写 `no enabled target bound`。 |
| 通知太吵 | `skipSubagents: true` 过滤 subagent；`statuses` 里关掉不关心的类型（如 `forked: false`、`blocked: false`）；同会话同原因本来就只推一次。fork / 多轮会推多条，确需收敛可把去重键加上 turn。 |
| `filtered` 涨但一条没收到 | `statuses` 把这种结束原因关了（`filtered` 数被开关拦下的轮次）。看 `statuses` 哪项是 `false`。 |
| 某个工作区没通知、别的有 | 检查 `workspaces` 的键：先按完整 `cwd` 匹配、再按目录名匹配，两者都没命中才回落默认 `targets`。 |
| 改了 repo 代码但行为没变 | pnpm 装进 profile 的是真实拷贝。重新跑上面的 install，或直接改 `node_modules\dsh-task-notify\lib\index.js`。 |

## 文件

```
lib/index.js       插件本体（Config / apply / 文案 / 去重 / 多渠道扇出 / 状态路由）
cordis.patch.yml   bundle patch（- insert: 创建 loader 条目 + 配置示例）
package.json       main=lib/index.js, dsh.bundle.patch=cordis.patch.yml
README.md          本文件
test/selftest.mjs  自检（34 项断言）
```
