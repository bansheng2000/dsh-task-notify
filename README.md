# dsh-task-notify

任务完成 / 失败 / 取消时，通过 `@xmanrui/dsh-im` 推通知，支持**多渠道、多账户**同时投递。

- **判定来源**：事件订阅 `session/event` 的 `turn/end`，零轮询，**覆盖全部工作区的全部会话**。
- **投递通道**：复用 dsh-im 已有的渠道与账户配置（`ctx.dshIm.send`），不新建任何通道。
- **多渠道**：一条通知扇出到 `targets` 列表里的每一个目标（渠道 + 账户 + 收件目标），某个目标失败不影响其它目标。
- **按通道 + 账户启停**：每个目标自带 `enabled`；`false` 只停用它，其它目标照发。状态路由顺手列出**哪些通道有账户**（`channels`）。
- **文案**：首行「状态 | task-notify | 会话标题」，正文逐行「字段: 值」；失败 / 取消补一行「原因: ...」。
- **未绑定 / 账户未连接**：跳过 + 记日志 + 计数，不报错打断监听。
- **去重**：会话级——同一 `sessionId` + 同一结束原因只推一次（整批算一次，不是每个目标一次）。
- **待答问题也提示**：会话调 `ask_user_question` 要你做选择时推一条 ❓ 通知（只旁听不抢答，回答权原样交回 Web / dsh-im），单独用 `notifyQuestions` 开关控制。
- **哪些工作区发**：`onlyWorkspaces`（或卡片上勾工作区）为空 = 全部工作区都发；非空则先按工作区拦一道，被拦下的算 `filteredWorkspace`，不算失败。
- **正文可裁剪**：`fields` 决定正文带「会话标题 / 工作区 / 原因 / 会话 id / 时间」哪几项，全关也仍有一条首行（谁、什么状态）。
- **设置里可改**：插件自带设置卡片（设置 → 插件 → dsh-task-notify → 行配置），开关、状态过滤、正文包含哪些字段、通知哪些工作区、目标列表、工作区规则都能改，**落盘即生效，不用重启**。

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
会话: session-6f2292c8-…            # 开了 fields.sessionId 才有
时间: 2026-10-14T14:22:52.983Z      # 开了 fields.time 才有
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

### 会话要你做选择时（`ask_user_question`）

会话调 `ask_user_question` 抛出待答问题时，也推一条独立的通知，单独用 `notifyQuestions` 开关（默认开，不归 `statuses` 管）：

```
❓ 需要你选择 | task-notify | 微信文案微调
工作区: ziyongchajian
待选: 用哪个文案？
  - 简洁版
  - 详细版
  - 先不改文案
```

只旁听不抢答：监听的是 cordis waterfall `user-questions/request`，插件打完招呼立刻 `return next()`，把回答权原样交给 Web 界面 / dsh-im 的回答器，绝不自己写答案。

最多列 3 道题、每题前 6 个选项，整块超 300 字截断加 `…`——手机上刷一屏就够，别把微信刷爆。

## 配置

插件不调 `ctx.settings.register()`，直接导出 `Config`；配置写在 loader 条目 `task-notify` 的 `config.rules` 下（见 `cordis.patch.yml`），也可被设置卡片覆盖。

