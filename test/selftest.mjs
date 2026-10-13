// dsh-task-notify 的自检：不进 DSH 宿主，用假 ctx / 假 dshIm 验证判定、文案、去重、未绑定分支。
// 跑法：node test/selftest.mjs
import assert from "node:assert/strict";

const mod = await import("../lib/index.js");
const { apply, rulesOf, resolveConfig, resolveTarget, dedupeKey, reasonPhrase, workspaceName } = mod;

/** 造一个最小 ctx：只存 on / inject，dshIm 与 logger 可注入。 */
function makeCtx({ dshIm, bots } = {}) {
  const listeners = new Map();
  const logs = [];
  const routes = new Map();
  const effects = [];
  const ctx = {
    logger: {
      info: (msg) => logs.push(["info", msg]),
      warn: (msg) => logs.push(["warn", msg]),
      error: (msg) => logs.push(["error", msg]),
    },
    dshIm,
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    inject: (_deps, callback) => {
      effects.push(callback({
        webServer: {
          register: (route) => {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        },
        effect: (fn) => fn(),
      }));
    },
    _logs: logs,
    _routes: routes,
    _emit: (event, ...args) => {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
  };
  return ctx;
}

function session(id, cwd, extra = {}) {
  return { header: { id, cwd, type: "session", version: 7, createdAt: 0, isSeeded: false, delegationDepth: 0, ...extra } };
}

function turnEnd(turn, reason) {
  return { type: "turn/end", data: { turn, reason } };
}

/** 等 deliver() 里的 await 链跑完（deliver 是 fire-and-forget）。 */
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const WEIXIN_BOT = "wx_0123456789abcdef01234567";
const TARGET = "tgt_1a2b3c4d5e6f7890";

function binding(overrides = {}) {
  return { rules: { target: { botId: WEIXIN_BOT, targetId: TARGET }, ...overrides } };
}

// 1) 配置解析：默认值
{
  const rules = rulesOf({});
  assert.equal(rules.enabled, true);
  assert.equal(rules.channel, "weixin");
  assert.equal(rules.format, "plain");
  assert.equal(rules.target, null, "空 botId/targetId = 未绑定");
  assert.equal(rules.skipSubagents, true);
  assert.deepEqual(rules.workspaces, {});
}

// 2) resolveConfig 能解 volatile 包装
{
  const resolved = resolveConfig({ rules: { enabled: { get: () => false } } });
  assert.equal(resolved.rules.enabled, false);
}

// 3) format 只放行 markdown，其余归 plain
{
  assert.equal(rulesOf({ rules: { format: "markdown" } }).format, "markdown");
  assert.equal(rulesOf({ rules: { format: "html" } }).format, "plain");
}

// 4) 文案：completed 不带原因短语
{
  assert.equal(reasonPhrase({ kind: "completed" }), "");
  assert.equal(reasonPhrase({ kind: "max-tokens" }), "");
  assert.equal(reasonPhrase(null), "");
}

// 5) 文案：error 带消息，aborted 带 cause，hook 带 hook 原因
{
  assert.equal(reasonPhrase({ kind: "error", error: { message: "429 rate limit" } }), "429 rate limit");
  assert.equal(reasonPhrase({ kind: "error" }), "未知错误");
  assert.equal(reasonPhrase({ kind: "aborted", reason: { kind: "user" } }), "用户主动终止");
  assert.equal(reasonPhrase({ kind: "aborted", reason: { kind: "hook", reason: "budget" } }), "插件中断：budget");
  assert.equal(reasonPhrase({ kind: "aborted", reason: {} }), "原因未知");
}

// 6) 工作区名取目录尾段
{
  assert.equal(workspaceName("E:/文档/deepseek-harness/ziyongchajian"), "ziyongchajian");
  assert.equal(workspaceName("E:" + String.fromCharCode(92) + "a" + String.fromCharCode(92) + "b" + String.fromCharCode(92)), "b");
  assert.equal(workspaceName(""), "unknown");
}

// 7) 目标解析：完整 cwd → 目录名 → 默认
{
  const rules = rulesOf({
    rules: {
      target: { botId: "wx_default", targetId: "tgt_default" },
      workspaces: { ziyongchajian: { botId: "wx_zj", targetId: "tgt_zj" } },
    },
  });
  assert.deepEqual(resolveTarget(rules, "E:/x/ziyongchajian").target, { botId: "wx_zj", targetId: "tgt_zj" });
  assert.deepEqual(resolveTarget(rules, "E:/x/other").target, { botId: "wx_default", targetId: "tgt_default" });
  assert.equal(rulesOf({ rules: { target: { botId: "", targetId: TARGET } } }).target, null, "半截绑定不算绑定");
}

// 8) 去重键：同会话同原因同键；aborted 的不同 cause 不同键
{
  assert.equal(dedupeKey("s1", { kind: "completed" }), dedupeKey("s1", { kind: "completed" }));
  assert.notEqual(dedupeKey("s1", { kind: "aborted", reason: { kind: "user" } }), dedupeKey("s1", { kind: "aborted", reason: { kind: "parent" } }));
  assert.notEqual(dedupeKey("s1", { kind: "completed" }), dedupeKey("s2", { kind: "completed" }));
}

// 9) 成功路径：completed 推一条，文案含状态 / 工作区 / 会话
{
  const sent = [];
  const dshIm = {
    listBots: async () => [{ botId: WEIXIN_BOT, channel: "weixin" }],
    send: async (botId, targetId, text, options) => {
      sent.push({ botId, targetId, text, options });
      return { sent: true };
    },
  };
  const ctx = makeCtx({ dshIm });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/ziyongchajian"), turnEnd(3, { kind: "completed" }));
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].botId, WEIXIN_BOT);
  assert.equal(sent[0].targetId, TARGET);
  assert.equal(sent[0].options.format, "plain");
  assert.match(sent[0].text, /^✅ 任务完成 \| task-notify \| 工作区 ziyongchajian \| 会话 s1$/u);
}

