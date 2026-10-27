# dsh-task-notify

任务完成 / 失败 / 取消时，通过 `@xmanrui/dsh-im` 推通知，支持**多渠道、多账户**同时投递。

- **判定来源**：事件订阅 `session/event` 的 `turn/end`，零轮询，**覆盖全部工作区的全部会话**。
- **投递通道**：复用 dsh-im 已有的渠道与账户配置（`ctx.dshIm.send`），不新建任何通道。
- **多渠道**：一条通知扇出到 `targets` 列表里的每一个目标（渠道 + 账户 + 收件目标），某个目标失败不影响其它目标。
- **按通道 + 账户启停**：每个目标自带 `enabled`；`false` 只停用它，其它目标照发。状态路由顺手列出**哪些通道有账户**（`channels`）。
- **文案**：首行「状态 | task-notify | 会话标题」，正文逐行「字段: 值」；失败 / 取消补一行「原因: ...」。
- **未绑定 / 账户未连接**：跳过 + 记日志 + 计数，不报错打断监听。
- **去重**：按轮——同一 `sessionId` + 同一 `turn` + 同一结束原因只推一次（只吞同一轮的事件重放；整批算一次，不是每个目标一次）。**同一会话的每一轮都会各推一条。**
- **待答问题也提示**：会话调 `ask_user_question` 要你做选择时推一条 ❓ 通知（只旁听不抢答，回答权原样交回 Web / dsh-im），单独用 `notifyQuestions` 开关控制。
- **中断 / 失败先等一会**：`error` / `interrupted` / `max-tokens` 三种结束原因默认先等 `autoContinueGraceMs`（60 秒）再判定——期间会话被 **dsh-auto-continue** 续跑接上了就**不推**（计入 `suppressed`），没续上才补推。装了自动继续插件的机器上，不会再出现「中断了」紧接着「续上了」的连环噪音。
- **我在看这个会话就不推**：`skipWhenWatching`（缺省开）+ `afkAfterMs`（缺省 120 秒）。Web 页面正停在这个会话上、且最近 2 分钟有鼠标/键盘操作时，这一轮结束**不推**（计入 `skippedWatching`）；切到别的标签页、或人离开超过 `afkAfterMs` 就照常推。拿不到这个信号（CLI / headless / 没开 Web GUI）时一律照常推——只会多推，不会漏推。
- **哪些工作区发**：`onlyWorkspaces`（或卡片上勾工作区）为空 = 全部工作区都发；非空则先按工作区拦一道，被拦下的算 `filteredWorkspace`，不算失败。卡片里的勾选列表**读宿主登记的全部工作区**（`~/.dsh/storages/workspace.json`），不是只列跑过的。
- **正文可裁剪**：`fields` 决定正文带「会话标题 / 工作区 / 原因 / 答复首句 / 会话 / 时间」哪几项，全关也仍有一条首行（谁、什么状态）。
- **顺带一句结论**：`fields.brief`（缺省开）把本轮最后一条回复的首句摘进正文「内容:」那行——插件在本地读会话事件流，**不调模型、不花 token**。
- **桌面上也叫一声**（只在打开着 DSH Web 页面时有效）：弹 Windows 系统原生通知（点气泡跳回并定位到那条会话）、响提示音（`none` / `beep` / `chime` / `custom` 音源地址）、标签页标题前加未读标记（`(1)`，看过后自动恢复）。与 IM 投递**彼此独立**：没绑 dsh-im 也照样弹，绑了也不受影响。
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
内容: 改完了，通知里的会话改成标题了。  # 开了 fields.brief（缺省开）才有：本轮最后一条回复的首句
会话: 微信文案微调                  # 开了 fields.sessionId 才有：会话标题，没标题才退回裸 id
时间: 2026-10-14T14:22:52.983Z      # 开了 fields.time 才有
```

首行第三段是**会话标题**——就是侧栏会话列表里那一行文字，**完整不截断**，用来认出「这次在干什么」。它读会话事件流里最后一条 `session/title`（宿主 `sessionTitle` 服务读的是同一份数据），所以**你手动重命名后的名字就是它**。

打开 `fields.sessionId` 时，正文那行「会话:」也给同一个标题，只有标题还没生成时才退回裸 session id（方便配 DSH 的 `/session` 命令）。

「内容:」那行是本轮**最后一条回复的首句**（`fields.brief`，缺省开）：插件直接读会话事件流里的 `assistant/message`，剥掉代码块与 markdown、切到第一个句末标点（`。！？；`）、超 80 字截断加 `…`。**纯本地摘取，不调模型、不花一个 token**。
本轮被打断（`interrupted`）时这行不写——宁可不给，也不拿中途某一步的解说冒充本轮结论。与 dsh-im 同源，所以侧栏 / 微信里显示什么，这里就写什么。

标题取不到时，首行退回工作区名（不拿 session id 凑数，那串 uuid 只会占地方看不懂）。

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

## 桌面提醒：系统通知 / 提示音 / 标签页未读

IM 通知要经过微信/飞书，慢、还有 12 小时窗口这类坑；人就在电脑前时，直接让电脑叫一声更快。这三样在 **Web 客户端**里做（`lib/client.js`），开关在设置卡片的「桌面上也叫一声」一块：

| 设置 | 缺省 | 作用 |
| --- | --- | --- |
| `desktopNotice` | `true` | 弹 Windows 系统原生通知（浏览器 Notification）。点气泡 → 回到页面并跳到那条会话 |
| `noticeSticky` | `true` | 气泡常驻：置 `requireInteraction`，Windows 上要人点一下或关掉才消失，不会几秒自己滑走（系统「通知显示时长」/专注助手仍可能截断） |
| `titleBadge` | `true` | 标签页标题前加未读标记，如 `(2) 我的工作台`；页面被激活查看后自动恢复 |
| `sound` | `beep` | `none` / `beep` / `chime` / `custom`；beep 与 chime 是现场合成的，不需要音频文件 |
| `soundUrl` | `""` | `sound` 为 `custom` 时的音频地址（`https://…/ding.mp3`） |

