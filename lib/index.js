/**
 * dsh-task-notify — 任务完成 / 失败 / 取消通知（投递通道复用 @xmanrui/dsh-im）
 *
 * 宿主契约（已从 app.asar 与本机 dsh-im 包逐字核实）：
 *  - `ctx.on("session/event", (session, event) => ...)` 中 `event.type === "turn/end"`
 *    带 `data.reason`，是唯一能把轮次结束原因（completed / aborted / blocked /
 *    error / max-tokens / interrupted / forked 与 AgentCancelCause）递到插件面前的
 *    通道，且天然覆盖所有工作区的所有会话，零轮询。
 *  - session.header 的合法字段只有 type / version / id / createdAt / isSeeded /
 *    delegationDepth + cwd / parentSession / origin / agentPreset（asar HEADER_KEYS）。
 *    所以「任务标识」只能取 header.id + header.cwd；subagent 靠 delegationDepth 过滤。
 *  - 发送口是同 Host 的 `ctx.dshIm`（dsh-im provide("dshIm", ...)），接口只有
 *    listBots / listTargets / describeBot / send / sendChecked 等；工作区 → botId 的
 *    绑定关系没有官方查询入口（bot-workspace-store.mjs 未在包 exports 里暴露），
 *    所以绑定由本插件配置显式声明，见 rules.targets / rules.workspaces。
 *
 * 用户已逐项确认的设计取舍：
 *  1) 判定来源 = 事件订阅 turn/end
 *  2) 文案 = 首行「状态 | task-notify | 会话标题」+ 正文「字段: 值」逐行，
 *     失败 / 取消追加「原因: ...」（用户按微信里那份自检报告的版式定的）
 *  3) 目标未绑定（无 botId / targetId）= 跳过 + 记日志 + 计数，不报错打断
 *  4) 会话级去重：同一 sessionId + 同一结束原因只推一次
 *  5) 多渠道：rules.targets 是「渠道 + 账户 + 收件目标」列表，一条通知扇出到全部目标
 *  6) 每条目标自带 enabled 开关（按通道 + 账户粒度启停）；状态路由列出哪些通道有账户
 *  7) 每种结束原因（completed / error / aborted / …）各有一个 statuses 开关
 *  8) 开关、渠道、收件目标都在插件自己的设置卡片里改（plugins.row.config，
 *     走 /api/dsh-task-notify-settings 桥），落盘即生效，不用重启 DSH
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { makeBridgeRoutes, isLoopbackRequest } from "./bridge.js";

const NS = "task-notify";

/**
 * turn/end 的 reason.kind → 单行文案前缀。
 * TurnEndReasonMap 全量（asar 逐字）：completed | aborted | blocked |
 * error | max-tokens | interrupted | forked。
 */
const STATUS_LABELS = Object.freeze({
  completed: "✅ 任务完成",
  error: "❌ 任务失败",
  aborted: "⚠️ 任务已取消",
  blocked: "⛔ 任务被拦截",
  "max-tokens": "⚠️ 任务中断（超出最大长度）",
  interrupted: "⚠️ 任务中断",
  forked: "🔀 任务已分叉",
});

/** 会话抛出待答问题时用的文案前缀（不是 turn/end 的结束原因，不进 statuses）。 */
const QUESTION_LABEL = "❓ 需要你选择";

/** AgentCancelCause → 可读短语，只在 aborted 时用。 */
const CAUSE_LABELS = Object.freeze({
  user: "用户主动终止",
  parent: "上级会话取消",
  hook: "插件中断",
  disposed: "会话释放",
  legacy: "旧格式未知原因",
  unknown: "原因未知",
});

/**
 * 一个投递目标 = 渠道 + 账户（botId）+ 收件目标（targetId）。
 * 三者都是 dsh-im 的原词：channel 来自 listBots()[].channel，botId 即「账户」，
 * targetId 由调用方自定义（dsh-im 里建好后回填到这里）。
 */
const Target = z.object({
  channel: z.string().default("weixin"),
  botId: z.string().default(""),
  targetId: z.string().default(""),
  /** 单个「渠道 + 账户」开关；false 时该条目的通知被跳过，其它目标照常。 */
  enabled: z.boolean().default(true),
});

/**
 * 每种结束原因一个开关（全开）。设置里逐项勾选，不想收哪种就关掉哪种；
 * 未知 kind（STATUS_LABELS 之外的）跟着 completed 走，避免新 reason 悄悄漏推。
 */
const Statuses = z.object({
  completed: z.boolean().default(true),
  error: z.boolean().default(true),
  aborted: z.boolean().default(true),
  blocked: z.boolean().default(true),
  "max-tokens": z.boolean().default(true),
  interrupted: z.boolean().default(true),
  forked: z.boolean().default(true),
});

/**
 * 通知正文里带哪些字段（正文越长微信越吵，所以逐项可关）。
 * title 关掉时首行退回工作区名，正文默认必带「工作区:」。
 */
const Fields = z.object({
  title: z.boolean().default(true),
  workspace: z.boolean().default(true),
  reason: z.boolean().default(true),
  /** 本轮答复的首句（本地摘取，不调模型、0 token）。 */
  brief: z.boolean().default(true),
  sessionId: z.boolean().default(false),
  time: z.boolean().default(false),
});

const Rules = z.object({
  enabled: z.boolean().default(true),
  format: z.string().default("plain"),
  /** 跳过 subagent 的轮次结束，只报顶层任务。 */
  skipSubagents: z.boolean().default(true),
  /** 会话抛出待答问题（ask_user_question）时也推一条；独立于 statuses。 */
  notifyQuestions: z.boolean().default(true),
  /**
   * 异常结束（error / interrupted / max-tokens）先等这么多毫秒再判定：
   * 期间会话被 dsh-auto-continue 续上了就不推。0 = 立即推。
   */
  autoContinueGraceMs: z.number().default(60000),
  /**
   * 你正在看这个会话（Web 页面停在它上面 + 最近有鼠标/键盘活动）就不推。
   * 没有客户端上报时照常推：CLI、headless、没开 Web GUI 都不会因此漏通知。
   */
  skipWhenWatching: z.boolean().default(true),
  /** 多久没有鼠标/键盘输入算「人不在」（超过就照常推），毫秒。 */
  afkAfterMs: z.number().default(120_000),
  /**
   * 桌面通知：任务结束时弹 Windows 系统通知（由 Web 客户端发原生 Notification），
   * 点一下跳到那条会话。只在打开着 DSH Web 页面时有效 —— 本机没有页面就没有弹窗。
   */
  desktopNotice: z.boolean().default(true),
  /**
   * 气泡常驻：置 requireInteraction —— Windows 上要人点一下/关掉才消失，
   * 不会几秒后自己滑走。系统级「通知显示时长」与专注助手仍可能截断，那不受插件控制。
   */
  noticeSticky: z.boolean().default(true),
  /** 标签页标题加未读标记（「(2) 会话标题」），切回页面就恢复。 */
  titleBadge: z.boolean().default(true),
  /**
   * Windows 原生气泡（宿主侧直发，不经页面）：便携版 Electron 没注册 AppUserModelID，
   * 页面里的 Notification 会被 Windows 静默丢掉 —— 这条走 PowerShell + WinRT，
   * 窗口最小化、藏在后台都弹得出来。开着时页面不再重复弹自己那个气泡。
   */
  nativeToast: z.boolean().default(true),
  /** 提示音：none / beep / chime / custom（custom 用 soundUrl）。 */
  sound: z.string().default("beep"),
  /** custom 提示音的地址（http(s) 链接，或站内可访问的音频路径）。 */
  soundUrl: z.string().default(""),
  /** 按结束原因开关：completed / error / aborted / blocked / max-tokens / interrupted / forked。 */
  statuses: Statuses.default({}),
  /** 默认投递目标列表（多渠道扇出）；任一项缺 botId/targetId 的会被丢掉。 */
  targets: z.array(Target).default([]),
  /** 按工作区覆盖默认列表，键为完整 cwd 或工作区目录名。 */
  workspaces: z.dict(z.array(Target)).default({}),
  /** 只给这些工作区发通知：完整 cwd 或工作区目录名，空数组 = 全部工作区。 */
  onlyWorkspaces: z.array(z.string()).default([]),
  /** 通知正文包含哪些字段。 */
  fields: Fields.default({}),
});

