// dsh-task-notify 的自检：不进 DSH 宿主，用假 ctx / 假 dshIm 验证判定、文案、去重、多渠道扇出、未绑定分支。
// 跑法：node test/selftest.mjs
import assert from "node:assert/strict";

const mod = await import("../lib/index.js");
const { apply, rulesOf, resolveConfig, resolveTargets, targetsOf, dedupeKey, reasonPhrase, workspaceName } = mod;

/** 造一个最小 ctx：只存 on / inject，dshIm 与 logger 可注入。 */
function makeCtx({ dshIm } = {}) {
  const listeners = new Map();
  const logs = [];
  const routes = new Map();
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
      callback({
        webServer: {
          register: (route) => {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        },
        effect: (fn) => fn(),
      });
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

const BS = String.fromCharCode(92);

const WX_BOT = "wx_0123456789abcdef01234567";
const TG_BOT = "tg_0123456789abcdef01234567";
const WX_TARGET = "tgt_1a2b3c4d5e6f7890";
const TG_TARGET = "tgt_0f1e2d3c4b5a6978";

/** 记录每次 send 的假 dshIm。 */
function fakeIm({ bots, send } = {}) {
  const calls = [];
  return {
    calls,
    service: {
      listBots: async () => bots ?? [{ botId: WX_BOT, channel: "weixin" }],
      send: async (botId, targetId, text, options) => {
        calls.push({ botId, targetId, text, options });
        return send ? send(calls.length) : { sent: true };
      },
    },
  };
}

function binding(overrides = {}) {
  return { rules: { targets: [{ channel: "weixin", botId: WX_BOT, targetId: WX_TARGET }], ...overrides } };
}

// 1) 配置解析：默认值
{
  const rules = rulesOf({});
  assert.equal(rules.enabled, true);
  assert.equal(rules.format, "plain");
  assert.equal(rules.skipSubagents, true);
  assert.deepEqual(rules.targets, [], "默认没有目标 = 未绑定");
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

// 4) targetsOf：单个目标当长度为 1 的列表；缺 botId/targetId 的项丢弃；channel 缺省 weixin；enabled 缺省 true
{
  assert.deepEqual(targetsOf({ botId: "b", targetId: "t" }), [{ channel: "weixin", botId: "b", targetId: "t", enabled: true }]);
  assert.deepEqual(targetsOf([{ botId: "b", targetId: "t", channel: "slack" }, { botId: "", targetId: "t" }]), [
    { channel: "slack", botId: "b", targetId: "t", enabled: true },
  ]);
  assert.deepEqual(targetsOf([{ botId: "b", targetId: "t", enabled: false }]), [
    { channel: "weixin", botId: "b", targetId: "t", enabled: false },
  ]);
  assert.deepEqual(targetsOf(undefined), []);
}

// 5) 文案：completed 不带原因短语
{
  assert.equal(reasonPhrase({ kind: "completed" }), "");
  assert.equal(reasonPhrase({ kind: "max-tokens" }), "");
  assert.equal(reasonPhrase(null), "");
}

// 6) 文案：error 带消息，aborted 带 cause，hook 带 hook 原因
{
  assert.equal(reasonPhrase({ kind: "error", error: { message: "429 rate limit" } }), "429 rate limit");
  assert.equal(reasonPhrase({ kind: "error" }), "未知错误");
  assert.equal(reasonPhrase({ kind: "aborted", reason: { kind: "user" } }), "用户主动终止");
  assert.equal(reasonPhrase({ kind: "aborted", reason: { kind: "hook", reason: "budget" } }), "插件中断：budget");
  assert.equal(reasonPhrase({ kind: "aborted", reason: {} }), "原因未知");
}

// 7) 工作区名取目录尾段
{
  assert.equal(workspaceName("E:/文档/deepseek-harness/ziyongchajian"), "ziyongchajian");
  assert.equal(workspaceName("E:" + BS + "a" + BS + "b" + BS), "b");
  assert.equal(workspaceName(""), "unknown");
}

// 8) 目标解析：完整 cwd → 目录名 → 默认，逐级回退
{
  const rules = rulesOf({
    rules: {
      targets: [{ channel: "weixin", botId: "wx_default", targetId: "tgt_default" }],
      workspaces: { ziyongchajian: [{ channel: "telegram", botId: "tg_zj", targetId: "tgt_zj" }] },
    },
  });
  assert.deepEqual(resolveTargets(rules, "E:/x/ziyongchajian").targets, [{ channel: "telegram", botId: "tg_zj", targetId: "tgt_zj", enabled: true }]);
  assert.deepEqual(resolveTargets(rules, "E:/x/other").targets, [{ channel: "weixin", botId: "wx_default", targetId: "tgt_default", enabled: true }]);
  assert.deepEqual(resolveTargets(rules, "E:/x/other").matchedBy, "default");
  assert.deepEqual(resolveTargets(rulesOf({}), "E:/x/other").matchedBy, null);
  // 关掉的目标不进投递列表；全关等于未绑定
  const off = rulesOf({ rules: { targets: [{ channel: "weixin", botId: "wx_default", targetId: "tgt_default", enabled: false }] } });
  assert.deepEqual(resolveTargets(off, "E:/x/other").targets, []);
  assert.equal(resolveTargets(off, "E:/x/other").matchedBy, null);
}

// 9) 去重键：同会话同原因同键；aborted 的不同 cause 不同键
{
  assert.equal(dedupeKey("s1", { kind: "completed" }), dedupeKey("s1", { kind: "completed" }));
  assert.notEqual(dedupeKey("s1", { kind: "aborted", reason: { kind: "user" } }), dedupeKey("s1", { kind: "aborted", reason: { kind: "parent" } }));
  assert.notEqual(dedupeKey("s1", { kind: "completed" }), dedupeKey("s2", { kind: "completed" }));
}

// 10) 成功路径：completed 推一条，文案含状态 / 工作区 / 会话
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/ziyongchajian"), turnEnd(3, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 1);
  assert.equal(im.calls[0].botId, WX_BOT);
  assert.equal(im.calls[0].targetId, WX_TARGET);
  assert.equal(im.calls[0].options.format, "plain");
  assert.equal(im.calls[0].text, "✅ 任务完成 | task-notify | 工作区 ziyongchajian | 会话 s1");
}

// 11) 失败路径：error 追加原因，且只推一次（去重）
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding());
  const reason = { kind: "error", error: { message: "502 bad gateway" } };
  ctx._emit("session/event", session("s1", "E:/x/ziyongchajian"), turnEnd(1, reason));
  ctx._emit("session/event", session("s1", "E:/x/ziyongchajian"), turnEnd(2, reason));
  await settle();
  assert.equal(im.calls.length, 1, "同一会话同一原因只推一次");
  assert.equal(im.calls[0].text, "❌ 任务失败 | task-notify | 工作区 ziyongchajian | 会话 s1 | 502 bad gateway");
}

