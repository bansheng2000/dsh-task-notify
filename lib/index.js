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
 *    所以绑定由本插件配置显式声明，见 rules.target / rules.workspaces。
 *
 * 用户已逐项确认的设计取舍：
 *  1) 判定来源 = 事件订阅 turn/end
 *  2) 文案 = 单行极简，失败 / 取消追加原因短语
 *  3) 目标未绑定（无微信机器人 / 无 targetId）= 跳过 + 记日志 + 计数，不报错打断
 *  4) 会话级去重：同一 sessionId + 同一结束原因只推一次
 */

import z from "@deepseek-ai/schemastery";

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

/** AgentCancelCause → 可读短语，只在 aborted 时用。 */
const CAUSE_LABELS = Object.freeze({
  user: "用户主动终止",
  parent: "上级会话取消",
  hook: "插件中断",
  disposed: "会话释放",
  legacy: "旧格式未知原因",
  unknown: "原因未知",
});

const Target = z.object({
  botId: z.string().default(""),
  targetId: z.string().default(""),
});

const Rules = z.object({
  enabled: z.boolean().default(true),
  /** 只对 listBots() 里这个 channel 的机器人生效。 */
  channel: z.string().default("weixin"),
  format: z.string().default("plain"),
  /** 默认投递目标；botId / targetId 任一为空 = 未绑定，跳过并计数。 */
  target: Target.default({ botId: "", targetId: "" }),
  /** 按工作区覆盖目标，键为完整 cwd 或工作区目录名。 */
  workspaces: z.dict(Target).default({}),
  /** 跳过 subagent 的轮次结束，只报顶层任务。 */
  skipSubagents: z.boolean().default(true),
});

const Config = z.object({ rules: Rules.volatile() });

const DEFAULTS = Object.freeze({
  enabled: true,
  channel: "weixin",
  format: "plain",
  target: { botId: "", targetId: "" },
  workspaces: {},
  skipSubagents: true,
});

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

/** 只有 botId + targetId 同时非空才算已绑定。 */
function targetOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const botId = typeof value.botId === "string" ? value.botId.trim() : "";
  const targetId = typeof value.targetId === "string" ? value.targetId.trim() : "";
  return botId !== "" && targetId !== "" ? { botId, targetId } : null;
}

function rulesOf(resolved) {
  const rules = { ...DEFAULTS, ...(resolved?.rules ?? {}) };
  const workspaces = {};
  const raw = rules.workspaces;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const target = targetOf(value);
      if (target !== null && key.trim() !== "") workspaces[key.trim()] = target;
    }
  }
  return {
    enabled: rules.enabled === true,
    channel: typeof rules.channel === "string" && rules.channel.trim() !== "" ? rules.channel.trim() : DEFAULTS.channel,
    format: rules.format === "markdown" ? "markdown" : "plain",
    target: targetOf(rules.target),
    workspaces,
    skipSubagents: rules.skipSubagents !== false,
  };
}

/** 工作区取目录名；没 cwd 时给个可读的兜底。 */
function workspaceName(cwd) {
  if (typeof cwd !== "string" || cwd.trim() === "") return "unknown";
  const parts = cwd.trim().replace(/[\\/]+$/u, "").split(/[\\/]/u);
  return parts[parts.length - 1] || cwd.trim();
}

/** 精确 cwd → 目录名 → 默认目标，逐级回退。 */
function resolveTarget(rules, cwd) {
  const key = typeof cwd === "string" ? cwd : "";
  for (const candidate of [key, workspaceName(key)]) {
    if (candidate !== "" && Object.prototype.hasOwnProperty.call(rules.workspaces, candidate)) {
      return { target: rules.workspaces[candidate], matchedBy: candidate };
    }
  }
  return { target: rules.target, matchedBy: rules.target === null ? null : "default" };
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

/** 去重键：同一会话 + 同一结束原因只推一次。 */
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
    last: null,
  };
  /** 去重键集合，插满后按插入序淘汰最旧的一条。 */
  const sent = new Set();

  async function deliver(message, rules) {
    const dshIm = ctx.dshIm;
    if (dshIm === undefined || dshIm === null) {
      state.skippedUnbound += 1;
      logger.warn("task-notify: dsh-im service unavailable, skipping");
      return { code: "dsh-im-missing" };
    }
    let bots;
    try {
      bots = await dshIm.listBots();
    } catch (error) {
      state.failed += 1;
      logger.warn(`task-notify: listBots failed: ${String(error)}`);
      return { code: "list-bots-failed" };
    }
    const connected =
      Array.isArray(bots) &&
      bots.some((bot) => bot?.botId === message.botId && bot?.channel === rules.channel);
    if (!connected) {
      state.skippedUnbound += 1;
      logger.info(`task-notify: ${rules.channel} bot ${message.botId} not connected, skipping`);
      return { code: "bot-not-connected" };
    }
    try {
      const result = await dshIm.send(message.botId, message.targetId, message.text, { format: rules.format });
      if (result?.sent !== true) {
        state.failed += 1;
        logger.warn(`task-notify: send not accepted for ${message.targetId}: ${JSON.stringify(result ?? null)}`);
        return { code: result?.code ?? "not-sent" };
      }
      state.notified += 1;
      logger.info(`task-notify: notified ${message.targetId} <- ${message.text}`);
      return { code: "sent" };
    } catch (error) {
      state.failed += 1;
      logger.warn(`task-notify: send failed for ${message.targetId}: ${String(error)}`);
      return { code: error?.code ?? "send-failed" };
    }
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

    const key = dedupeKey(sessionId, reason);
    if (sent.has(key)) {
      state.deduped += 1;
      return;
    }

    const cwd = typeof header.cwd === "string" ? header.cwd : "";
    const { target, matchedBy } = resolveTarget(rules, cwd);
    if (target === null) {
      state.skippedUnbound += 1;
      logger.info(
        `task-notify: no ${rules.channel} target bound for workspace ${workspaceName(cwd)} (${cwd || "no cwd"}), skipping`,
      );
      return;
    }

    const label = STATUS_LABELS[reason?.kind] ?? "⚠️ 任务结束";
    const phrase = reasonPhrase(reason);
    const head = `${label} | ${NS} | 工作区 ${workspaceName(cwd)} | 会话 ${sessionId}`;
    const text = phrase === "" ? head : `${head} | ${phrase}`;

    sent.add(key);
    if (sent.size > DEDUPE_CAP) sent.delete(sent.values().next().value);
    void deliver({ botId: target.botId, targetId: target.targetId, text, matchedBy }, rules);
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
          writeJson(res, 200, {
            ok: true,
            active: rules.enabled,
            channel: rules.channel,
            defaultTarget: rules.target,
            workspaces: rules.workspaces,
            skipSubagents: rules.skipSubagents,
            dshImInstalled: ctx.dshIm !== undefined && ctx.dshIm !== null,
            seen: state.seen,
            notified: state.notified,
            failed: state.failed,
            skippedUnbound: state.skippedUnbound,
            deduped: state.deduped,
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
  resolveTarget,
  dedupeKey,
  reasonPhrase,
  workspaceName,
  STATUS_LABELS,
  CAUSE_LABELS,
};
export default { apply, inject, name, Config };
