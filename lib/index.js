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

import z from "@deepseek-ai/schemastery";
import { makeBridgeRoutes } from "./bridge.js";

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

const Rules = z.object({
  enabled: z.boolean().default(true),
  format: z.string().default("plain"),
  /** 跳过 subagent 的轮次结束，只报顶层任务。 */
  skipSubagents: z.boolean().default(true),
  /** 会话抛出待答问题（ask_user_question）时也推一条；独立于 statuses。 */
  notifyQuestions: z.boolean().default(true),
  /** 按结束原因开关：completed / error / aborted / blocked / max-tokens / interrupted / forked。 */
  statuses: Statuses.default({}),
  /** 默认投递目标列表（多渠道扇出）；任一项缺 botId/targetId 的会被丢掉。 */
  targets: z.array(Target).default([]),
  /** 按工作区覆盖默认列表，键为完整 cwd 或工作区目录名。 */
  workspaces: z.dict(z.array(Target)).default({}),
});

const Config = z.object({ rules: Rules.volatile() });

const DEFAULTS = Object.freeze({
  enabled: true,
  format: "plain",
  skipSubagents: true,
});

/** statuses 的缺省值：七种结束原因全开（与 Statuses 的默认值一致）。 */
const STATUS_DEFAULTS = Object.freeze({
  completed: true,
  error: true,
  aborted: true,
  blocked: true,
  "max-tokens": true,
  interrupted: true,
  forked: true,
});

/** 这个结束原因要不要通知：配置缺项 / 非布尔都按开处理，新 reason 不会静默漏推。 */
function statusEnabled(rules, kind) {
  const key = typeof kind === "string" && kind in STATUS_LABELS ? kind : "completed";
  return rules.statuses?.[key] !== false;
}

/** 去重集合上限（sessionId|kind|cause）。插满后淘汰最旧的一条。 */
const DEDUPE_CAP = 500;

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
    enabled: rules.enabled === true,
    format: rules.format === "markdown" ? "markdown" : "plain",
    skipSubagents: rules.skipSubagents !== false,
    notifyQuestions: rules.notifyQuestions !== false,
    statuses: { ...STATUS_DEFAULTS, ...(rules.statuses ?? {}) },
    targets: targetsOf(rules.targets),
    workspaces,
  };
}