// 12) 换会话 / 换原因会再推
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  ctx._emit("session/event", session("s2", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(2, { kind: "aborted", reason: { kind: "user" } }));
  await settle();
  assert.equal(im.calls.length, 3);
  assert.equal(im.calls[2].text, "⚠️ 任务已取消 | task-notify | 工作区 a | 会话 s1 | 用户主动终止");
}

// 13) 未绑定目标：跳过、不发送
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, { rules: {} });
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 0);
  assert.ok(ctx._logs.some(([, msg]) => msg.includes("no enabled target bound")));
}

// 14) 账户未连接：listBots 里没有该 bot 或 channel 不符 → 该目标跳过，其它目标照发
{
  const im = fakeIm({ bots: [{ botId: TG_BOT, channel: "telegram" }] });
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 0);
  assert.ok(ctx._logs.some(([, msg]) => msg.includes("not connected")));
}

// 15) dsh-im 服务不存在：跳过 + 警告
{
  const ctx = makeCtx({});
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.ok(ctx._logs.some(([level]) => level === "warn"));
}

// 16) send 返回 sent:false → 记失败，不当成功
{
  const im = fakeIm({ send: () => ({ sent: false, code: "bot-not-connected" }) });
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  const body = await readStatus(ctx);
  assert.equal(body.failed, 1);
  assert.equal(body.notified, 0);
}