```yaml
config:
  rules:
    enabled: true          # 总开关
    format: plain          # plain | markdown，所有目标共用
    skipSubagents: true    # 只报顶层任务，subagent 的轮次结束不推
    notifyQuestions: true  # 会话要你做选择时（ask_user_question）也推一条

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

    # 只给这些工作区发通知：完整 cwd 或工作区目录名。空数组（缺省）= 全部工作区都发。
    onlyWorkspaces:
      - ziyongchajian

    # 通知正文带哪些字段。标题/工作区/原因缺省带，会话 id 与时间缺省不带。
    fields:
      title: true          # 首行的会话标题（关掉则退回工作区名）
      workspace: true      # 正文「工作区: X」
      reason: true         # 失败/取消的「原因: X」
      sessionId: true      # 正文「会话: session-xxx」（配合 DSH 的 /session 命令）
      time: true           # 正文「时间: ISO」

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

两个「先拦一道」的开关，顺序是：**工作区**（`onlyWorkspaces` 非空且不含当前工作区 → 直接 `return`，计数 `filteredWorkspace`）→ 状态开关（`statuses`，计数 `filtered`）→ 去重（计数 `deduped`）→ 找目标（找不到，计数 `skippedUnbound`）→ 真发（成功计 `notified`，失败计 `failed`）。`onlyWorkspaces` 的空缺省是「全部发」，所以只勾工作区不会把默认目标丢掉。

`fields` 只影响正文，不影响投递与去重：全关掉时正文只剩首行（`✅ | task-notify | 工作区名`），适合只想知道「哪台机器跑完了」。

### 在设置里改（推荐）

装好之后不用再碰 yml：**设置 → 插件 → 已安装 → dsh-task-notify → 行配置**，就是本插件自带的一张卡片（第三方插件的设置页是插件自己写进宿主 slot 的，宿主不代填表单）。

卡片上能改的东西与上面配置一一对应：

- 总开关「启用通知」、七种结束原因的勾选、「跳过子代理」、「会话要你选择时也提示」、消息格式；
- 「通知里包含」：正文带哪些字段（会话标题 / 工作区 / 原因 / 会话 id / 时间），逐项勾；
- 「通知哪些工作区」：把见过的工作区列出来勾（括号里是结束次数）。一个都不勾 = 全部工作区都发；
- 投递目标列表（增删改）：启用勾、通道下拉（括号里是该通道的账户数）、`botId`、`targetId`，「选收件人」按钮会列出该账户下 dsh-im 已有的收件目标让你点。
  - 这一行的 `botId` 是空的时候点它，卡片会直接告诉你缺什么（不会静默无反应）；
  - 刚点「+ 渠道 · …」加出来的那行 `targetId` 是空的，按钮点下去会立刻出现在列表里（v0.7.0 前这种半填的行会被吞掉，表现为「点了没反应」），再点「选收件人」填上就行；
  - 该账户在 dsh-im 里一条收件目标都没有时，按钮下面会给出「去 集成 → 该机器人 → 投递设置 → 从已聊过的会话选择」的下一步，而不是把下拉藏起来。
- 按工作区换收件目标（每行一条 `名称=channel|botId|targetId`，与「通知哪些工作区」是两件事：这里决定发给谁，那里决定发不发）；
- 「刷新」重新读配置、「发测试通知」真发一条（不受状态开关影响，用来验证通道与账户是不是通的）；
- 底部计数：已推送 / 未绑定跳过 / 状态过滤 / 工作区过滤 / 去重 / 失败。

卡片顶部如果写着「dsh-im 当前没有在线账户」，说明 `ctx.dshIm` 没就绪或还没配任何通道——通知会全部跳过，不会静默丢。

**改完立即生效，不用重启 DSH。** 与 yml 的关系：卡片写的是同一个命名空间 `task-notify` 的配置，两边是同一份数据；真要批量编辑或做版本管理时改 yml，然后重启（或在卡片上点「刷新」让它重新读）。

卡片背后是插件自己起的 HTTP 桥（`/api/dsh-task-notify-settings/*`），只接受回环请求；HTTP 直连主要用于脚本化改配置：

```bash
# 读当前配置 + 在线账户 + 计数
curl http://127.0.0.1:19387/api/dsh-task-notify-settings/describe

# 写：关掉「已分叉」这类噪音通知
curl -X POST http://127.0.0.1:19387/api/dsh-task-notify-settings/mutate \
  -H "content-type: application/json" \
  -d '{"ns":"task-notify","ops":[{"op":"set","path":["rules","statuses","forked"],"value":false}]}'

# 实发一条测试通知
curl -X POST http://127.0.0.1:19387/api/dsh-task-notify-settings/test -H "content-type: application/json" -d '{}'
```

应答一律 `{ok:true,value:...}` / `{ok:false,code,message}`；写操作只接受本插件自己的命名空间（否则 `settings-not-exposed`）。
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
    "dsh-task-notify": "https://codeload.github.com/bansheng2000/dsh-task-notify/tar.gz/refs/tags/v0.7.0"
  }
}
```

> 规格选择（三条都实测过，本机 `pnpm v11.7.0`）：
>
> | 规格 | 场景 | 说明 |
> | --- | --- | --- |
> | `https://codeload.github.com/bansheng2000/dsh-task-notify/tar.gz/refs/tags/v0.7.0` | **异地机器推荐** | 纯 HTTPS 下载，不碰 git，不需要任何凭据 |
> | `github:bansheng2000/dsh-task-notify` | 追 `main` 最新提交 | pnpm 会走 `git ls-remote git+ssh://git@github.com/...`，没配 ssh key 的机器 exit 128。修法：`git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"` |
> | `file:E:/文档/deepseek-harness/dsh-task-notify` | 本机开发 | 必须**绝对正斜杠**路径，相对路径报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND` |
>
> `#semver:` 前缀（`...#semver:^0.5.0`）只对 `github:` / `git+https:` 规格有意义，tarball URL 用版本号本身固定。

2. 在 profile 目录装依赖：

```powershell
cd C:\Users\12576\.dsh\profiles\desktop
pnpm install
```

> DSH 自带的 pnpm 在 `F:\Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.mjs`，
> 需要 `$env:ELECTRON_RUN_AS_NODE = "1"` 才能直接跑
> （本机没装独立 node：`$env:ELECTRON_RUN_AS_NODE="1"; & "F:\Programs\DeepSeek Harness\DeepSeek Harness.exe" "<pnpm.mjs>" --dir "<profile>" install`）。
> pnpm 装进 profile 的是**真实拷贝**：改了 repo 文件必须重跑 install 才生效。

3. 重启 DSH。

> 装完确认一下：`node_modules/dsh-task-notify/` 下应有 `lib/index.js` 与 `cordis.patch.yml`。

bundle 自带的 `cordis.patch.yml` 用 `- insert:` 创建 loader 条目，**不要**手改成顶层扁平 `- id:`——扁平形态只会改已有条目，条目不存在时静默空操作，插件永不挂载。

## 更新

```powershell
cd C:\Users\12576\.dsh\profiles\desktop
# tarball 规格：先把依赖里的版本号改掉（v0.7.0 → 新版本），再
pnpm install
# 裸 github: 规格跟 main，无需改任何东西
pnpm update dsh-task-notify
```

然后重启 DSH——不重启内存里跑的还是旧代码。

## 验证

```powershell
# 1) 插件自检（不依赖 DSH 宿主）
cd E:\文档\deepseek-harness\dsh-task-notify
& "F:\Programs\DeepSeek Harness\DeepSeek Harness.exe" test\selftest.mjs   # 服务端，51 项
& "F:\Programs\DeepSeek Harness\DeepSeek Harness.exe" test\client.mjs     # 设置卡片（含工厂 return、按钮点击、桥失败三类回归）
# 期望：dsh-task-notify selftest: ok / dsh-task-notify client selftest: ok

# 2) 确认已挂载：apply() 跑了才会注册状态路由
curl http://127.0.0.1:19387/_task-notify/status

# 3) 设置桥在（卡片靠它；404 = 桥没注册 = 服务端插件没挂上）
curl http://127.0.0.1:19387/api/dsh-task-notify-settings/describe
```

状态路由返回生效配置、dsh-im 在线账户与计数：

```json
{
  "ok": true, "active": true, "format": "plain", "skipSubagents": true,
  "notifyQuestions": true,
  "statuses": { "completed": true, "error": true, "aborted": true, "blocked": true,
                "max-tokens": true, "interrupted": true, "forked": true },
  "targets": [{ "channel": "weixin", "botId": "wx_...", "targetId": "tgt_...", "enabled": true }],
  "workspaces": {},
  "onlyWorkspaces": ["ziyongchajian"],
  "fields": { "title": true, "workspace": true, "reason": true, "sessionId": false, "time": false },
  "observed": [{ "name": "ziyongchajian", "cwd": "E:/文档/deepseek-harness/ziyongchajian", "count": 7, "last": "session-..." }],
  "bots": [{ "botId": "wx_...", "channel": "weixin" }],
  "channels": [{ "channel": "weixin", "accounts": 1, "botIds": ["wx_..."] }],
  "dshImInstalled": true,
  "seen": 12, "notified": 6, "failed": 0, "skippedUnbound": 3, "deduped": 1, "filtered": 0, "filteredWorkspace": 0,
  "questions": 2,
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
| 会话要你选择时没收到通知 | `notifyQuestions` 被关了；subagent 默认也不推（`skipSubagents`）。看 `questions` 计数涨没涨——涨了说明事件到了，是没绑目标或账户不在线。 |
| 通知太吵 | `skipSubagents: true` 过滤 subagent；`statuses` 里关掉不关心的类型（如 `forked: false`、`blocked: false`）；同会话同原因本来就只推一次。fork / 多轮会推多条，确需收敛可把去重键加上 turn。 |
| `filtered` 涨但一条没收到 | `statuses` 把这种结束原因关了（`filtered` 数被开关拦下的轮次）。看 `statuses` 哪项是 `false`。 |
| 某个工作区没通知、别的有 | 检查 `workspaces` 的键：先按完整 `cwd` 匹配、再按目录名匹配，两者都没命中才回落默认 `targets`。 |
| 改了 repo 代码但行为没变 | pnpm 装进 profile 的是真实拷贝。重新跑上面的 install，或直接改 `node_modules\dsh-task-notify\lib\index.js`。 |
| 设置里找不到 dsh-task-notify 的配置行 | 卡片挂在「插件 → 已安装」的**行配置**上，不是独立的设置页（宿主 rc.1 后只保留 `plugins.row.config` 这一个 slot）。若整行没有入口，先确认插件已挂载（状态路由 200）。 |
| 卡片写着「桥未注册」 | 服务端没跑或版本对不上：`/api/dsh-task-notify-settings/describe` 是 404 就是桥没注册，先查 `/_task-notify/status` 是否 200。 |
| 点「选收件人」没反应（v0.6.1 修） | 两个原因：① 这一行的 `botId` 是空的（旧版直接 `return`，什么都不做）—— 点上面的「+ 渠道 · …」按钮会自动填上；② botId 填了但 dsh-im 侧一条收件目标都没有（新机器常见），要去 设置 → 集成 → 该机器人 → 投递设置 →「从已聊过的会话选择」先建一条。v0.6.1 起两种情况都会在卡片上说清原因。 |
| 点「+ 渠道 · …」加了收件目标、卡片里却不出现（v0.7.0 修） | 桥和 `/_task-notify/status` 原来拿**归一化后**的配置去 describe，而归一化会把 `targetId` 为空的半填行整项丢弃 —— 写盘成功、回读却是空列表，界面表现就是「点了没反应」。v0.7.0 起 describe 走 `storedRules()`（只补默认值、不丢行），归一化只留给投递路径；`/_task-notify/status` 的 `targets` 现在能看到那行空的 `targetId`。 |
| 卡片上按钮毫无反应、没有红字 | v0.6.1 之前 `bridgePost` 的 fetch / JSON 解析异常会直接 reject，调用方没接住。旧版本请先看浏览器控制台；新版会把「连不上设置桥」「返回 HTTP 401 而不是 JSON」直接显示在卡片底部。 |
| DSH 启动即崩，报 `invalid plugin, expect function or object with an "apply" method, received undefined`（v0.5.0 修） | `lib/client.js` 的工厂**没有 `return module.exports`**。宿主 cordis 拿工厂返回值当插件对象，只往 `exports` 上挂而不 return，得到 undefined 就崩。宿主自己 grep 不到这个字符串（它在 `app.asar/app.asar` 内层），错误原文见 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`。`test/client.mjs` 里已加断言兜这条：`factory()` 的返回值必须有 `apply`。 |

## 文件

```
lib/index.js       插件本体（Config / apply / 文案 / 去重 / 多渠道扇出 / 状态路由 / 桥接线）
lib/bridge.js      设置桥：describe / mutate / targets / test 四个只读回环路由
lib/client.js      设置卡片（window.__ModuleLoader__.load 形态，挂 plugins.row.config）
cordis.patch.yml   bundle patch（- insert: 创建 loader 条目 + 配置示例）
package.json       main=lib/index.js, exports./client=lib/client.js, dsh.bundle.patch / dsh.client
README.md          本文件
test/selftest.mjs  服务端自检（51 项断言）
test/client.mjs    设置卡片自检（假 window + 假 react，渲染成纯对象树断言；含按钮点击、字段/工作区勾选写回、桥失败的回归用例，11 组）
```