/** 工作区取目录名；没 cwd 时给个可读的兜底。 */
function workspaceName(cwd) {
  if (typeof cwd !== "string" || cwd.trim() === "") return "unknown";
  const parts = cwd.trim().replace(/[\\/]+$/u, "").split(/[\\/]/u);
  return parts[parts.length - 1] || cwd.trim();
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

/**
 * 会话标题（宿主 dsh-session-title 服务折叠出的最新标题）：作为通知第三段，
 * 就是「这次到底在干什么」的人话标识。服务没挂载 / 标题还没生成时给空串。
 */
function sessionTitle(ctx, session) {
  try {
    const raw = ctx.sessionTitle?.get?.(session)?.title;
    if (typeof raw !== "string") return "";
    // 宿主已经按 maxTitleBytes 规范化过标题，这里只压掉换行，不截断。
    return raw.replace(/\s+/gu, " ").trim();
  } catch {
    return "";
  }
}

/**
 * 通知版式：首行「状态 | 插件名 | 完整会话标题」，正文逐行「字段: 值」。
 * 标题在首行已完整出现，正文不再重复一遍；没有标题时首行退回工作区名。
 */
function formatMessage({ label, title, cwd, phrase, question }) {
  const head = `${label} | ${NS} | ${title !== "" ? title : workspaceName(cwd)}`;
  const body = [`工作区: ${workspaceName(cwd)}`];
  if (phrase !== "") body.push(`原因: ${phrase}`);
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

/** 去重键：同一会话 + 同一结束原因只推一次（与目标数无关，是整批一次）。 */
function dedupeKey(sessionId, reason) {
  const kind = reason === null || typeof reason !== "object" ? "unknown" : String(reason.kind);
  const cause =
    reason !== null && typeof reason === "object" && reason.kind === "aborted" &&
    reason.reason !== null && typeof reason.reason === "object"
      ? String(reason.reason.kind ?? "unknown")
      : "";
  return `${sessionId}|${kind}|${cause}`;
}

/** raw node http 应答（与 dsh-auto-continue 同一形态，不是 fastify reply）。 */
function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
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
    /** 捕获到的待答问题数。 */
    questions: 0,
    last: null,
  };
  /** 去重键集合，插满后按插入序淘汰最旧的一条。 */
  const sent = new Set();

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

  /** 一条文案扇出到全部目标；单目标失败不影响其它目标，也不打断监听。 */
  async function deliver(text, targets, bots, format) {
    await Promise.all(targets.map(async (target) => {
      if (bots.get(target.botId) !== target.channel) {
        state.skippedUnbound += 1;
        logger.info(`task-notify: ${target.channel} account ${target.botId} not connected, skipping`);
        return;
      }
      try {
        const result = await ctx.dshIm.send(target.botId, target.targetId, text, { format });
        if (result?.sent !== true) {
          state.failed += 1;
          logger.warn(`task-notify: send not accepted for ${target.channel}/${target.targetId}: ${JSON.stringify(result ?? null)}`);
          return;
        }
        state.notified += 1;
        logger.info(`task-notify: notified ${target.channel}/${target.targetId} <- ${text}`);
      } catch (error) {
        state.failed += 1;
        logger.warn(`task-notify: send failed for ${target.channel}/${target.targetId}: ${String(error)}`);
      }
    }));
  }

  // ── session/event：只有 turn/end 带完整 reason，是唯一判定入口 ────────────────
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "turn/end") return;
    state.seen += 1;
    const header = session?.header ?? {};
    const sessionId = typeof header.id === "string" ? header.id : "unknown";
    const rules = currentRules();
    const reason = event.data?.reason ?? null;
    state.last = {
      sessionId,
      turn: event.data?.turn ?? null,
      reason: reason?.kind ?? null,
      at: new Date().toISOString(),
    };
    if (!rules.enabled) return;
    if (rules.skipSubagents && Number(header.delegationDepth ?? 0) > 0) return;
    // 按结束原因的开关；放在去重之前，关掉的重开一次就能补推。
    if (!statusEnabled(rules, reason?.kind)) {
      state.filtered += 1;
      return;
    }

    const key = dedupeKey(sessionId, reason);
    if (sent.has(key)) {
      state.deduped += 1;
      return;
    }

    const cwd = typeof header.cwd === "string" ? header.cwd : "";
    const { targets } = resolveTargets(rules, cwd);
    if (targets.length === 0) {
      state.skippedUnbound += 1;
      logger.info(`task-notify: no enabled target bound for workspace ${workspaceName(cwd)} (${cwd || "no cwd"}), skipping`);
      return;
    }

    const label = STATUS_LABELS[reason?.kind] ?? "⚠️ 任务结束";
    const text = formatMessage({
      label,
      title: sessionTitle(ctx, session),
      cwd,
      phrase: reasonPhrase(reason),
    });

    sent.add(key);
    if (sent.size > DEDUPE_CAP) sent.delete(sent.values().next().value);
    void (async () => {
      const bots = await connectedBots();
      if (bots === null) {
        state.skippedUnbound += targets.length;
        logger.warn("task-notify: dsh-im service unavailable, skipping");
        return;
      }
      await deliver(text, targets, bots, rules.format);
    })();
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
        state.questions += 1;
        const cwd = typeof header.cwd === "string" ? header.cwd : "";
        const { targets } = resolveTargets(rules, cwd);
        if (targets.length === 0) {
          state.skippedUnbound += 1;
          logger.info(`task-notify: no enabled target bound for workspace ${workspaceName(cwd)}, question skipped`);
          return;
        }
        const sessionId = typeof header.id === "string" ? header.id : "unknown";
        // 去重键挂 turn 上：同一轮里同一个问题被重问不再重复推。
        const key = `${sessionId}|question|${Number.isFinite(request?.turn) ? request.turn : 0}`;
        if (sent.has(key)) {
          state.deduped += 1;
          return;
        }
        const text = formatMessage({
          label: QUESTION_LABEL,
          title: sessionTitle(ctx, agent?.session),
          cwd,
          phrase: "",
          question: questions,
        });
        sent.add(key);
        if (sent.size > DEDUPE_CAP) sent.delete(sent.values().next().value);
        const bots = await connectedBots();
        if (bots === null) {
          state.skippedUnbound += targets.length;
          logger.warn("task-notify: dsh-im service unavailable, question skipped");
          return;
        }
        await deliver(text, targets, bots, rules.format);
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
        getConfig: currentRules,
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
            const result = await ctx.dshIm.send(target.botId, target.targetId, text, { format: rules.format });
            return { channel: target.channel, targetId: target.targetId, sent: result?.sent === true };
          }));
          return { sent: results.every((item) => item.sent), results };
        },
        stats: () => ({
          seen: state.seen,
          notified: state.notified,
          failed: state.failed,
          skippedUnbound: state.skippedUnbound,
          deduped: state.deduped,
          filtered: state.filtered,
          questions: state.questions,
          last: state.last,
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
          if (req.method !== "GET") {
            writeJson(res, 405, { ok: false, code: "method-not-allowed", message: "GET only" });
            return;
          }
          const rules = currentRules();
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
            ...online,
            /** dsh-im 当前的在线账户（botId/channel），用来核对配置。 */
            bots: online.accounts,
            seen: state.seen,
            notified: state.notified,
            failed: state.failed,
            skippedUnbound: state.skippedUnbound,
            deduped: state.deduped,
            filtered: state.filtered,
            questions: state.questions,
            last: state.last,
          });
        },
      });
      return () => listener();
    }, "task-notify: status route");
  });

  ctx.on("dispose", () => {
    sent.clear();
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
  reasonPhrase,
  workspaceName,
  sessionTitle,
  formatMessage,
  statusEnabled,
  Statuses,
  STATUS_LABELS,
  CAUSE_LABELS,
};
export default { apply, inject, name, Config };