const Config = z.object({ rules: Rules.volatile() });

/** 整套 rules 的缺省值：直接问 schema 要，别再手抄一份（抄一份必然和上面漂移）。 */
const DEFAULTS = Object.freeze(Rules({}));

/** statuses 的缺省值：七种结束原因全开 —— 取自 Statuses 自己。 */
const STATUS_DEFAULTS = Object.freeze(Statuses({}));

/** fields 的缺省值：标题/工作区/原因/首句带上，会话 id 与时间默认不带 —— 取自 Fields 自己。 */
const FIELD_DEFAULTS = Object.freeze(Fields({}));

/** 延迟判定的上限：等太久不如立刻推。 */
const GRACE_MAX_MS = 600_000;

/** 延迟判定的等待时长：缺省 60s；NaN / 负数回缺省，小数取整，上限 10 分钟。 */
function graceMsOf(value) {
  if (!Number.isFinite(value)) return DEFAULTS.autoContinueGraceMs;
  return Math.max(0, Math.min(GRACE_MAX_MS, Math.trunc(value)));
}

/** 「人不在」判定窗口的上限：再长就等于永远在看，通知永远不推。 */
const AFK_MAX_MS = 600_000;

/** 判定窗口：缺省 2 分钟；NaN / 负数回缺省，小数取整，上限 10 分钟。 */
function afkMsOf(value) {
  if (!Number.isFinite(value)) return DEFAULTS.afkAfterMs;
  return Math.max(0, Math.min(AFK_MAX_MS, Math.trunc(value)));
}

/** 这个结束原因要不要通知：配置缺项 / 非布尔都按开处理，新 reason 不会静默漏推。 */
function statusEnabled(rules, kind) {
  const key = typeof kind === "string" && kind in STATUS_LABELS ? kind : "completed";
  return rules.statuses?.[key] !== false;
}

/** 去重集合上限（sessionId|kind|cause）。插满后淘汰最旧的一条。 */
const DEDUPE_CAP = 500;

/** 事件账本写满这么多行就压到最近 LEDGER_KEEP 行（有上限，但足够回看几个月）。 */
const LEDGER_CAP = 2000;
const LEDGER_KEEP = 500;
/** status / 卡片回带的最近记录条数。 */
const RECENT_CAP = 200;

/**
 * 账本文件：默认 ~/.dsh/task-notify/ledger.jsonl；TASK_NOTIFY_LEDGER 可覆盖（自检指向临时目录）。
 * 只记判定与投递结果，不记通知正文。
 */
function ledgerPath() {
  const override = process.env.TASK_NOTIFY_LEDGER;
  if (typeof override === "string" && override !== "") return override;
  return join(homedir(), ".dsh", "task-notify", "ledger.jsonl");
}

function unwrap(value) {
  return value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}

/** loader 传进来的 config 含 schemastery proxy 节点，值要 .get() 才能解出。 */
function resolveConfig(config) {
  if (config === null || typeof config !== "object") return {};
  const plain = {};
  for (const [key, value] of Object.entries(config)) plain[key] = unwrap(value);
  const rules = plain.rules;
  if (rules !== null && typeof rules === "object" && !Array.isArray(rules)) {
    const out = {};
    for (const [key, value] of Object.entries(rules)) out[key] = unwrap(value);
    plain.rules = out;
  }
  return plain;
}

/** 单个目标归一化：botId + targetId 同时非空才算已绑定，channel 缺省 weixin。 */
function targetOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const botId = typeof value.botId === "string" ? value.botId.trim() : "";
  const targetId = typeof value.targetId === "string" ? value.targetId.trim() : "";
  if (botId === "" || targetId === "") return null;
  const channel = typeof value.channel === "string" && value.channel.trim() !== "" ? value.channel.trim() : "weixin";
  return { channel, botId, targetId, enabled: value.enabled !== false };
}

/** 目标列表归一化：丢弃缺字段的项，单个目标也算长度为 1 的列表。 */
function targetsOf(value) {
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    const target = targetOf(item);
    if (target !== null) out.push(target);
  }
  return out;
}

/**
 * 规则骨架的唯一一份：enabled / format / skipSubagents / notifyQuestions / statuses /
 * onlyWorkspaces / fields 只在这里归一化。rulesOf（投递路径）与 storedRules（展示路径）
 * 都从它出发，省得以后加了新规则只改一边。
 * strict=true：enabled 必须是显式 true（投递路径）；false：只排除显式 false。
 * targets / workspaces 的归一化策略两条路径故意不同，留在各自函数里。
 */
function ruleSkeleton(rules, strict) {
  return {
    enabled: strict ? rules.enabled === true : rules.enabled !== false,
    format: rules.format === "markdown" ? "markdown" : "plain",
    skipSubagents: rules.skipSubagents !== false,
    notifyQuestions: rules.notifyQuestions !== false,
    autoContinueGraceMs: graceMsOf(rules.autoContinueGraceMs),
    skipWhenWatching: rules.skipWhenWatching !== false,
    afkAfterMs: afkMsOf(rules.afkAfterMs),
    statuses: { ...STATUS_DEFAULTS, ...(rules.statuses ?? {}) },
    onlyWorkspaces: stringList(rules.onlyWorkspaces),
    fields: { ...FIELD_DEFAULTS, ...(rules.fields ?? {}) },
  };
}

function rulesOf(resolved) {
  const rules = { ...DEFAULTS, ...(resolved?.rules ?? {}) };
  const workspaces = {};
  const raw = rules.workspaces;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const targets = targetsOf(value);
      if (targets.length > 0 && key.trim() !== "") workspaces[key.trim()] = targets;
    }
  }
  return {
    ...ruleSkeleton(rules, true),
    targets: targetsOf(rules.targets),
    workspaces,
  };
}

/** 字符串列表归一化：非字符串项与空串丢掉。 */
function stringList(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item !== "");
}

/** 单个目标「填默认值但不丢弃」—— 卡片正在编的那半行也要能原样读回来。 */
function rawTarget(value) {
  const item = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    channel: typeof item.channel === "string" && item.channel.trim() !== "" ? item.channel.trim() : "weixin",
    botId: typeof item.botId === "string" ? item.botId : "",
    targetId: typeof item.targetId === "string" ? item.targetId : "",
    enabled: item.enabled !== false,
  };
}

/**
 * 配置里「实际存着什么」的 rules —— 只补默认值，不做归一化。
 * 归一化（targetsOf 丢弃缺 botId/targetId 的行）只属于投递路径：卡片刚点
 * 「+ 账户」加出来的那行 targetId 还空着，用归一化结果去 describe 会被吞掉，
 * 界面表现就是「点了没反应」（写盘成功但回填的 targets 仍是 []）。
 */