行为细节：

- **只在打开着 DSH Web 页面时有效**——气泡、提示音、标题标记都是浏览器能力，页面关着就只有 IM 通知（这是浏览器 API 的边界，不是漏做）。
- **正看着那条会话就不吵**：页面可见、且侧栏停在这条会话上时，这一条连桌面提示一起跳过（和 `skipWhenWatching` 是同一套判断）。
- **气泡常驻**：默认置 `requireInteraction: true`，任务完成的气泡会一直挂在屏幕上直到你点它或关掉；嫌吵就把卡片的「气泡常驻」取消勾选，回到系统默认的几秒自动消失。同一会话的新提醒按 tag 覆盖旧的，不会堆满屏。
- **点气泡跳转**：优先 `uiWorkspace.openSession(sessionId)`，老宿主退回 `sessions.open(sessionId)`。跳到的是**那条会话**，不是工作区首页。
- **提示音需要一次用户手势**：浏览器禁止自动播放音频，页面加载后点一下（比如点「试听」）就解锁了，之后都能自动响。
- **系统通知权限**：第一次点「允许系统通知…」时浏览器会问；被拒了就在地址栏左侧站点设置里改成允许，再点一次。权限没给时其它两样照旧工作。
- 桌面提醒**不依赖 dsh-im**：没绑任何收件目标、或 IM 那条路失败了，电脑上照样会有气泡。计数看 status 的 `alerts.since`（产出条数）与 `alerts.polls`（页面来取过几次）。
- **想马上验证一次**：点卡片上的「试一下桌面提醒」（0.10.5+）—— 客户端本地连发**三条预览**：`✅ 任务完成` → `❌ 任务失败` → `❓ 需要你选择`，每条隔 0.9 秒，附带提示音。纯前端合成，不用等任务结束、也不受「看着就不推」影响；想确认 IM 那条路，用同一个卡片里的「发一条测试」或 status 的 `notified` 计数。

宿主 → 客户端的通道是一个内存信箱：`POST /api/dsh-task-notify-settings/alerts`（body `{since}`）返回 `{since, alerts, desktop}`，客户端每 3 秒轮一次、按游标取增量。用 POST 而不是 `GET ?since=` 是因为桥的路由按精确路径匹配，查询串会丢。

## 配置

插件不调 `ctx.settings.register()`，直接导出 `Config`；配置写在 loader 条目 `task-notify` 的 `config.rules` 下（见 `cordis.patch.yml`），也可被设置卡片覆盖。