// 17) send 抛错也不打断监听
{
  const im = fakeIm({ send: (n) => { if (n === 1) throw Object.assign(new Error("delivery-failed"), { code: "delivery-failed" }); return { sent: true }; } });
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  ctx._emit("session/event", session("s2", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  const body = await readStatus(ctx);
  assert.equal(body.failed, 1);
  assert.equal(body.notified, 1);
}

// 18) subagent 默认不推；关掉 skipSubagents 后推
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding());
  ctx._emit("session/event", session("sub", "E:/x/a", { delegationDepth: 1 }), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 0, "subagent 轮次默认跳过");

  const im2 = fakeIm();
  const ctx2 = makeCtx({ dshIm: im2.service });
  apply(ctx2, binding({ skipSubagents: false }));
  ctx2._emit("session/event", session("sub", "E:/x/a", { delegationDepth: 1 }), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im2.calls.length, 1);
}

// 19) enabled:false 完全不动
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, { rules: { enabled: false, targets: [{ botId: WX_BOT, targetId: WX_TARGET }] } });
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 0);
}

// 20) 非 turn/end 事件被过滤
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), { type: "step/end", data: { turn: 1, step: 1 } });
  ctx._emit("session/event", session("s1", "E:/x/a"), { type: "user/message", data: {} });
  await settle();
  assert.equal(im.calls.length, 0);
}

// 21) 工作区覆盖优先于默认目标
{
  const im = fakeIm({ bots: [{ botId: WX_BOT, channel: "weixin" }, { botId: TG_BOT, channel: "telegram" }] });
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, {
    rules: {
      targets: [{ channel: "weixin", botId: WX_BOT, targetId: WX_TARGET }],
      workspaces: { ziyongchajian: [{ channel: "telegram", botId: TG_BOT, targetId: TG_TARGET }] },
    },
  });
  ctx._emit("session/event", session("s1", "E:/x/ziyongchajian"), turnEnd(1, { kind: "completed" }));
  ctx._emit("session/event", session("s2", "E:/x/other"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 2);
  assert.equal(im.calls[0].botId, TG_BOT);
  assert.equal(im.calls[1].botId, WX_BOT);
}

// 22) 多渠道扇出：一条通知发到全部目标（不同渠道 + 不同账户）
{
  const im = fakeIm({ bots: [{ botId: WX_BOT, channel: "weixin" }, { botId: TG_BOT, channel: "telegram" }] });
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding({
    targets: [
      { channel: "weixin", botId: WX_BOT, targetId: WX_TARGET },
      { channel: "telegram", botId: TG_BOT, targetId: TG_TARGET },
    ],
  }));
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 2, "两个渠道各发一条");
  assert.deepEqual(im.calls.map((c) => c.botId + "/" + c.targetId).sort(), [(TG_BOT + "/" + TG_TARGET), (WX_BOT + "/" + WX_TARGET)].sort());
  assert.equal(im.calls[0].text, im.calls[1].text, "两个渠道同文案");
}

// 23) 同渠道多账户：两条配置都发，互不覆盖
{
  const OTHER_WX = "wx_9999999999999999abcdef01";
  const OTHER_TARGET = "tgt_1111222233334444";
  const im = fakeIm({ bots: [{ botId: WX_BOT, channel: "weixin" }, { botId: OTHER_WX, channel: "weixin" }] });
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding({
    targets: [
      { channel: "weixin", botId: WX_BOT, targetId: WX_TARGET },
      { channel: "weixin", botId: OTHER_WX, targetId: OTHER_TARGET },
    ],
  }));
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 2);
  assert.deepEqual(im.calls.map((c) => c.targetId).sort(), [OTHER_TARGET, WX_TARGET].sort());
}