// 10) 失败路径：error 追加原因，且只推一次（去重）
{
  const sent = [];
  const dshIm = {
    listBots: async () => [{ botId: WEIXIN_BOT, channel: "weixin" }],
    send: async (_b, _t, text) => {
      sent.push(text);
      return { sent: true };
    },
  };
  const ctx = makeCtx({ dshIm });
  apply(ctx, binding());
  const reason = { kind: "error", error: { message: "502 bad gateway" } };
  ctx._emit("session/event", session("s1", "E:/x/ziyongchajian"), turnEnd(1, reason));
  ctx._emit("session/event", session("s1", "E:/x/ziyongchajian"), turnEnd(2, reason));
  await settle();
  assert.equal(sent.length, 1, "同一会话同一原因只推一次");
  assert.equal(sent[0], "❌ 任务失败 | task-notify | 工作区 ziyongchajian | 会话 s1 | 502 bad gateway");
}

// 11) 换会话 / 换原因会再推
{
  const sent = [];
  const dshIm = {
    listBots: async () => [{ botId: WEIXIN_BOT, channel: "weixin" }],
    send: async (_b, _t, text) => {
      sent.push(text);
      return { sent: true };
    },
  };
  const ctx = makeCtx({ dshIm });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  ctx._emit("session/event", session("s2", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(2, { kind: "aborted", reason: { kind: "user" } }));
  await settle();
  assert.equal(sent.length, 3);
  assert.match(sent[2], /⚠️ 任务已取消 \| task-notify \| 工作区 a \| 会话 s1 \| 用户主动终止$/u);
}

// 12) 未绑定目标：跳过、不发送
{
  const sent = [];
  const dshIm = {
    listBots: async () => [{ botId: WEIXIN_BOT, channel: "weixin" }],
    send: async () => {
      sent.push(1);
      return { sent: true };
    },
  };
  const ctx = makeCtx({ dshIm });
  apply(ctx, { rules: {} });
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(sent.length, 0);
  assert.ok(ctx._logs.some(([, msg]) => msg.includes("no weixin target bound")));
}

// 13) 机器人未连接：listBots 里没有该 bot → 跳过
{
  const sent = [];
  const dshIm = {
    listBots: async () => [{ botId: "wx_other", channel: "weixin" }],
    send: async () => {
      sent.push(1);
      return { sent: true };
    },
  };
  const ctx = makeCtx({ dshIm });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(sent.length, 0);
  assert.ok(ctx._logs.some(([, msg]) => msg.includes("not connected")));
}

// 14) dsh-im 服务不存在：跳过 + 警告
{
  const ctx = makeCtx({});
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.ok(ctx._logs.some(([level]) => level === "warn"));
}

// 15) send 返回 sent:false → 记失败，不当成功
{
  const dshIm = {
    listBots: async () => [{ botId: WEIXIN_BOT, channel: "weixin" }],
    send: async () => ({ sent: false, code: "bot-not-connected" }),
  };
  const ctx = makeCtx({ dshIm });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  const body = await readStatus(ctx);
  assert.equal(body.failed, 1);
  assert.equal(body.notified, 0);
}

// 16) send 抛错也不打断监听
{
  let calls = 0;
  const dshIm = {
    listBots: async () => [{ botId: WEIXIN_BOT, channel: "weixin" }],
    send: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("delivery-failed"), { code: "delivery-failed" });
      return { sent: true };
    },
  };
  const ctx = makeCtx({ dshIm });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  ctx._emit("session/event", session("s2", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  const body = await readStatus(ctx);
  assert.equal(body.failed, 1);
  assert.equal(body.notified, 1);
}

// 17) subagent 默认不推；关掉 skipSubagents 后推
{
  const sent = [];
  const dshIm = {
    listBots: async () => [{ botId: WEIXIN_BOT, channel: "weixin" }],
    send: async (_b, _t, text) => {
      sent.push(text);
      return { sent: true };
    },
  };
  const ctx = makeCtx({ dshIm });
  apply(ctx, binding());
  ctx._emit("session/event", session("sub", "E:/x/a", { delegationDepth: 1 }), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(sent.length, 0, "subagent 轮次默认跳过");

  const ctx2 = makeCtx({ dshIm });
  apply(ctx2, binding({ skipSubagents: false }));
  ctx2._emit("session/event", session("sub", "E:/x/a", { delegationDepth: 1 }), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(sent.length, 1);
}

// 18) enabled:false 完全不动
{
  const sent = [];
  const dshIm = {
    listBots: async () => [{ botId: WEIXIN_BOT, channel: "weixin" }],
    send: async () => {
      sent.push(1);
      return { sent: true };
    },
  };
  const ctx = makeCtx({ dshIm });
  apply(ctx, { rules: { enabled: false, target: { botId: WEIXIN_BOT, targetId: TARGET } } });
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(sent.length, 0);
}

// 19) 非 turn/end 事件被过滤
{
  const sent = [];
  const dshIm = {
    listBots: async () => [{ botId: WEIXIN_BOT, channel: "weixin" }],
    send: async () => {
      sent.push(1);
      return { sent: true };
    },
  };
  const ctx = makeCtx({ dshIm });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), { type: "step/end", data: { turn: 1, step: 1 } });
  ctx._emit("session/event", session("s1", "E:/x/a"), { type: "user/message", data: {} });
  await settle();
  assert.equal(sent.length, 0);
}

// 20) 工作区覆盖优先于默认目标
{
  const sent = [];
  const dshIm = {
    listBots: async () => [
      { botId: WEIXIN_BOT, channel: "weixin" },
      { botId: "wx_b", channel: "weixin" },
    ],
    send: async (botId, _t, text) => {
      sent.push({ botId, text });
      return { sent: true };
    },
  };
  const ctx = makeCtx({ dshIm });
  apply(ctx, {
    rules: {
      target: { botId: WEIXIN_BOT, targetId: TARGET },
      workspaces: { ziyongchajian: { botId: "wx_b", targetId: "tgt_b" } },
    },
  });
  ctx._emit("session/event", session("s1", "E:/x/ziyongchajian"), turnEnd(1, { kind: "completed" }));
  ctx._emit("session/event", session("s2", "E:/x/other"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].botId, "wx_b");
  assert.equal(sent[1].botId, WEIXIN_BOT);
}

// 21) 状态路由：GET 200 带配置与计数，其它方法 405
{
  const dshIm = {
    listBots: async () => [{ botId: WEIXIN_BOT, channel: "weixin" }],
    send: async () => ({ sent: true }),
  };
  const ctx = makeCtx({ dshIm });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(7, { kind: "blocked" }));
  await settle();

  const ok = await readStatus(ctx, "GET");
  assert.equal(ok.ok, true);
  assert.equal(ok.active, true);
  assert.equal(ok.channel, "weixin");
  assert.equal(ok.dshImInstalled, true);
  assert.equal(ok.seen, 1);
  assert.equal(ok.notified, 1);
  assert.equal(ok.last.reason, "blocked");
  assert.equal(ok.last.turn, 7);

  const bad = await readStatus(ctx, "POST");
  assert.equal(bad.status, 405);
}

/** 调一次状态路由并解析应答。 */
async function readStatus(ctx, method = "GET") {
  const route = ctx._routes.get("/_task-notify/status");
  assert.ok(route, "状态路由应已注册");
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      writeHead(status) {
        this.statusCode = status;
      },
      end(text) {
        resolve(method === "GET" && this.statusCode === 200 ? JSON.parse(text) : { status: this.statusCode, body: JSON.parse(text) });
      },
    };
    route.handler({ method }, res);
  });
}

console.log("dsh-task-notify selftest: ok");