```yaml
config:
  rules:
    enabled: true          # 总开关
    format: plain          # plain | markdown，所有目标共用
    skipSubagents: true    # 只报顶层任务，subagent 的轮次结束不推
    notifyQuestions: true  # 会话要你做选择时（ask_user_question）也推一条
    # 异常结束（error / interrupted / max-tokens）先等这么久再判定：
    # 期间被 dsh-auto-continue 续跑接上就不推（计入 suppressed）。0 = 立即推。
    autoContinueGraceMs: 60000
    # 你正在看这个会话（页面停在它上面 + 最近有输入）就不推；多久没输入算离开。
    skipWhenWatching: true
    afkAfterMs: 120000

    # 桌面提醒（只在打开着 DSH Web 页面时有效，与 IM 投递互不影响）：
    desktopNotice: true    # 弹 Windows 系统原生通知，点一下跳回并定位到那条会话
    noticeSticky: true     # 气泡常驻：不点不消失（Windows 系统「通知显示时长」仍可能截断）
    titleBadge: true       # 标签页标题前加未读标记，看过后自动恢复
    sound: beep            # none | beep | chime | custom（custom 用 soundUrl）
    soundUrl: ""           # sound=custom 时的音频地址

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

    # 通知正文带哪些字段。标题/工作区/原因/答复首句缺省带，会话与时间缺省不带。
    fields:
      title: true          # 首行的会话标题（关掉则退回工作区名）
      workspace: true      # 正文「工作区: X」
      reason: true         # 失败/取消的「原因: X」
      brief: true          # 正文「内容: X」= 本轮最后一条回复的首句（本地摘取，0 token）
      sessionId: true      # 正文「会话: 会话标题」（没标题才退回 session-xxx）
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

两个「先拦一道」的开关，顺序是：**工作区**（`onlyWorkspaces` 非空且不含当前工作区 → 直接 `return`，计数 `filteredWorkspace`）→ 状态开关（`statuses`，计数 `filtered`）→ 去重（计数 `deduped`，键 = 会话 + 轮次 + 结束原因）→ 找目标（找不到，计数 `skippedUnbound`）→ 真发（成功计 `notified`，失败计 `failed`）。`onlyWorkspaces` 的空缺省是「全部发」，所以只勾工作区不会把默认目标丢掉。

异常结束（`error` / `interrupted` / `max-tokens`）还会先等 `autoContinueGraceMs`（缺省 60s）再判定：期间会话被 dsh-auto-continue 续跑接上了（事件流里出现更大的 `turn`）就吞掉这条、计入 `suppressed`，没续上才真发。`0` = 不等、立即推。

`fields` 只影响正文，不影响投递与去重：全关掉时正文只剩首行（`✅ | task-notify | 工作区名`），适合只想知道「哪台机器跑完了」。`fields.brief` 摘的是事件流里已有的文本，只往外发、不写回会话，所以不会在后续每轮里重复计费。`fields.sessionId` 打开时那行给的是会话标题（重命名后就是新名字），只有标题还没生成才退回裸 id。

### 在设置里改（推荐）

装好之后不用再碰 yml：**设置 → 插件 → 已安装 → dsh-task-notify → 行配置**，就是本插件自带的一张卡片（第三方插件的设置页是插件自己写进宿主 slot 的，宿主不代填表单）。

卡片上能改的东西与上面配置一一对应：

- 总开关「启用通知」、七种结束原因的勾选、「跳过子代理」、「会话要你选择时也提示」、消息格式；
- 「中断/失败先等 N 秒再判定」：数字框，单位秒；期间被 dsh-auto-continue 续上就不推，`0` = 立即推；
- 「通知里包含」：正文带哪些字段（会话标题 / 工作区 / 原因 / 答复首句 / 会话 / 时间），逐项勾；
- 「通知哪些工作区」：把见过的工作区列出来勾（括号里是结束次数）。一个都不勾 = 全部工作区都发；
- 投递目标列表（增删改）：启用勾、通道下拉（括号里是该通道的账户数）、`botId`、`targetId`，「选收件人」按钮会列出该账户下 dsh-im 已有的收件目标让你点。
  - 这一行的 `botId` 是空的时候点它，卡片会直接告诉你缺什么（不会静默无反应）；
  - 刚点「+ 渠道 · …」加出来的那行 `targetId` 是空的，按钮点下去会立刻出现在列表里（v0.7.0 前这种半填的行会被吞掉，表现为「点了没反应」），再点「选收件人」填上就行；
  - 该账户在 dsh-im 里一条收件目标都没有时，按钮下面会给出「去 集成 → 该机器人 → 投递设置 → 从已聊过的会话选择」的下一步，而不是把下拉藏起来。
- 按工作区换收件目标（每行一条 `名称=channel|botId|targetId`，与「通知哪些工作区」是两件事：这里决定发给谁，那里决定发不发）；
- 「刷新」重新读配置、「发测试通知」真发一条（不受状态开关影响，用来验证通道与账户是不是通的）；
- 「我在看这个会话时不推」勾 +「无操作 N 秒算离开」数字框：判定窗口直接在卡片上改；
- 「桌面上也叫一声」：系统通知勾、气泡常驻勾、标签页未读勾、提示音下拉 +「试听」按钮 +「试一下桌面提醒」按钮 +「允许系统通知…」按钮（`custom` 时多一个音源地址输入框）；
- 底部计数：已推送 / 未绑定跳过 / 状态过滤 / 工作区过滤 / 被续跑吞掉 / 被看着跳过 / 去重 / 失败。

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
    "dsh-task-notify": "https://codeload.github.com/bansheng2000/dsh-task-notify/tar.gz/refs/tags/v0.9.2"
  }
}
```