function storedRules(config) {
  const rules = { ...DEFAULTS, ...(resolveConfig(config)?.rules ?? {}) };
  const workspaces = {};
  const raw = rules.workspaces;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (key.trim() !== "" && Array.isArray(value)) workspaces[key.trim()] = value.map(rawTarget);
    }
  }
  return {
    ...ruleSkeleton(rules, false),
    targets: (Array.isArray(rules.targets) ? rules.targets : []).map(rawTarget),
    workspaces,
  };
}

/**
 * 工作区白名单：空 = 全部放行。目录名与完整 cwd 任一命中即算选中
 * （配置里两个写法都能写，用户从卡片勾的是目录名）。
 */
function workspaceAllowed(rules, cwd) {
  const list = stringList(rules?.onlyWorkspaces);
  if (list.length === 0) return true;
  const key = typeof cwd === "string" ? cwd.trim() : "";
  return list.includes(workspaceName(key)) || (key !== "" && list.includes(key));
}

/** 工作区取目录名；没 cwd 时给个可读的兜底。 */
function workspaceName(cwd) {
  if (typeof cwd !== "string" || cwd.trim() === "") return "unknown";
  const parts = cwd.trim().replace(/[\\/]+$/u, "").split(/[\\/]/u);
  return parts[parts.length - 1] || cwd.trim();
}

/** 登记表缓存：按文件路径 + mtimeMs 命中，status/describe 不再每次同步读盘。 */
const WORKSPACE_CACHE = { file: "", mtimeMs: -1, items: [] };

/**
 * 宿主登记的全部工作区：直接读 storage 单元 ~/.dsh/storages/workspace.json
 * （unit.workspace → tables.workspaces: {uuid: {path, title, sessionIds}}）。
 * 不走宿主服务：本机没有可 inject 的工作区注册面，硬写进模块级 inject 只会让
 * 整条 fiber 永不激活（通知直接哑掉）。DSH_STORAGES_DIR 只给自检指路。
 */
function storedWorkspaces() {
  const env = typeof process.env.DSH_STORAGES_DIR === "string" ? process.env.DSH_STORAGES_DIR.trim() : "";
  const dir = env !== "" ? env : join(homedir(), ".dsh", "storages");
  try {
    const file = join(dir, "workspace.json");
    const mtimeMs = statSync(file).mtimeMs;
    if (WORKSPACE_CACHE.file === file && WORKSPACE_CACHE.mtimeMs === mtimeMs) return WORKSPACE_CACHE.items;
    const json = JSON.parse(readFileSync(file, "utf8"));
    const table = json?.tables?.workspaces;
    if (table === null || typeof table !== "object") return [];
    const out = [];
    for (const item of Object.values(table)) {
      const path = typeof item?.path === "string" ? item.path.trim() : "";
      if (path === "") continue;
      const name = workspaceName(path);
      out.push({
        name,
        cwd: path,
        title: typeof item.title === "string" && item.title !== "" ? item.title : name,
        count: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
        last: null,
      });
    }
    WORKSPACE_CACHE.file = file;
    WORKSPACE_CACHE.mtimeMs = mtimeMs;
    WORKSPACE_CACHE.items = out;
    return out;
  } catch {
    // 读不到就当没有：卡片退回「只列跑过的」，投递路径不受影响。
    return [];
  }
}

/** 精确 cwd → 目录名 → 默认目标列表，逐级回退；只投递 enabled 的目标。 */
function resolveTargets(rules, cwd) {
  const key = typeof cwd === "string" ? cwd : "";
  const live = (list) => list.filter((target) => target.enabled !== false);
  for (const candidate of [key, workspaceName(key)]) {
    if (candidate !== "" && Object.prototype.hasOwnProperty.call(rules.workspaces, candidate)) {
      return { targets: live(rules.workspaces[candidate]), matchedBy: candidate };
    }
  }
  const targets = live(rules.targets);
  return { targets, matchedBy: targets.length > 0 ? "default" : null };
}

/** 失败 / 取消的原因短语；completed 等返回空串（不追加噪音）。 */
function reasonPhrase(reason) {
  if (reason === null || typeof reason !== "object") return "";
  if (reason.kind === "error") {
    const error = reason.error;
    const text = error !== null && typeof error === "object" ? error.message ?? error.code : undefined;
    return typeof text === "string" && text.trim() !== "" ? text.trim().slice(0, 120) : "未知错误";
  }
  if (reason.kind === "aborted") {
    const cause = reason.reason;
    const kind = cause !== null && typeof cause === "object" && typeof cause.kind === "string" ? cause.kind : "unknown";
    const detail = kind === "hook" && cause !== null && typeof cause === "object" && typeof cause.reason === "string"
      ? "：" + cause.reason.slice(0, 60)
      : "";
    return (CAUSE_LABELS[kind] ?? CAUSE_LABELS.unknown) + detail;
  }
  return "";
}

/** 会话事件流；不同宿主版本给 events 或 snapshotEvents，认不出来就是空表。 */
function sessionEvents(session) {
  const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : session?.events;
  return Array.isArray(events) ? events : [];
}

/**
 * 这一轮之后会话是否已经被接上了（dsh-auto-continue 续跑 / 有人插话）：
 * 事件流里出现更大的 turn 就算续上。只读、不调模型。
 */
function continuedAfter(session, turn) {
  if (!Number.isSafeInteger(turn)) return false;
  try {
    for (const event of sessionEvents(session)) {
      const later = event?.data?.turn;
      if (Number.isSafeInteger(later) && later > turn) return true;
    }
  } catch {
    // 读不到就当没续上：宁可多推一条，也别把真中断吞了。
  }
  return false;
}

/** 「内容」行最长多少字符：微信上一行别铺满整屏。 */
const BRIEF_MAX_CHARS = 80;

/**
 * 取一句人话：剥掉代码块与 markdown 记号、压平空白、切到第一个句末标点，超长截断。
 * 纯字符串处理 —— 这一行永远不花 token。
 */