// 24) 扇出中途失败不影响其它目标：失败计数 +1，成功的照发
{
  const im = fakeIm({
    bots: [{ botId: WX_BOT, channel: "weixin" }, { botId: TG_BOT, channel: "telegram" }],
    send: (n) => (n === 1 ? { sent: false, code: "target-rejected" } : { sent: true }),
  });
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding({ targets: [{ channel: "weixin", botId: WX_BOT, targetId: WX_TARGET }, { channel: "telegram", botId: TG_BOT, targetId: TG_TARGET }] }));
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  const body = await readStatus(ctx);
  assert.equal(body.failed, 1);
  assert.equal(body.notified, 1);
  assert.equal(im.calls.length, 2, "两个都尝试过");
}

// 25) 未连接的渠道计入 skippedUnbound，不算失败
{
  const im = fakeIm({ bots: [{ botId: TG_BOT, channel: "telegram" }] });
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding({ targets: [{ channel: "weixin", botId: WX_BOT, targetId: WX_TARGET }, { channel: "telegram", botId: TG_BOT, targetId: TG_TARGET }] }));
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  const body = await readStatus(ctx);
  assert.equal(body.skippedUnbound, 1);
  assert.equal(body.failed, 0);
  assert.equal(body.notified, 1);
}

// 26) 状态路由：GET 200 带配置 / 在线账户 / 计数，其它方法 405
{
  const im = fakeIm({ bots: [{ botId: WX_BOT, channel: "weixin" }, { botId: TG_BOT, channel: "telegram" }] });
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding({ targets: [{ channel: "weixin", botId: WX_BOT, targetId: WX_TARGET }, { channel: "telegram", botId: TG_BOT, targetId: TG_TARGET }] }));
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(7, { kind: "blocked" }));
  await settle();

  const ok = await readStatus(ctx, "GET");
  assert.equal(ok.ok, true);
  assert.equal(ok.active, true);
  assert.equal(ok.dshImInstalled, true);
  assert.equal(ok.seen, 1);
  assert.equal(ok.notified, 2, "两个渠道各计一次");
  assert.equal(ok.last.reason, "blocked");
  assert.equal(ok.last.turn, 7);
  assert.deepEqual(ok.targets.map((t) => t.channel), ["weixin", "telegram"]);
  assert.deepEqual(ok.bots, [{ botId: WX_BOT, channel: "weixin" }, { botId: TG_BOT, channel: "telegram" }]);
  assert.deepEqual(ok.channels, [
    { channel: "weixin", accounts: 1, botIds: [WX_BOT] },
    { channel: "telegram", accounts: 1, botIds: [TG_BOT] },
  ]);

  const bad = await readStatus(ctx, "POST");
  assert.equal(bad.status, 405);
}

// 27) 按通道 + 账户启停：enabled:false 的那条不投递，其它目标照发
{
  const im = fakeIm({ bots: [{ botId: WX_BOT, channel: "weixin" }, { botId: TG_BOT, channel: "telegram" }] });
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding({
    targets: [
      { channel: "weixin", botId: WX_BOT, targetId: WX_TARGET, enabled: false },
      { channel: "telegram", botId: TG_BOT, targetId: TG_TARGET, enabled: true },
    ],
  }));
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();

  assert.equal(im.calls.length, 1, "只发开着的那条");
  assert.equal(im.calls[0].botId, TG_BOT);
  const body = await readStatus(ctx, "GET");
  assert.equal(body.notified, 1);
  assert.equal(body.failed, 0);
}

// 28) 同通道多账户时 channels 汇总账户数
{
  const other = "wx_ffffffffffffffffffffffff";
  const im = fakeIm({ bots: [{ botId: WX_BOT, channel: "weixin" }, { botId: other, channel: "weixin" }] });
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding({
    targets: [{ channel: "weixin", botId: WX_BOT, targetId: WX_TARGET }, { channel: "weixin", botId: other, targetId: WX_TARGET }],
  }));
  const body = await readStatus(ctx, "GET");
  assert.deepEqual(body.channels, [{ channel: "weixin", accounts: 2, botIds: [WX_BOT, other] }]);
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
        const body = JSON.parse(text);
        resolve(method === "GET" && this.statusCode === 200 ? body : { status: this.statusCode, body });
      },
    };
    route.handler({ method }, res);
  });
}

console.log("dsh-task-notify selftest: ok");