> 规格选择（三条都实测过，本机 `pnpm v11.7.0`）：
>
> | 规格 | 场景 | 说明 |
> | --- | --- | --- |
> | `https://codeload.github.com/bansheng2000/dsh-task-notify/tar.gz/refs/tags/v0.9.2` | **异地机器推荐** | 纯 HTTPS 下载，不碰 git，不需要任何凭据 |
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

### 卸载

**用 DSH 的插件页（推荐）**：设置 → 插件 → 已安装 → 点 `dsh-task-notify` 进详情页 → 右上角垃圾桶图标「卸载」→ 确认。它会把 `dsh-task-notify` 从 profile 的 `package.json`（`dependencies` 与 `dsh.profile.bundles` 两处）摘掉并重跑一次安装，结果是 `applied` 或 `restart-required`（后者重启 DSH 生效）。DSH 目前不做自动升级：换新版也是先卸载再装。

卸载按钮灰的只可能是这两种（`readOnlyReason`）：`management-required` = 宿主不管理这个 profile（DSH 自带的包）；`unaddressable` = 宿主条目对不上号（包内 `cordis.patch.yml` 写成扁平的 `- id:` 而不是 `- insert:`）。正常从 profile 装的 `dsh-task-notify` 不属于这两种，按钮是亮的。

**手工等价步骤**（`<profile>` 指 `~/.dsh/profiles/desktop`）：

1. 从 `<profile>/package.json` 的 `dsh.profile.bundles` 里删掉 `"dsh-task-notify"`，再从 `dependencies` 里删掉这一行（本机是 `"dsh-task-notify",`）。
2. 在 `<profile>` 目录里跑一次 `pnpm install`（本机没装 node，用上文那条 Electron-as-Node 的命令）。
3. 重启 DSH。宿主条目来自包内的 `cordis.patch.yml`，随 bundles 列表一起消失，不用手工清 `cordis.patch.yml` 覆盖层。

卸载只是不加载，通知历史（`~/.dsh/integrations/dsh-weixin` 等）与工作区登记表都不动；要恢复就按上面的安装步骤再装一次。

## 更新

```powershell
cd C:\Users\12576\.dsh\profiles\desktop
# tarball 规格：先把依赖里的版本号改掉（v0.8.1 → 新版本），再
pnpm install
# 裸 github: 规格跟 main，无需改任何东西
pnpm update dsh-task-notify
```

然后重启 DSH——不重启内存里跑的还是旧代码。

## 验证