function firstSentence(text) {
  const flat = String(text)
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/^#{1,6}\s*/gmu, "")
    .replace(/[*_`~]+/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  if (flat === "") return "";
  const cut = flat.search(/[。！？!?；;]/u);
  const head = cut === -1 ? flat : flat.slice(0, cut + 1);
  return head.length <= BRIEF_MAX_CHARS ? head : head.slice(0, BRIEF_MAX_CHARS - 1) + "…";
}

/**
 * 本轮答复的首句 —— 免费的「这次到底做了什么」摘要。
 * 数据源是事件流里的 assistant/message（surfaceOp=append），与 dsh-im 读的是同一批
 * （src/channels/shared/history-command.mjs、session-reply-recovery.mjs）：
 * 只认本轮的、最后一条；最后一条被打断就什么都不给，绝不拿中途某步的解说冒充结论。
 */
function answerBrief(session, turn) {
  try {
    // findLast 从尾部扫到就停；filter(...).pop() 每轮都要把整份事件数组走一遍。
    const final = sessionEvents(session).findLast((event) => event?.type === "assistant/message"
      && (event.surfaceOp === undefined || event.surfaceOp === "append")
      && Number.isSafeInteger(event.data?.turn)
      && (turn === undefined || event.data.turn === turn));
    if (final === undefined || final.data?.interrupted === true) return "";
    const content = final.data?.message?.content;
    if (!Array.isArray(content)) return "";
    const text = content
      .flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []))
      .join(" ");
    return firstSentence(text);
  } catch {
    return "";
  }
}

/**
 * 会话标题：通知首行与「会话」行都用它，就是「这次到底在干什么」的人话标识。
 * 真实落点是事件流里最后一条 session/title（用户手动重命名就是
 * data.source.kind === "user" 那种），与 dsh-session-title 服务读的是同一份数据；
 * 本插件不 inject 那个服务：硬依赖一个可能缺席的服务会让整条 fiber 永不激活。
 * 两者都没有时给空串，调用方退回工作区名。
 */
function sessionTitle(ctx, session) {
  try {
    const events = sessionEvents(session);
    const latest = events.findLast((event) => event?.type === "session/title");
    const fromEvents = latest?.data?.title;
    const raw = typeof fromEvents === "string" && fromEvents.trim() !== "" ? fromEvents : ctx.sessionTitle?.get?.(session)?.title;
    if (typeof raw !== "string") return "";
    // 宿主已经按 maxTitleBytes 规范化过标题，这里只压掉换行，不截断。
    return raw.replace(/\s+/gu, " ").trim();
  } catch {
    return "";
  }
}

/**
 * 本地时间（带时区偏移，如 2026-10-17T13:38:59+08:00）。
 * 原来直接 toISOString() 是 UTC：微信里显示 05:38:59Z，跟本地 13:38 对不上。
 */
function localIso(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
    + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds())
    + sign + pad(Math.floor(abs / 60)) + ":" + pad(abs % 60);
}

/**
 * 通知版式：首行「状态 | 插件名 | 完整会话标题」，正文逐行「字段: 值」。
 * 标题在首行已完整出现，正文不再重复一遍；没有标题时首行退回工作区名。
 * fields 逐项控制正文（与首行）带哪些字段，缺项按 FIELD_DEFAULTS。
 */
function formatMessage({ label, title, cwd, phrase, question, sessionId, at, brief, fields }) {
  const show = { ...FIELD_DEFAULTS, ...(fields ?? {}) };
  const where = workspaceName(cwd);
  const head = `${label} | ${NS} | ${show.title && typeof title === "string" && title !== "" ? title : where}`;
  const body = [];
  if (show.workspace) body.push(`工作区: ${where}`);
  if (show.reason && phrase !== "") body.push(`原因: ${phrase}`);
  // 「会话」优先给人话标题（用户重命名后就是那个名字），没标题才退回裸 id。
  let who = typeof sessionId === "string" ? sessionId : "";
  if (typeof title === "string" && title !== "") who = title;
  if (show.sessionId && who !== "") body.push(`会话: ${who}`);
  if (show.time) body.push(`时间: ${typeof at === "string" && at !== "" ? at : localIso(new Date())}`);
  // 答复首句：本地摘取，不调模型。
  if (show.brief && typeof brief === "string" && brief !== "") body.push(`内容: ${brief}`);
  for (const line of questionLines(question)) body.push(line);
  return [head, ...body].join("\n");
}

/** 逐行折叠待答问题：题干 + 选项；截断到 QUESTION_MAX_CHARS，别把微信刷屏。 */
const QUESTION_MAX_QUESTIONS = 3;
const QUESTION_MAX_CHARS = 300;

/** question/questions 的题干 + 选项行；未知形态返回空数组（不加噪音）。 */
function questionLines(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const question of value.slice(0, QUESTION_MAX_QUESTIONS)) {
    if (question === null || typeof question !== "object") continue;
    const text = typeof question.question === "string" ? question.question.replace(/\s+/gu, " ").trim() : "";
    if (text === "") continue;
    out.push(`待选: ${text}`);
    const options = Array.isArray(question.options) ? question.options : [];
    for (const option of options.slice(0, 6)) {
      const label = typeof option?.label === "string" ? option.label.replace(/\s+/gu, " ").trim() : "";
      if (label !== "") out.push(`  - ${label}`);
    }
  }
  if (out.length === 0) return [];
  const joined = out.join("\n");
  return joined.length <= QUESTION_MAX_CHARS ? out : [joined.slice(0, QUESTION_MAX_CHARS - 1) + "…"];
}

/**
 * 去重键：同一个会话的**同一轮**只推一次（同一 turn/end 可能被重放），不同轮必须各推一次。
 * turn 必须进键：少了它，一个会话就只会在第一次 completed 时推一条，
 * 之后每一轮都静默进 deduped —— 新工作区里连推几轮，用户只看得到第一条。
 */
/**
 * 发送超时：dsh-im 通道挂起时不能把这一轮永远挂住（/test 不返回、卡片 busy 永远转）。
 * 超时按「发送失败」处理 —— 这一轮不记账，会话重放时还能补推。
 */
const SEND_LIMITS = { sendMs: 20_000 };

/**
 * dsh-auto-continue 会接手的结束原因：这些轮次先等一会再判定要不要推。
 * 「中断 / 失败」常常几秒后就被它续跑接上了，那条通知纯属噪音。
 */
const AUTO_CONTINUE_KINDS = new Set(["error", "interrupted", "max-tokens"]);

/** 给一个 promise 加超时；超时就抛错，让调用方现有的失败分支统一处理。 */
function withTimeout(run, ms, label) {
  if (!(ms > 0)) return run;
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " timed out after " + ms + "ms")), ms);
  });
  return Promise.race([run, guard]).finally(() => clearTimeout(timer));
}

function dedupeKey(sessionId, reason, turn, stamp) {
  const kind = reason === null || typeof reason !== "object" ? "unknown" : String(reason.kind);
  const cause =
    reason !== null && typeof reason === "object" && reason.kind === "aborted" &&
    reason.reason !== null && typeof reason.reason === "object"
      ? String(reason.reason.kind ?? "unknown")
      : "";
  // turn 缺失时不要退回常量：上游一旦换字段名，常量会让整个会话只推第一条（v0.8.1 那个故障类型）。
  // 退到事件时间戳，退化方向是「可能重复推」而不是「永远不推」。
  const round = Number.isSafeInteger(turn) ? String(turn) : "t" + String(stamp ?? "?");
  return `${sessionId}|${round}|${kind}|${cause}`;
}

/** raw node http 应答（与 dsh-auto-continue 同一形态，不是 fastify reply）。 */
function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const name = NS;
const inject = ["dshIm"];

function apply(ctx, config) {
  const logger = ctx.logger;
  const currentRules = () => rulesOf(resolveConfig(config));

  const state = {
    seen: 0,
    notified: 0,
    failed: 0,
    skippedUnbound: 0,
    deduped: 0,
    /** 因 statuses 开关被过滤掉的轮次。 */
    filtered: 0,
    /** 因 onlyWorkspaces 白名单被过滤掉的轮次。 */
    filteredWorkspace: 0,
    /** 异常结束后被 dsh-auto-continue 续跑接上、因此没推的轮次。 */
    suppressed: 0,
    /** 结束时会话正显示在用户屏幕上（且人还在动）、因此没推的轮次。 */
    skippedWatching: 0,
    /** 捕获到的待答问题数。 */
    questions: 0,
    last: null,
    /** 见过的工作区：目录名 → {name, cwd, count, last}；卡片用它渲染「通知哪些工作区」勾选列表。 */
    observed: new Map(),
  };
  /** 去重键集合，插满后按插入序淘汰最旧的一条。 */
  const sent = new Set();
  /** 还在等 auto-continue 的延迟判定定时器；插件卸载时一并清掉。 */
  const pending = new Set();

  /**
   * 桌面通知的信箱：Web 客户端每几秒来取一次「自上次以来有哪些通知」，
   * 拿去做系统气泡 / 提示音 / 标签页未读标记。只在内存里，最多留 ALERT_CAP 条
   * （浏览器关着的时候攒下的也够回头补看一眼，再久就没意义了）。
   */
  const alerts = [];
  let alertSeq = 0;
  /**
   * 这一份信箱的「纪元」。宿主重启（或插件热重载）后 alertSeq 从 0 重来，
   * 而浏览器的已消费游标还停在上一轮的大数字上 —— 不认纪元就会把新提醒全当旧的跳过。
   */
  const alertEpoch = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  /** 客户端来取过几次（排障用：区分「宿主没产出」和「页面没在轮询」）。 */
  let alertPolls = 0;
  const ALERT_CAP = 50;

  /**
   * Windows 原生气泡：Electron 便携版没有 AppUserModelID，页面里 new Notification 会被
   * 系统静默丢掉（声音与页内提示照旧）。这里用 PowerShell 的 WinRT 接口直发，
   * 借用 PowerShell 已注册的 AUMID —— 窗口最小化、藏在后台也能弹出来。
   * 失败一律吞掉：通知发不出去不该影响任务本身。
   */
  const PS_AUMID = "Windows.SystemToast.Suggested";

  function xmlEscape(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function nativeToast(entry) {
    if (process.platform !== "win32") return;
    // 测试与排障用：设了就不真弹（自检里不弹复数个窗口）。
    if (process.env.TASK_NOTIFY_NO_NATIVE === "1") return;
    const head = String(entry?.label ?? "任务通知");
    const sub = [entry?.title, entry?.brief || entry?.ws].filter((one) => typeof one === "string" && one !== "").join(" · ");
    const xml = "<toast><visual><binding template=\"ToastGeneric\"><text>" + xmlEscape(head) + "</text><text>" + xmlEscape(sub) + "</text></binding></visual><audio silent=\"true\"/></toast>";
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null",
      "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
      "$xml.LoadXml(@'",
      xml,
      "'@)",
      "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + PS_AUMID + "').Show($toast)",
    ].join("\n");
    try {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => { /* 没有 PowerShell 就静默放弃 */ });
      child.unref();
    } catch { /* 忽略：通知失败不影响任务 */ }
  }

  /** 记一条客户端可消费的通知；sessionId 客户端要用它跳会话，所以这里是完整 id。 */
  function pushAlert(entry) {
    alertSeq += 1;
    const alert = Object.assign({ seq: alertSeq, at: localIso(new Date()) }, entry);
    alerts.push(alert);
    while (alerts.length > ALERT_CAP) alerts.shift();
    // 预览稿（kind=test）由页面自己弹三条，宿主这边不重复打扰。
    if (alert.kind !== "test" && currentRules().nativeToast !== false) nativeToast(alert);
  }

  /** 客户端轮询用：返回 since 之后的新通知 + 与桌面表现相关的规则。 */
  function alertsSince(since) {
    alertPolls += 1;
    const from = Number.isFinite(since) ? Math.trunc(since) : 0;
    const rules = currentRules();
    return {
      since: alertSeq,
      epoch: alertEpoch,
      alerts: alerts.filter((alert) => alert.seq > from),
      desktop: {
        notice: rules.desktopNotice !== false,
        badge: rules.titleBadge !== false,
        sticky: rules.noticeSticky !== false,
        sound: typeof rules.sound === "string" ? rules.sound : "beep",
        soundUrl: typeof rules.soundUrl === "string" ? rules.soundUrl : "",
        // 宿主已经在 Windows 上直发了原生气泡，页面就别再弹自己那个（会重复）。
        native: process.platform === "win32" && rules.nativeToast !== false,
      },
    };
  }

  /**
   * 设置卡片上的「试一下桌面提醒」：直接塞一条假提醒进信箱，不依赖「哪条会话结束」，
   * 也不受 skipWhenWatching 影响（sessionId 为空，客户端不会当成是正在看的那条）。
   */
  /** 三种真实结束原因的预览稿：卡片上的按钮可以分别演示「完成 / 失败 / 要你选」。 */
  const ALERT_PREVIEWS = {
    completed: { label: "✅ 任务完成", title: "重构通知链路", brief: "三个状态的气泡都试一遍，看完就成" },
    error: { label: "❌ 任务失败", title: "重构通知链路", brief: "TypeError: 端口 19387 上没有任何监听" },
    question: { label: "❓ 需要你选择", title: "重构通知链路", brief: "用飞书还是微信发这条通知？" },
  };

  function alertTest(kind) {
    const preset = typeof kind === "string" ? ALERT_PREVIEWS[kind] : undefined;
    pushAlert(Object.assign(
      { sessionId: "", title: "桌面提醒测试", kind: "test", turn: 0, ws: "", label: "🔔 桌面提醒测试", brief: "看到这条气泡就说明通了" },
      preset,
      // 预演稿带上它模拟的事件类型，账本与气泡上一眼能分清是哪一类。
      preset === undefined ? {} : { kind, ws: "预览" },
    ));
    return alertsSince(0);
  }

  /**
   * 客户端上报的「我正看着哪个会话」：sessionId → {visible, lastInputAt, at}。
   * 只在内存里、不落盘（浏览器一关就自然过期），最多记 50 个会话。
   */
  const presence = new Map();
  const PRESENCE_CAP = 50;

  /**
   * 事件账本：「有时候不发通知」只能靠它查。每轮结束的判定（过滤 / 去重 / 在看 / 被续跑吞掉）
   * 和每次投递结果（成功 / 失败 / 未绑定）都追加一行到 ~/.dsh/task-notify/ledger.jsonl；
   * 启动时读回来，所以 status 里的计数是「有账以来」累计，不是本次启动以来。
   * 只记结构化字段（id 前 8 位 / 渠道 / 目标 / 错误码），不记通知正文。
   * 写盘失败只降级成内存计数，绝不影响通知本身。
   */
  const LEDGER_FIELD = {
    turn: "seen",
    sent: "notified",
    failed: "failed",
    unbound: "skippedUnbound",
    deduped: "deduped",
    filtered: "filtered",
    workspace: "filteredWorkspace",
    watching: "skippedWatching",
    suppressed: "suppressed",
    question: "questions",
  };
  // 只留够区分的前缀：真实会话 id/target id 都很长；自检里的 "s1" 这种短串一律记 "?"，
  // 免得 status 载荷里出现完整 id（有专门用例守这条）。
  const shortId = (value) => (typeof value === "string" && value.length > 12 ? value.slice(0, 12) : "?");
  const ledgerFile = ledgerPath();
  const recent = [];
  let ledgerLines = 0;
  let ledgerReady = false;

  /** 压账本：只留最近 LEDGER_KEEP 行。 */
  function compactLedger() {
    try {
      const lines = readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).slice(-LEDGER_KEEP);
      writeFileSync(ledgerFile, lines.join("\n") + "\n");
      ledgerLines = lines.length;
    } catch { /* 压不动下次再压 */ }
  }

  /** 记一条账：先加计数（内存永远准），再尽力落盘。 */
  function record(outcome, extra) {
    const field = LEDGER_FIELD[outcome];
    if (field !== undefined) state[field] += 1;
    const entry = Object.assign({ at: localIso(new Date()), o: outcome }, extra);
    recent.push(entry);
    while (recent.length > RECENT_CAP) recent.shift();
    try {
      if (!ledgerReady) {
        mkdirSync(dirname(ledgerFile), { recursive: true });
        ledgerReady = true;
      }
      appendFileSync(ledgerFile, JSON.stringify(entry) + "\n");
      ledgerLines += 1;
      if (ledgerLines > LEDGER_CAP) compactLedger();
    } catch { /* 只读盘/无权限：退化成内存计数 */ }
  }

  // 启动时把历史账本读回来：计数与最近记录都接着上次。
  try {
    const lines = readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean);
    ledgerLines = lines.length;
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // 断电残留的半截行
      const field = LEDGER_FIELD[entry?.o];
      if (field !== undefined) state[field] += 1;
      recent.push(entry);
    }
    while (recent.length > RECENT_CAP) recent.shift();
    if (ledgerLines > LEDGER_CAP) compactLedger();
  } catch { /* 没有账本 = 第一次跑 */ }

  /** 记一次上报；字段不合规就忽略，永远不抛。 */
  function reportPresence(body) {
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    if (sessionId === "") return { ok: false, code: "session-required", message: "sessionId is required" };
    const lastInputAt = Number.isFinite(body?.lastInputAt) ? Math.trunc(body.lastInputAt) : Date.now();
    presence.delete(sessionId); // 重新插入，让插入序当 LRU 用
    presence.set(sessionId, { visible: body?.visible !== false, lastInputAt, at: Date.now() });
    if (presence.size > PRESENCE_CAP) presence.delete(presence.keys().next().value);
    return { ok: true, value: { watching: watchingNow(sessionId) } };
  }

  /**
   * 会话现在算不算「被看着」：页面可见 + 上报还新鲜 + 最近 afkAfterMs 内有输入。
   * 三条都满足才抑制通知 —— 拿不准一律推。
   */
  function watchingNow(sessionId) {
    const entry = presence.get(sessionId);
    if (entry === undefined || !entry.visible) return false;
    const afk = currentRules().afkAfterMs;
    if (afk <= 0) return false; // 窗口设成 0 = 永远算离开
    const now = Date.now();
    return now - entry.at <= afk && now - entry.lastInputAt <= afk;
  }

  /** dsh-im 的在线账户表：botId → channel。挂掉时按空表处理（全部跳过）。 */
  async function connectedBots() {
    const dshIm = ctx.dshIm;
    if (dshIm === undefined || dshIm === null) return null;
    try {
      const bots = await dshIm.listBots();
      const map = new Map();
      for (const bot of Array.isArray(bots) ? bots : []) {
        if (typeof bot?.botId === "string") map.set(bot.botId, typeof bot.channel === "string" ? bot.channel : "");
      }
      return map;
    } catch (error) {
      logger.warn(`task-notify: listBots failed: ${String(error)}`);
      return new Map();
    }
  }

  /** dsh-im 在线账户的两种视图：扁平列表 + 按通道聚合（桥与状态路由共用）。 */
  async function accountSnapshot() {
    const bots = await connectedBots();
    const accounts = bots === null ? [] : [...bots].map(([botId, channel]) => ({ botId, channel }));
    const byChannel = new Map();
    for (const account of accounts) {
      const list = byChannel.get(account.channel);
      if (list === undefined) byChannel.set(account.channel, [account.botId]);
      else list.push(account.botId);
    }
    return {
      dshImInstalled: ctx.dshIm !== undefined && ctx.dshIm !== null,
      accounts,
      channels: [...byChannel].map(([channel, botIds]) => ({ channel, accounts: botIds.length, botIds })),
    };
  }

  /** 记下见过的工作区（累计次数），卡片勾选列表与服务端 status 都用它。 */
  function recordWorkspace(cwd, sessionId) {
    if (typeof cwd !== "string" || cwd.trim() === "") return;
    // 键用完整 cwd：两个同名但不同路径的工作区（E:/a/alpha 与 E:/b/alpha）不能互相串味。
    const key = cwd.trim();
    const name = workspaceName(cwd);
    const prev = state.observed.get(key);
    if (prev === undefined) state.observed.set(key, { name, cwd, count: 1, last: sessionId });
    else {
      prev.count += 1;
      prev.cwd = cwd;
      prev.last = sessionId;
    }
  }

  /** 见过的工作区列表（按次数从多到少）。 */
  function observedWorkspaces() {
    return [...state.observed.values()].sort((a, b) => b.count - a.count);
  }

  /**
   * 「通知哪些工作区」要列的那份清单 = 宿主登记表里的全部工作区
   * + 真跑过任务的（跑过的补上通知次数）。只列跑过的，用户就只勾得到一个。
   */
  function workspaceCatalog() {
    const merged = new Map();
    for (const item of storedWorkspaces()) merged.set(item.name, item);
    for (const item of observedWorkspaces()) {
      const known = merged.get(item.name);
      merged.set(item.name, known === undefined ? item : Object.assign({}, known, { count: Math.max(known.count, item.count) }));
    }
    return [...merged.values()].sort((a, b) => b.count - a.count);
  }

  /**
   * 一条文案扇出到全部目标；单目标失败不影响其它目标，也不打断监听。
   * 返回「每个目标都被平台收下了」：调用方据此决定要不要记账 ——
   * 没发成却记了账，这一轮就再也补不推了（去重集合是按轮次的）。
   */
  async function deliver(text, targets, bots, format, meta = {}) {
    let accepted = 0;
    await Promise.all(targets.map(async (target) => {
      const tag = { ch: target.channel, tgt: shortId(target.targetId) };
      if (bots.get(target.botId) !== target.channel) {
        record("unbound", Object.assign({}, meta, tag));
        logger.info(`task-notify: ${target.channel} account ${target.botId} not connected, skipping`);
        return;
      }
      try {
        const result = await withTimeout(ctx.dshIm.send(target.botId, target.targetId, text, { format }), SEND_LIMITS.sendMs, "dshIm.send");
        if (result?.sent !== true) {
          record("failed", Object.assign({}, meta, tag, { err: String(result?.code ?? "not-accepted") }));
          logger.warn(`task-notify: send not accepted for ${target.channel}/${target.targetId}: ${JSON.stringify(result ?? null)}`);
          return;
        }
        record("sent", Object.assign({}, meta, tag));
        accepted += 1;
        logger.info(`task-notify: notified ${target.channel}/${target.targetId}`);
      } catch (error) {
        record("failed", Object.assign({}, meta, tag, { err: String(error?.code ?? error?.message ?? error).slice(0, 120) }));
        logger.warn(`task-notify: send failed for ${target.channel}/${target.targetId}: ${String(error)}`);
      }
    }));
    return accepted === targets.length;
  }

  // ── session/event：只有 turn/end 带完整 reason，是唯一判定入口 ────────────────
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "turn/end") return;
    const header = session?.header ?? {};
    const sessionId = typeof header.id === "string" ? header.id : "unknown";
    const rules = currentRules();
    const reason = event.data?.reason ?? null;
    const meta = { sid: shortId(sessionId), turn: event.data?.turn ?? null, kind: reason?.kind ?? null };
    record("turn", Object.assign({}, meta, { ws: workspaceName(typeof header.cwd === "string" ? header.cwd : "") }));
    state.last = {
      sessionId,
      turn: event.data?.turn ?? null,
      reason: reason?.kind ?? null,
      at: localIso(new Date()),
    };
    if (!rules.enabled) return;
    if (rules.skipSubagents && Number(header.delegationDepth ?? 0) > 0) {
      record("subagent", meta);
      return;
    }
    // 按结束原因的开关；放在去重之前，关掉的重开一次就能补推。
    if (!statusEnabled(rules, reason?.kind)) {
      record("filtered", meta);
      return;
    }

    // 你正在看这个会话就不推：屏幕和手机同时响是纯噪音。
    // 放在去重之前且不留去重键 —— 之后这轮被重放时还能照常补推。
    if (rules.skipWhenWatching && watchingNow(sessionId)) {
      record("watching", meta);
      logger.info("task-notify: session " + sessionId + " is on screen, notification skipped");
      return;
    }

    const key = dedupeKey(sessionId, reason, event.data?.turn, event.time);
    if (sent.has(key)) {
      record("deduped", meta);
      return;
    }

    const cwd = typeof header.cwd === "string" ? header.cwd : "";
    recordWorkspace(cwd, sessionId);
    // 白名单：不勾=全部工作区都通知。放在去重之前，改完勾选重开一轮就能补推。
    if (!workspaceAllowed(rules, cwd)) {
      record("workspace", Object.assign({}, meta, { ws: workspaceName(cwd) }));
      return;
    }
    const label = STATUS_LABELS[reason?.kind] ?? "⚠️ 任务结束";
    const title = sessionTitle(ctx, session);
    const brief = answerBrief(session, event.data?.turn);
    // 桌面通知与 IM 投递是两条独立的路：这条桌面通知不需要 dsh-im 账号/目标，
    // 所以放在「有没有绑定收件目标」之前 —— 没配 IM 也能在电脑上被叫一声。
    pushAlert({
      sessionId,
      title,
      kind: reason?.kind ?? null,
      turn: event.data?.turn ?? null,
      ws: workspaceName(cwd),
      label,
      brief,
    });

    const { targets } = resolveTargets(rules, cwd);
    if (targets.length === 0) {
      record("unbound", Object.assign({}, meta, { ws: workspaceName(cwd) }));
      logger.info(`task-notify: no enabled target bound for workspace ${workspaceName(cwd)} (${cwd || "no cwd"}), skipping`);
      return;
    }

    const text = formatMessage({
      label,
      title,
      cwd,
      phrase: reasonPhrase(reason),
      sessionId,
      at: state.last.at,
      fields: rules.fields,
      brief,
    });

    sent.add(key);
    if (sent.size > DEDUPE_CAP) sent.delete(sent.values().next().value);

    /** 真投递：立即推送 / 等 auto-continue 判定后，共用这一段。 */
    const fire = () => {
      void (async () => {
      try {
        const bots = await connectedBots();
        if (bots === null) {
          record("unbound", Object.assign({}, meta, { n: targets.length, err: "dsh-im-missing" }));
          logger.warn("task-notify: dsh-im service unavailable, skipping");
          sent.delete(key); // 没发成就不算发过：同一轮重放（会话重载）时还能补推
          return;
        }
        if (!await deliver(text, targets, bots, rules.format, meta)) sent.delete(key);
      } catch (error) {
        // 投递里任何漏网抛出都不许变成 unhandledRejection（Node ≥15 默认致命）。
        sent.delete(key);
        logger.warn(`task-notify: deliver failed for ${targets.length} target(s): ${String(error)}`);
      }
      })();
    };

    const grace = rules.autoContinueGraceMs;
    if (AUTO_CONTINUE_KINDS.has(reason?.kind) && grace > 0) {
      // 先别急着喊「中断 / 失败」：dsh-auto-continue 通常立刻续跑，
      // 等一会再看——续上了这条通知就是噪音，没续上才推。
      const turn = event.data?.turn;
      const timer = setTimeout(() => {
        pending.delete(timer);
        if (continuedAfter(session, turn)) {
          record("suppressed", meta);
          logger.info("task-notify: session " + sessionId + " turn " + (turn ?? "?") + " continued, notification suppressed");
          return;
        }
        fire();
      }, grace);
      if (typeof timer?.unref === "function") timer.unref();
      pending.add(timer);
      return;
    }
    fire();
  });

  // ── user-questions/request：会话要人做选择时也推一条 ────────────────────────────
  // 这是 cordis waterfall（(request, next) => …），只旁听不 claim：
  // 直接 return next() 把回答权原样交给 Web / dsh-im 的回答器，本插件一个字都不插嘴。
  // 事件名与请求形态取自 dsh-im 的宿主适配器
  // （@xmanrui/dsh-im plugin-src/host/modern-harness-api.mjs 里的
  // ctx.on("user-questions/request", (request, next) => …)）。
  ctx.on("user-questions/request", (request, next) => {
    void (async () => {
      try {
        const agent = request?.agent;
        const header = agent?.session?.header ?? {};
        const rules = currentRules();
        if (!rules.enabled || !rules.notifyQuestions) return;
        if (rules.skipSubagents && Number(header.delegationDepth ?? 0) > 0) return;
        const questions = Array.isArray(request?.questions) ? request.questions : [];
        if (questionLines(questions).length === 0) return;
        const cwd = typeof header.cwd === "string" ? header.cwd : "";
        const sessionId = typeof header.id === "string" ? header.id : "unknown";
        const meta = { sid: shortId(sessionId), turn: request?.turn ?? null, kind: "question" };
        record("question", meta);
        recordWorkspace(cwd, sessionId);
        if (!workspaceAllowed(rules, cwd)) {
          record("workspace", Object.assign({}, meta, { ws: workspaceName(cwd) }));
          return;
        }
        const title = sessionTitle(ctx, agent?.session);
        // 要你选的时候也该在电脑上响一声，与有没有 IM 目标无关。
        pushAlert({
          sessionId,
          title,
          kind: "question",
          turn: request?.turn ?? null,
          ws: workspaceName(cwd),
          label: QUESTION_LABEL,
          brief: questionLines(questions)[0] ?? "",
        });
        const { targets } = resolveTargets(rules, cwd);
        if (targets.length === 0) {
          record("unbound", Object.assign({}, meta, { ws: workspaceName(cwd) }));
          logger.info(`task-notify: no enabled target bound for workspace ${workspaceName(cwd)}, question skipped`);
          return;
        }
        // 去重键挂 turn 上：同一轮里同一个问题被重问不再重复推。
        // 同一个问题被重问只在同一轮里去重；turn 缺失时按时刻退化成「不去重」，宁可多推一条。
        const key = dedupeKey(sessionId, { kind: "question" }, request?.turn, Date.now());
        if (sent.has(key)) {
          record("deduped", meta);
          return;
        }
        const text = formatMessage({
          label: QUESTION_LABEL,
          title,
          cwd,
          phrase: "",
          question: questions,
        });
        sent.add(key);
        if (sent.size > DEDUPE_CAP) sent.delete(sent.values().next().value);
        const bots = await connectedBots();
        if (bots === null) {
          record("unbound", Object.assign({}, meta, { n: targets.length, err: "dsh-im-missing" }));
          logger.warn("task-notify: dsh-im service unavailable, question skipped");
          sent.delete(key);
          return;
        }
        if (!await deliver(text, targets, bots, rules.format, meta)) sent.delete(key);
      } catch (error) {
        logger.warn(`task-notify: question hook failed: ${String(error)}`);
      }
    })();
    return next();
  });

  // ── settings：声明自带设置卡片（auto:false = 宿主别再生成一份 schema 表单）───
  // settings 只能出现在 ctx.inject 里，不能写进模块级 inject：它是可选 seam，
  // 硬性依赖会让缺 settings 的组合整个 fiber 永不激活，通知也跟着失效。
  ctx.inject(["settings"], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber));
  });

  // ── 设置桥：给前端卡片读写配置、取 dsh-im 账户、实发测试消息 ─────────────────
  ctx.inject(["webServer", "settings"], (sctx) => {
    sctx.effect(() => {
      const routes = makeBridgeRoutes({
        ns: NS,
        getConfig: () => storedRules(config),
        mutate: (namespace, ops) => sctx.settings.mutate(namespace, ops),
        listAccounts: accountSnapshot,
        listTargets: async (botId) => {
          const listed = await ctx.dshIm.listTargets(botId);
          return (Array.isArray(listed) ? listed : []).map((target) => ({
            targetId: target?.targetId ?? "",
            name: target?.name ?? "",
            kind: target?.kind ?? "",
          }));
        },
        sendTest: async () => {
          const rules = currentRules();
          const { targets } = resolveTargets(rules, "");
          if (targets.length === 0) return { sent: false, code: "no-target", message: "没有启用中的投递目标" };
          // 测试文案不走 formatMessage：那要一个真实 session 的标题与 cwd，
          // 造假 session 只会得到「工作区: unknown」这种看不懂的一行。
          const text = [
            `🧪 测试通知 | ${NS} | 来自 DSH 设置页`,
            "来源: dsh-task-notify 设置卡片",
            "原因: 收到这条说明通道与账户配置都已生效",
          ].join("\n");
          const bots = await connectedBots();
          if (bots === null) return { sent: false, code: "dsh-im-missing", message: "dsh-im 服务不可用" };
          const results = await Promise.all(targets.map(async (target) => {
            if (bots.get(target.botId) !== target.channel) {
              return { channel: target.channel, targetId: target.targetId, sent: false, code: "not-connected" };
            }
            let result = null;
            try {
              result = await withTimeout(ctx.dshIm.send(target.botId, target.targetId, text, { format: rules.format }), SEND_LIMITS.sendMs, "dshIm.send");
            } catch (error) {
              return { channel: target.channel, targetId: target.targetId, sent: false, code: "send-failed", message: String(error?.message ?? error) };
            }
            return { channel: target.channel, targetId: target.targetId, sent: result?.sent === true };
          }));
          return { sent: results.every((item) => item.sent), results };
        },
        reportPresence,
        alertsFeed: alertsSince,
        alertTest,
        stats: () => ({
          seen: state.seen,
          notified: state.notified,
          failed: state.failed,
          skippedUnbound: state.skippedUnbound,
          deduped: state.deduped,
          filtered: state.filtered,
          filteredWorkspace: state.filteredWorkspace,
          suppressed: state.suppressed,
          skippedWatching: state.skippedWatching,
          questions: state.questions,
          /** 桌面通知信箱：已产出的通知条数（客户端从 0 开始追）与最近一次。 */
          alerts: { since: alertSeq, polls: alertPolls, last: alerts.length === 0 ? null : alerts[alerts.length - 1] },
          /** 计数是「有账以来」累计（账本重启后读回）；recent 是最近 10 条判定/投递结果。 */
          ledger: { file: ledgerFile, lines: ledgerLines, recent: recent.slice(-10) },
          last: state.last,
          observed: workspaceCatalog(),
        }),
      }).map((route) => sctx.webServer.register(route));
      return () => {
        for (const dispose of routes) dispose();
      };
    }, "task-notify: settings bridge");
  });

  // ── 状态面：/_task-notify/status，404 即说明 apply() 没跑 ──────────────────────
  ctx.inject(["webServer"], (sctx) => {
    sctx.effect(() => {
      const listener = sctx.webServer.register({
        kind: "exact",
        path: "/_task-notify/status",
        handler: async (req, res) => {
          if (!isLoopbackRequest(req)) {
            writeJson(res, 403, { ok: false, code: "forbidden", message: "loopback requests only" });
            return;
          }
          if (req.method !== "GET") {
            writeJson(res, 405, { ok: false, code: "method-not-allowed", message: "GET only" });
            return;
          }
          const rules = storedRules(config);
          const online = await accountSnapshot();
          writeJson(res, 200, {
            ok: true,
            active: rules.enabled,
            format: rules.format,
            targets: rules.targets,
            workspaces: rules.workspaces,
            skipSubagents: rules.skipSubagents,
            notifyQuestions: rules.notifyQuestions,
            /** 当前每种结束原因的开关，设置页逐项勾选用它。 */
            statuses: rules.statuses,
            // 不再 ...online 之后又写一份 bots：两者是同一个数组，载荷白白翻倍。
            dshImInstalled: online.dshImInstalled,
            channels: online.channels,
            /** dsh-im 当前的在线账户（botId/channel），用来核对配置。 */
            bots: online.accounts,
            seen: state.seen,
            notified: state.notified,
            failed: state.failed,
            skippedUnbound: state.skippedUnbound,
            deduped: state.deduped,
            filtered: state.filtered,
            filteredWorkspace: state.filteredWorkspace,
            suppressed: state.suppressed,
            skippedWatching: state.skippedWatching,
            /** 当前被判定为「正在看」的会话数（没有客户端上报时是 0）。 */
            presence: presence.size,
            questions: state.questions,
            /** 桌面通知信箱的游标（客户端拿 since 追新）；这里不回带正文，免得 status 泄标题。 */
            alerts: { since: alertSeq, polls: alertPolls },
            /** 账本：计数为「有账以来」累计，recent 是最近 10 条判定/投递结果（id 只留前 8 位）。 */
            ledger: { file: ledgerFile, lines: ledgerLines, recent: recent.slice(-10) },
            /** 排障够用就行：不带 sessionId，别把内部会话 id 泄到响应里。 */
            last: state.last === null || state.last === undefined
              ? null
              : { at: state.last.at, turn: state.last.turn, reason: state.last.reason },
            /** 只给目录名/标题/次数；完整 cwd 由桥的 describe 给卡片（那边同样只认本机来源）。 */
            observed: workspaceCatalog().map((item) => ({ name: item.name, title: item.title, count: item.count })),
          });
        },
      });
      return () => listener();
    }, "task-notify: status route");
  });

  ctx.on("dispose", () => {
    sent.clear();
    presence.clear();
    for (const timer of pending) clearTimeout(timer);
    pending.clear();
  });
}

export {
  Config,
  Rules,
  apply,
  inject,
  name,
  rulesOf,
  resolveConfig,
  resolveTargets,
  targetsOf,
  dedupeKey,
  withTimeout,
  SEND_LIMITS,
  localIso,
  storedWorkspaces,
  reasonPhrase,
  workspaceName,
  sessionTitle,
  formatMessage,
  answerBrief,
  firstSentence,
  statusEnabled,
  continuedAfter,
  AUTO_CONTINUE_KINDS,
  storedRules,
  workspaceAllowed,
  Fields,
  FIELD_DEFAULTS,
  Statuses,
  STATUS_LABELS,
  CAUSE_LABELS,
};
export default { apply, inject, name, Config };