```powershell
# 1) 插件自检（不依赖 DSH 宿主）
cd E:\文档\deepseek-harness\dsh-task-notify
& "F:\Programs\DeepSeek Harness\DeepSeek Harness.exe" test\selftest.mjs   # 服务端，54 项
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
  "notifyQuestions": true, "skipWhenWatching": true, "afkAfterMs": 120000,
  "desktopNotice": true, "noticeSticky": true, "titleBadge": true, "sound": "beep", "soundUrl": "",
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
  "suppressed": 1, "skippedWatching": 0, "presence": 0,
  "questions": 2,
  "alerts": { "since": 37 },
  "ledger": { "file": "C:/Users/me/.dsh/task-notify/ledger.jsonl", "lines": 421,
              "recent": [{ "at": "2026-10-25T09:43:12+08:00", "o": "sent", "sid": "session-9d45", "turn": 16, "kind": "completed", "ch": "feishu", "tgt": "tgt_de2a3d18" }] },
  "last": { "sessionId": "...", "turn": 3, "reason": "completed", "at": "..." }
}
```

`notified` 按**目标条数**计数（两个渠道都成功 = 2），不是按通知条数。

### 事件账本："有时候不发通知"靠它查

每个判定与每次投递结果都会追加一行到 `~/.dsh/task-notify/ledger.jsonl`（`TASK_NOTIFY_LEDGER` 可改路径），启动时读回来 —— 所以上面的计数是**有账以来**累计，重启不清零。每行只有结构化字段，**不含通知正文**：

| `o` | 含义 |
| --- | --- |
| `turn` | 收到一次 `turn/end`（带 `sid` 前 12 位 / `turn` / `kind` / 工作区名） |
| `sent` | 某个目标被平台收下（`ch` 渠道 + `tgt` 目标前 12 位） |
| `failed` | 某个目标失败（`err` 是错误码/首行，如 `delivery-failed`、`not-accepted`） |
| `unbound` | 没有可用目标 / 账户不在线（`err: dsh-im-missing` 或 `n` 条数） |
| `deduped` / `filtered` / `workspace` | 被去重 / 被 `statuses` 开关 / 被 `onlyWorkspaces` 拦下 |
| `watching` | 你在看这个会话，主动不推 |
| `suppressed` | 异常结束但被 dsh-auto-continue 续上了，主动不推 |
| `subagent` | 子代理轮次，按 `skipSubagents` 跳过 |
| `question` | 收到一次待答问题（随后同样有 `sent` / `failed`） |

查法：`tail -n 50 ~/.dsh/task-notify/ledger.jsonl`，或看 status 的 `ledger.recent`。文件超过 2000 行会自动压到最近 500 行。

## 常见问题排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `/_task-notify/status` 返回 404 | `apply()` 没跑：包没进 profile、bundles 没加、或 patch 写成了顶层扁平 `- id:`。查 plugin manager 的 `list_plugins`，应有 `include:task-notify` + `fiberPhase: active`。 |
| 加载时报 `Cannot find package '@deepseek-ai/schemastery'` | `@deepseek-ai/schemastery` 同时写进 `dependencies` 和 `peerDependencies` 时，pnpm 按 peer 处理、**不会**装进依赖树。本机因别的插件把它提升到 profile 根而假绿，干净机器上必炸。宿主侧 bare import 只能写进 `dependencies`，`peerDependencies` 留给宿主运行时自己提供的东西。 |
| `skippedUnbound` 一直涨 | `targets` / `workspaces` 缺 botId 或 targetId（半截配置会被整项丢弃），或该 `botId` 不在 `bots` 里 / `channel` 对不上。对照状态路由的 `bots` 核对。 |
| `notified` 涨但某个渠道没收到 | 单个目标失败不会影响其它目标，但只会在日志里留一条 warn（`send not accepted: ...` / `send failed: ...`，带 `code`）。按 `targetId` 搜日志定位是哪个目标。 |
| 「有时候」不发通知，想查是哪一步没走通 | 看账本 `~/.dsh/task-notify/ledger.jsonl`（或 status 的 `ledger.recent`）：只有 `turn` 没后续 = 卡在某个过滤/去重；`failed` = 平台拒收（看 `err`）；`unbound` = 目标没绑或账户掉线；`watching` / `suppressed` = 按设计没推。0.9.2 之前只有内存计数、重启即清零，历史无从查证。 |
| 微信 notified 但没收到 | `{sent:true}` 只代表平台接口接受，不代表送达。微信主动投递还需要用户消息里携带过的 `context_token`；先给机器人发一条微信消息再触发。 |
| 某个通道 / 账户不想收了 | 把那条目标 `enabled: false`（不用删配置）；全停用等于该工作区未绑定，`skippedUnbound` 会涨、日志写 `no enabled target bound`。 |
| 会话要你选择时没收到通知 | `notifyQuestions` 被关了；subagent 默认也不推（`skipSubagents`）。看 `questions` 计数涨没涨——涨了说明事件到了，是没绑目标或账户不在线。 |
| 我明明在看这个会话，它还推了 | 判定要求三条同时成立：页面可见、上报还新鲜、最近 `afkAfterMs` 内有鼠标/键盘操作。只看不动的画面超过 2 分钟就会被当作人不在（这是刻意的，宁可多推）；`skipWhenWatching` 关掉、或 `afkAfterMs` 调小都会让它更容易推。`presence` 为 0 说明客户端根本没上报（CLI / 没开 Web GUI / 老宿主没有 `sidebarRight.mounted`）。 |
| 重启过 DSH 之后，点「试一下桌面提醒」没反应 | 宿主重启后信箱从 seq 1 重新编号，而浏览器里记着上一轮的消费游标（比如 6）——新版客户端会按信箱纪元（`epoch`）或编号倒退自动对齐（0.10.4+），刷新页面即可；更老的版本若卡住，手动清掉 localStorage 的 `dsh-task-notify:alertCursor` 再刷新。 |
| 桌面气泡 / 提示音 / 标签页标记都没有 | 这三样只活在前端：页面得开着（关掉页面只剩 IM），`desktopNotice` / `titleBadge` 得勾上，提示音别选 `none`。看 status 的 `alerts.since` 涨没涨——涨了说明提醒已产出，是浏览器侧没弹（权限被拒 / 标签页不在前台）。 |
| 点桌面气泡没跳过去 | 老宿主没有 `uiWorkspace.openSession` 时会退回 `sessions.open`，两者都不可用（比如权限缺）就只切回窗口。气泡按会话 id 打 tag，同一会话多条只留最新一条。 |
| 点了「试一下桌面提醒」也没有气泡 | 先看卡片右侧那行权限状态：显示「还没允许通知」就点「允许系统通知…」；「已拒绝」就去地址栏站点设置改回允许。再查 Windows 通知设置：专注助手/勿扰模式，以及「Google Chrome / 该浏览器」的通知开关。status 里 `alerts.polls` 不涨说明页面根本没在轮询（页面要刷新到新版本，或开着的是别的主机端口）。 |
| 气泡几秒就自己消失了 | 想要一直挂着就勾上「气泡常驻」（`noticeSticky`，置 `requireInteraction`）；Windows 的「设置 → 辅助功能 → 视觉效果/通知」里的显示时长、以及专注助手/勿扰模式优先级更高，那部分插件改不了。 |
| 提示音不响、只弹气泡 | 浏览器禁止无手势自动播放：页面加载后点一次「试听」（或任意点击）即解锁。音量/静音是系统与浏览器标签页各自的设置，插件不改它们。 |
| 标签页一直是 `(1)` 不恢复 | 标记只在页面重新可见或窗口获得焦点时清；一直挂着不动就会一直挂着（这是刻意的，提醒你还没回那条会话）。 |
| 通知太吵 | `skipSubagents: true` 过滤 subagent；`statuses` 里关掉不关心的类型（如 `forked: false`、`blocked: false`）；`onlyWorkspaces` 只留常驻工作区。多轮就是一条一轮地推（有意为之，方便「每轮干完都知道」），要彻底静音就把目标 `enabled: false`。 |
| `filtered` 涨但一条没收到 | `statuses` 把这种结束原因关了（`filtered` 数被开关拦下的轮次）。看 `statuses` 哪项是 `false`。 |
| 任务中断了却没收到通知 | 多半是自动继续插件接手了：`error` / `interrupted` / `max-tokens` 会先等 `autoContinueGraceMs`，期间被 dsh-auto-continue 续跑接上就不推（`suppressed` 涨 1）。想无论如何都收到，把 `autoContinueGraceMs` 设为 `0`。 |
| 同一个会话里第二轮起就收不到通知（v0.8.1 修） | 0.8.0 及以前的去重键只有「会话 + 结束原因」、漏了轮次，于是**一个会话只会推第一条**，之后每一轮都静默进 `deduped`（新建工作区里连跑几轮最明显：只看得到第一条）。0.8.1 起键里带 `turn`：每轮各推一条，同一轮的事件重放才吞。验法：同一个会话连跑两轮，`deduped` 不涨而 `notified` 按轮涨。 |
| 某个工作区没通知、别的有 | 检查 `workspaces` 的键：先按完整 `cwd` 匹配、再按目录名匹配，两者都没命中才回落默认 `targets`。 |
| 改了 repo 代码但行为没变 | pnpm 装进 profile 的是真实拷贝。重新跑上面的 install，或直接改 `node_modules\dsh-task-notify\lib\index.js`。 |
| 设置里找不到 dsh-task-notify 的配置行 | 卡片挂在「插件 → 已安装」的**行配置**上，不是独立的设置页（宿主 rc.1 后只保留 `plugins.row.config` 这一个 slot）。若整行没有入口，先确认插件已挂载（状态路由 200）。 |
| 卡片写着「桥未注册」 | 服务端没跑或版本对不上：`/api/dsh-task-notify-settings/describe` 是 404 就是桥没注册，先查 `/_task-notify/status` 是否 200。 |
| 点「选收件人」没反应（v0.6.1 修） | 两个原因：① 这一行的 `botId` 是空的（旧版直接 `return`，什么都不做）—— 点上面的「+ 渠道 · …」按钮会自动填上；② botId 填了但 dsh-im 侧一条收件目标都没有（新机器常见），要去 设置 → 集成 → 该机器人 → 投递设置 →「从已聊过的会话选择」先建一条。v0.6.1 起两种情况都会在卡片上说清原因。 |
| 点「+ 渠道 · …」加了收件目标、卡片里却不出现（v0.7.0 修） | 桥和 `/_task-notify/status` 原来拿**归一化后**的配置去 describe，而归一化会把 `targetId` 为空的半填行整项丢弃 —— 写盘成功、回读却是空列表，界面表现就是「点了没反应」。v0.7.0 起 describe 走 `storedRules()`（只补默认值、不丢行），归一化只留给投递路径；`/_task-notify/status` 的 `targets` 现在能看到那行空的 `targetId`。 |
| 通知里「会话」那行是 uuid、卡片「通知哪些工作区」只列出一个（v0.7.1 修） | 标题原来只问 `ctx.sessionTitle`（本插件没 inject 到那个服务，永远拿不到）——v0.7.1 起改读会话事件流里最后一条 `session/title`，你重命名后的标题也认；工作区勾选列表原来只列跑过任务的，现在读宿主登记表 `~/.dsh/storages/workspace.json`，把全部工作区都列出来（括号里是会话数）。 |
| 卡片上按钮毫无反应、没有红字 | v0.6.1 之前 `bridgePost` 的 fetch / JSON 解析异常会直接 reject，调用方没接住。旧版本请先看浏览器控制台；新版会把「连不上设置桥」「返回 HTTP 401 而不是 JSON」直接显示在卡片底部。 |
| DSH 启动即崩，报 `invalid plugin, expect function or object with an "apply" method, received undefined`（v0.5.0 修） | `lib/client.js` 的工厂**没有 `return module.exports`**。宿主 cordis 拿工厂返回值当插件对象，只往 `exports` 上挂而不 return，得到 undefined 就崩。宿主自己 grep 不到这个字符串（它在 `app.asar/app.asar` 内层），错误原文见 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`。`test/client.mjs` 里已加断言兜这条：`factory()` 的返回值必须有 `apply`。 |

## 文件

```
lib/index.js       插件本体（Config / apply / 文案 / 去重 / 多渠道扇出 / 状态路由 / 桥接线）
lib/bridge.js      设置桥：describe / mutate / targets / test / presence / alerts 回环路由
lib/client.js      设置卡片（window.__ModuleLoader__.load 形态，挂 plugins.row.config）
cordis.patch.yml   bundle patch（- insert: 创建 loader 条目 + 配置示例）
package.json       main=lib/index.js, exports./client=lib/client.js, dsh.bundle.patch / dsh.client
README.md          本文件
test/selftest.mjs  服务端自检（54 项断言）
test/client.mjs    设置卡片自检（假 window + 假 react，渲染成纯对象树断言；含按钮点击、字段/工作区勾选写回、桥失败的回归用例，11 组）
```