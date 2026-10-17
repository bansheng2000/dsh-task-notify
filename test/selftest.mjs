// dsh-task-notify 的自检：不进 DSH 宿主，用假 ctx / 假 dshIm 验证判定、文案、去重、多渠道扇出、未绑定分支。
// 跑法：node test/selftest.mjs
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const mod = await import("../lib/index.js");
const { apply, rulesOf, resolveConfig, resolveTargets, targetsOf, dedupeKey, reasonPhrase, workspaceName, sessionTitle, formatMessage, statusEnabled, storedRules, workspaceAllowed, answerBrief, firstSentence, FIELD_DEFAULTS } = mod;

// 「全部工作区」来自宿主 storage 登记表：默认指到一个不存在的目录，免得读到本机
// 真实工作区把断言变成机器相关（最后一个用例再单独喂真文件）。
const NO_STORAGES = fileURLToPath(new URL("./_no_storages/", import.meta.url));
process.env.DSH_STORAGES_DIR = NO_STORAGES;


/** 造一个最小 ctx：只存 on / inject，dshIm 与 logger 可注入。 */
function makeCtx({ dshIm, sessionTitle } = {}) {
  const listeners = new Map();
  const logs = [];
  const routes = new Map();
  const mutations = [];
  let config = {};
  const ctx = {
    logger: {
      info: (msg) => logs.push(["info", msg]),
      warn: (msg) => logs.push(["warn", msg]),
      error: (msg) => logs.push(["error", msg]),
    },
    dshIm,
    sessionTitle,
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    settings: {
      configure() {
        this.configured = true;
      },
      configured: false,
      async mutate(_ns, ops) {
        for (const op of ops) {
          const path = op.path;
          let node = config;
          for (let i = 0; i < path.length - 1; i += 1) {
            if (node[path[i]] === null || typeof node[path[i]] !== "object") node[path[i]] = {};
            node = node[path[i]];
          }
          node[path[path.length - 1]] = op.value;
          mutations.push({ op: op.op, path, value: op.value });
        }
      },
    },
    inject: (_deps, callback) => {
      callback({
        settings: ctx.settings,
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
    _mutations: mutations,
    _setConfig(next) {
      config = next;
      return config;
    },
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
const NL = String.fromCharCode(10);

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

// 9) 去重键：同会话同轮同原因同键；**不同轮必须不同键**；aborted 的不同 cause 不同键
{
  assert.equal(dedupeKey("s1", { kind: "completed" }, 3), dedupeKey("s1", { kind: "completed" }, 3));
  assert.notEqual(dedupeKey("s1", { kind: "completed" }, 1), dedupeKey("s1", { kind: "completed" }, 2), "同一会话的不同轮必须各推一次");
  assert.notEqual(dedupeKey("s1", { kind: "aborted", reason: { kind: "user" } }, 1), dedupeKey("s1", { kind: "aborted", reason: { kind: "parent" } }, 1));
  assert.notEqual(dedupeKey("s1", { kind: "completed" }, 1), dedupeKey("s2", { kind: "completed" }, 1));
  // 宿主没给 turn 时退回同一键：宁可少推也不重复推
  assert.equal(dedupeKey("s1", { kind: "completed" }), dedupeKey("s1", { kind: "completed" }));
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
  assert.equal(im.calls[0].text, "✅ 任务完成 | task-notify | ziyongchajian" + NL + "工作区: ziyongchajian", "没有标题就不出「会话:」行");
}

// 11) 失败路径：error 追加原因；每轮各推一次，只有同一轮重放才去重
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding());
  const reason = { kind: "error", error: { message: "502 bad gateway" } };
  ctx._emit("session/event", session("s1", "E:/x/ziyongchajian"), turnEnd(1, reason));
  ctx._emit("session/event", session("s1", "E:/x/ziyongchajian"), turnEnd(1, reason));
  ctx._emit("session/event", session("s1", "E:/x/ziyongchajian"), turnEnd(2, reason));
  await settle();
  assert.equal(im.calls.length, 2, "每轮各推一次；同一轮的事件重放只推一次");
  assert.equal(im.calls[0].text, "❌ 任务失败 | task-notify | ziyongchajian" + NL + "工作区: ziyongchajian" + NL + "原因: 502 bad gateway");
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
  assert.equal(im.calls[2].text, "⚠️ 任务已取消 | task-notify | a" + NL + "工作区: a" + NL + "原因: 用户主动终止");
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

// 29) 首行短摘要（标题前 20 字），正文「会话:」放完整标题
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service, sessionTitle: { get: () => ({ title: "任务完成通知插件对接 dsh-im" }) } });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/ziyongchajian"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 1);
  assert.equal(im.calls[0].text, "✅ 任务完成 | task-notify | 任务完成通知插件对接 dsh-im" + NL + "工作区: ziyongchajian", "标题完整出现在首行，不在正文重复");
}

// 30) sessionTitle 缺席 / 抛错 / 空白都退回工作区名，不影响投递
{
  assert.equal(sessionTitle({}, session("s1", "E:/x/a")), "", "服务缺席给空串");
  assert.equal(sessionTitle({ sessionTitle: { get: () => { throw new Error("boom"); } } }, session("s1", "E:/x/a")), "", "抛错也吞掉");
  assert.equal(sessionTitle({ sessionTitle: { get: () => ({ title: "   " }) } }, session("s1", "E:/x/a")), "", "空白标题归一为空");
  const long = sessionTitle({ sessionTitle: { get: () => ({ title: "x".repeat(300) }) } }, session("s1", "E:/x/a"));
  assert.equal([...long].length, 300, "标题不再截断，原样交给调用方");

  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service, sessionTitle: { get: () => ({ title: "" }) } });
  apply(ctx, binding());
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls[0].text, "✅ 任务完成 | task-notify | a" + NL + "工作区: a");
}

// 31) formatMessage：标题完整进首行；无原因不出「原因:」行；无标题退回工作区名
{
  assert.equal(
    formatMessage({ label: "✅ 任务完成", title: "标题全文", cwd: "E:/x/a", phrase: "" }),
    "✅ 任务完成 | task-notify | 标题全文" + NL + "工作区: a",
  );
  assert.equal(
    formatMessage({ label: "❌ 任务失败", title: "", cwd: "E:/x/a", phrase: "boom" }),
    "❌ 任务失败 | task-notify | a" + NL + "工作区: a" + NL + "原因: boom",
  );
  // 长标题不截断
  const longTitle = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十";
  const msg = formatMessage({ label: "✅ 任务完成", title: longTitle, cwd: "E:/x/a", phrase: "" });
  assert.equal(msg.split(NL)[0], "✅ 任务完成 | task-notify | " + longTitle);
}

// 32) 标题服务缺席时首行退回工作区名，正文里不会出现裸 session id
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding());
  ctx._emit("session/event", session("session-6f2292c8-6b95-4d3d-ae8c-f73da0d9ad9e", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls[0].text, "✅ 任务完成 | task-notify | a" + NL + "工作区: a");
  assert.ok(!im.calls[0].text.includes("6f2292c8"), "不把 session id 当标题塞进通知");
}

// 33) statusEnabled：缺项 / 非布尔按开，未知 kind 跟 completed
{
  assert.equal(statusEnabled({}, "completed"), true, "没配就是开");
  assert.equal(statusEnabled({ statuses: {} }, "error"), true);
  assert.equal(statusEnabled({ statuses: { error: false } }, "error"), false);
  assert.equal(statusEnabled({ statuses: { error: false } }, "completed"), true);
  assert.equal(statusEnabled({ statuses: { error: "no" } }, "error"), true, "非布尔不当开关");
  assert.equal(statusEnabled({ statuses: { completed: false } }, "brand-new-kind"), false, "未知 kind 跟 completed");
  assert.equal(statusEnabled({}, undefined), true);
}

// 34) statuses 开关真的拦投递：关掉 completed 只推 error；filtered 计数也涨
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, binding({ statuses: { completed: false } }));
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 0, "completed 关掉就不发");
  const body = await readStatus(ctx, "GET");
  assert.equal(body.filtered, 1, "被过滤的计入 filtered");
  assert.equal(body.statuses.completed, false);
  assert.equal(body.statuses.error, true, "其它类型仍开");

  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(2, { kind: "error", error: { message: "boom" } }));
  await settle();
  assert.equal(im.calls.length, 1, "error 照发");
  assert.ok(im.calls[0].text.startsWith("❌ 任务失败"), im.calls[0].text);
}


/** 调一次桥路由并解析应答；headers 覆盖默认的本机 Host（用伪造 Host/Origin 测守卫）。 */
async function callBridge(ctx, path, { method = "GET", body, headers } = {}) {
  const route = ctx._routes.get(path);
  assert.ok(route, "桥路由应已注册: " + path);
  const req = { method, headers: { host: "127.0.0.1:19387", ...headers } };
  if (body !== undefined) {
    req[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(JSON.stringify(body), "utf8");
    };
  }
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      writeHead(status) {
        this.statusCode = status;
      },
      end(text) {
        resolve({ status: this.statusCode, body: JSON.parse(text) });
      },
    };
    // end() 里 resolve；handler 是 async，不能在 executor 里 await。
    void route.handler(req, res).catch((error) => {
      res.statusCode = 500;
      resolve({ status: 500, body: { ok: false, code: "bridge-threw", message: String(error) } });
    });
  });
}

const BRIDGE = "/api/dsh-task-notify-settings";

// 35) 设置接线：configure({auto:false}) + 桥的四个路由都注册了
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig(binding()));
  assert.equal(ctx.settings.configured, true, "声明自带卡片，宿主别再生成 schema 表单");
  for (const path of [BRIDGE + "/describe", BRIDGE + "/mutate", BRIDGE + "/targets", BRIDGE + "/test"]) {
    assert.ok(ctx._routes.has(path), path + " 未注册");
  }
}

// 36) describe：回当前配置 + dsh-im 在线账户 + 计数，前端一张卡全渲染得出来
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig(binding({ statuses: { forked: false } })));
  const { status, body } = await callBridge(ctx, BRIDGE + "/describe");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.value.ns, "task-notify");
  assert.equal(body.value.config.enabled, true);
  assert.equal(body.value.config.statuses.forked, false, "卡片读得到 statuses 开关");
  assert.deepEqual(body.value.accounts, [{ botId: WX_BOT, channel: "weixin" }]);
  assert.deepEqual(body.value.channels, [{ channel: "weixin", accounts: 1, botIds: [WX_BOT] }]);
  assert.equal(body.value.dshImInstalled, true);
  assert.equal(body.value.notified, 0);
}

// 37) mutate：写完立刻生效，不用重启 —— 关掉 completed 后同一轮次不再推
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig(binding()));
  const { body } = await callBridge(ctx, BRIDGE + "/mutate", {
    method: "POST",
    body: { ns: "task-notify", ops: [{ op: "set", path: ["rules", "statuses", "completed"], value: false }] },
  });
  assert.equal(body.ok, true);
  assert.equal(body.value.config.statuses.completed, false, "mutate 后 describe 立刻看到新值");
  assert.deepEqual(ctx._mutations[0].path, ["rules", "statuses", "completed"]);

  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 0, "新开关立刻拦住了投递");

  const back = await callBridge(ctx, BRIDGE + "/mutate", {
    method: "POST",
    body: { ns: "task-notify", ops: [{ op: "set", path: ["rules", "statuses", "completed"], value: true }] },
  });
  assert.equal(back.body.value.config.statuses.completed, true);
  ctx._emit("session/event", session("s1", "E:/x/a"), turnEnd(2, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 1, "开回来之后同一个会话也能补推（去重键在过滤之后）");
}

// 38) 桥的信任边界：非回环 403、方法不对 405、别的命名空间拒绝
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig(binding()));
  assert.equal((await callBridge(ctx, BRIDGE + "/describe", { headers: { host: "10.0.0.9:19387" } })).status, 403);
  assert.equal((await callBridge(ctx, BRIDGE + "/describe", { method: "POST" })).status, 405);
  const foreign = await callBridge(ctx, BRIDGE + "/mutate", {
    method: "POST",
    body: { ns: "model-proxy", ops: [{ op: "set", path: ["rules", "enabled"], value: false }] },
  });
  assert.equal(foreign.status, 200);
  assert.equal(foreign.body.ok, false);
  assert.equal(foreign.body.code, "settings-not-exposed", "桥只能改自己的命名空间");
  assert.equal(ctx._mutations.length, 0, "被拒的写操作没落盘");
}

// 39) targets：拿某账户下 dsh-im 已登记的收件目标，供卡片下拉选 targetId
{
  const listed = [{ targetId: WX_TARGET, name: "我自己", kind: "user" }];
  const ctx = makeCtx({
    dshIm: { listBots: async () => [{ botId: WX_BOT, channel: "weixin" }], listTargets: async () => listed, send: async () => ({ sent: true }) },
  });
  apply(ctx, ctx._setConfig(binding()));
  const { body } = await callBridge(ctx, BRIDGE + "/targets", { method: "POST", body: { botId: WX_BOT } });
  assert.equal(body.ok, true);
  assert.deepEqual(body.value.targets, [{ targetId: WX_TARGET, name: "我自己", kind: "user" }]);
  assert.equal((await callBridge(ctx, BRIDGE + "/targets", { method: "POST", body: {} })).body.code, "bot-id-required");
}

// 40) test：实发一条测试通知到全部启用目标；没目标就说清楚
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig(binding()));
  const { body } = await callBridge(ctx, BRIDGE + "/test", { method: "POST", body: {} });
  assert.equal(body.ok, true);
  assert.equal(body.value.sent, true);
  assert.equal(im.calls.length, 1);
  assert.equal(im.calls[0].targetId, WX_TARGET);
  assert.ok(im.calls[0].text.includes("测试通知"), im.calls[0].text);

  const bare = makeCtx({ dshIm: fakeIm().service });
  apply(bare, bare._setConfig({ rules: {} }));
  const none = await callBridge(bare, BRIDGE + "/test", { method: "POST", body: {} });
  assert.equal(none.body.value.sent, false);
  assert.equal(none.body.value.code, "no-target");
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
    route.handler({ method, headers: { host: "127.0.0.1:19387" } }, res);
  });
}

/** 发一次 user-questions/request，返回 next() 的值（验证没抢答）。 */
function ask(ctx, request) {
  let handed = "not-called";
  ctx._emit("user-questions/request", request, () => {
    handed = "next-returned";
    return "answered-by-host";
  });
  return () => handed;
}

const QUESTIONS = [
  {
    id: "q1",
    header: "选一个",
    question: "要\n 要哪个分支？",
    options: [
      { label: "A 方案", description: "最省事" },
      { label: "B 方案", description: "更稳" },
    ],
  },
];

// 41) 待答问题：推一条 ❓ 通知（题干压空白 + 选项），并把回答权原样交回宿主
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service, sessionTitle: { get: () => ({ title: "任务完成通知" }) } });
  apply(ctx, ctx._setConfig(binding()));
  const handed = ask(ctx, { agent: { session: session("s1", "E:/x/ziyongchajian") }, questions: QUESTIONS, turn: 4 });
  assert.equal(handed(), "next-returned", "必须继续 next()，不能自己回答");
  await settle();
  assert.equal(im.calls.length, 1);
  const text = im.calls[0].text;
  assert.ok(text.startsWith("❓ 需要你选择 | task-notify | 任务完成通知"), text);
  assert.ok(text.includes("待选: 要 要哪个分支？"), text);
  assert.ok(text.includes("  - A 方案"), text);
  assert.ok(text.includes("  - B 方案"), text);
  assert.ok(!text.includes("原因:"), "问题通知不该编原因行: " + text);
  const status = await readStatus(ctx);
  assert.equal(status.questions, 1);
  assert.equal(status.notifyQuestions, true);
}

// 42) notifyQuestions 关掉：不推，但 next() 照走（宿主照样能弹问题）
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig(binding({ notifyQuestions: false })));
  const handed = ask(ctx, { agent: { session: session("s1", "E:/x/a") }, questions: QUESTIONS, turn: 1 });
  assert.equal(handed(), "next-returned");
  await settle();
  assert.equal(im.calls.length, 0);
  assert.equal((await readStatus(ctx)).questions, 0);
}

// 43) 同会话同轮只推一次；换了轮号会再推；next() 每次都走
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig(binding()));
  const req = { agent: { session: session("s1", "E:/x/a") }, questions: QUESTIONS };
  assert.equal(ask(ctx, { ...req, turn: 2 })(), "next-returned");
  assert.equal(ask(ctx, { ...req, turn: 2 })(), "next-returned");
  assert.equal(ask(ctx, { ...req, turn: 3 })(), "next-returned");
  await settle();
  assert.equal(im.calls.length, 2);
}

// 44) subagent 默认不推；关掉 skipSubagents 后推
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig(binding()));
  const sub = { agent: { session: session("sub", "E:/x/a", { delegationDepth: 1 }) }, questions: QUESTIONS, turn: 1 };
  assert.equal(ask(ctx, sub)(), "next-returned");
  await settle();
  assert.equal(im.calls.length, 0);

  const im2 = fakeIm();
  const ctx2 = makeCtx({ dshIm: im2.service });
  apply(ctx2, ctx2._setConfig(binding({ skipSubagents: false })));
  assert.equal(ask(ctx2, sub)(), "next-returned");
  await settle();
  assert.equal(im2.calls.length, 1);
}

// 45) 空问题 / 未知形态：一条都不推，也不占计数，但 next() 照样走
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig(binding()));
  const base = { agent: { session: session("s1", "E:/x/a") }, turn: 1 };
  assert.equal(ask(ctx, { ...base, questions: [] })(), "next-returned");
  assert.equal(ask(ctx, { ...base, questions: undefined })(), "next-returned");
  assert.equal(ask(ctx, { ...base, questions: "not-an-array" })(), "next-returned");
  assert.equal(ask(ctx, { ...base, questions: [{ options: [{ label: "A" }] }] })(), "next-returned");
  await settle();
  assert.equal(im.calls.length, 0);
  assert.equal((await readStatus(ctx)).questions, 0);
}

// 46) 没绑目标的问题：跳过不发送；enabled:false 也一样
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig({ rules: {} }));
  assert.equal(ask(ctx, { agent: { session: session("s1", "E:/x/a") }, questions: QUESTIONS, turn: 1 })(), "next-returned");
  await settle();
  assert.equal(im.calls.length, 0);

  const off = fakeIm();
  const ctx2 = makeCtx({ dshIm: off.service });
  apply(ctx2, ctx2._setConfig(binding({ enabled: false })));
  assert.equal(ask(ctx2, { agent: { session: session("s1", "E:/x/a") }, questions: QUESTIONS, turn: 1 })(), "next-returned");
  await settle();
  assert.equal(off.calls.length, 0);
}

// 47) 问题文本超长：整块截断加省略号，别把聊天刷屏
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig(binding()));
  const long = [
    { question: "请确认接下来的操作范围，".repeat(30), options: [{ label: "继续" }] },
  ];
  assert.equal(ask(ctx, { agent: { session: session("s1", "E:/x/a") }, questions: long, turn: 1 })(), "next-returned");
  await settle();
  assert.equal(im.calls.length, 1);
  const body = im.calls[0].text.split(NL).slice(2).join(NL);
  assert.ok(body.length <= 300, "正文 " + body.length + " 字，超了上限");
  assert.ok(body.endsWith("…"), body.slice(-20));
}
// 48) storedRules：卡片靠它读回「配置里存着什么」，半填的行不能丢
{
  const half = { rules: { targets: [{ channel: "weixin", botId: "wx_1", targetId: "" }] } };
  assert.equal(storedRules(half).targets.length, 1, "targetId 还空着的行也要读得回来（丢了就是「点 + 账户没反应」）");
  assert.deepEqual(storedRules(half).targets[0], { channel: "weixin", botId: "wx_1", targetId: "", enabled: true });
  assert.equal(targetsOf(half.rules.targets).length, 0, "投递路径照旧丢弃半填的行");
  assert.equal(storedRules({}).enabled, true, "缺省开");
  assert.deepEqual(storedRules({}).onlyWorkspaces, []);
  assert.deepEqual(storedRules({}).fields, FIELD_DEFAULTS);
  const ws = storedRules({ rules: { workspaces: { a: [{ channel: "weixin", botId: "wx_1", targetId: "" }] } } });
  assert.equal(ws.workspaces.a.length, 1, "工作区覆盖里的半填行也一样");
}

// 49) onlyWorkspaces：空=全部；命中目录名或完整 cwd 才放行
{
  assert.equal(workspaceAllowed({ onlyWorkspaces: [] }, "E:/x/alpha"), true, "不勾=全部工作区都发");
  assert.equal(workspaceAllowed({ onlyWorkspaces: ["alpha"] }, "E:/x/alpha"), true);
  assert.equal(workspaceAllowed({ onlyWorkspaces: ["E:/x/alpha"] }, "E:/x/alpha"), true, "完整 cwd 也认");
  assert.equal(workspaceAllowed({ onlyWorkspaces: ["beta"] }, "E:/x/alpha"), false);
  assert.deepEqual(rulesOf({ rules: { onlyWorkspaces: [" alpha ", "", 7] } }).onlyWorkspaces, ["alpha"], "非串与空串丢掉");
}

// 50) fields：正文按勾选增减
{
  const full = formatMessage({
    label: "✅ 任务完成", title: "标题", cwd: "E:/x/alpha", phrase: "报错",
    sessionId: "session-1", at: "2026-10-14T00:00:00.000Z", fields: { sessionId: true, time: true },
    brief: "改完了，① 会话标题已修好。",
  });
  assert.equal(full.split(NL)[0], "✅ 任务完成 | task-notify | 标题");
  assert.ok(full.includes("工作区: alpha"), full);
  assert.ok(full.includes("原因: 报错"), full);
  assert.ok(full.includes("会话: 标题"), "「会话」行给人话标题而不是裸 id: " + full);
  assert.ok(
    formatMessage({ label: "✅", title: "", cwd: "E:/x/alpha", phrase: "", sessionId: "session-9", fields: { sessionId: true } }).includes("会话: session-9"),
    "没有标题时才退回裸 session id",
  );
  assert.ok(full.includes("时间: 2026-10-14T00:00:00.000Z"), full);
  assert.ok(full.includes("内容: 改完了，① 会话标题已修好。"), full);
  assert.ok(
    !formatMessage({ label: "✅", title: "t", cwd: "E:/x/alpha", phrase: "", fields: { brief: false }, brief: "不该出现。" }).includes("内容:"),
    "brief 关掉就不带内容行",
  );
  assert.equal(
    formatMessage({ label: "✅", title: "", cwd: "E:/x/alpha", phrase: "", fields: { title: false, workspace: false, reason: false } }),
    "✅ | task-notify | alpha",
    "全关只剩首行",
  );
  assert.equal(formatMessage({ label: "✅", cwd: "", phrase: "" }), ["✅ | task-notify | unknown", "工作区: unknown"].join(NL), "缺省仍带工作区行");
}

// 50b) answerBrief / firstSentence：从事件流本地摘本轮答复首句（不调模型、0 token）
{
  const events = [
    { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "先说明一下。后面还有话。" }] } } },
    { type: "assistant/message", surfaceOp: "append", data: { turn: 2, interrupted: true, message: { content: [{ type: "text", text: "半截话" }] } } },
    { type: "assistant/message", surfaceOp: "append", data: { turn: 3, message: { content: [{ type: "text", text: "```js\nconst a = 1;\n```\n改完了，① 会话标题已修好。" }, { type: "tool_use", name: "x" }] } } },
  ];
  assert.equal(answerBrief({ events }, 3), "改完了，① 会话标题已修好。", "丢代码块、只取 text 块、切到第一个句末");
  assert.equal(answerBrief({ events }, 1), "先说明一下。", "只看本轮；surfaceOp 缺失也认");
  assert.equal(answerBrief({ events }, 2), "", "最后一条被打断就不给摘要，不拿中途解说冒充结论");
  assert.equal(answerBrief({ snapshotEvents: () => events }, 3), "改完了，① 会话标题已修好。", "snapshotEvents 形态同样认");
  assert.equal(answerBrief({ events: [] }, 3), "", "本轮没有回复就是空");
  assert.equal(answerBrief(null, 1), "", "没有会话也不炸");
  const long = firstSentence("甲".repeat(200));
  assert.equal(long.length, 80, "超长首句截到 80 字符");
  assert.ok(long.endsWith("…"), "截断要带省略号");
  assert.equal(firstSentence(""), "", "空文本给空串");
}

// 51) onlyWorkspaces 真的拦投递（计入 filteredWorkspace，不是静默丢），并把见过的工作区报给卡片
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig(binding({ onlyWorkspaces: ["alpha"] })));
  ctx._emit("session/event", session("s1", "E:/x/beta"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 0, "不在白名单的工作区不发");
  const body = await readStatus(ctx, "GET");
  assert.equal(body.filteredWorkspace, 1);
  assert.equal(body.observed.length, 1, "见过的工作区要记下来，卡片才有东西可勾");
  assert.equal(body.observed[0].name, "beta");
  assert.equal(body.observed[0].count, 1);

  ctx._emit("session/event", session("s2", "E:/x/alpha"), turnEnd(1, { kind: "completed" }));
  await settle();
  assert.equal(im.calls.length, 1, "白名单里的照发");
  assert.ok(im.calls[0].text.includes("工作区: alpha"), im.calls[0].text);

  const describe = await callBridge(ctx, BRIDGE + "/describe");
  assert.equal(describe.body.value.observed.length, 2, "桥的 describe 也要给见过的工作区");
  assert.deepEqual(describe.body.value.observed.map((item) => item.name).sort(), ["alpha", "beta"], "两个工作区都在（次数相同按见识先后）");
}

// 52) 会话标题：事件流里最后一条 session/title（用户重命名）就是通知里的名字
{
  const events = [
    { type: "session/title", data: { title: "自动生成的旧标题", source: { kind: "system" } } },
    { type: "session/title", data: { title: "DSH桌面版本地代理模型选择插件", source: { kind: "user" } } },
    { type: "assistant/message", surfaceOp: "append", data: { turn: 1, message: { content: [{ type: "text", text: "改完了，通知里的会话改成标题了。" }] } } },
  ];
  const header = { id: "s1", cwd: "E:/x/a", type: "session", version: 7, createdAt: 0, isSeeded: false, delegationDepth: 0 };
  assert.equal(sessionTitle({}, { header, events }), "DSH桌面版本地代理模型选择插件", "取最后一条 session/title");
  assert.equal(sessionTitle({}, { header, snapshotEvents: () => events }), "DSH桌面版本地代理模型选择插件", "snapshotEvents 形态一样认");
  assert.equal(sessionTitle({ sessionTitle: { get: () => ({ title: "服务给的标题" }) } }, { header }), "服务给的标题", "没有事件才回退服务");

  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig(binding({ fields: { sessionId: true } })));
  ctx._emit("session/event", { header, events }, turnEnd(1, { kind: "completed" }));
  await settle();
  const text = im.calls[0].text;
  assert.ok(text.startsWith("✅ 任务完成 | task-notify | DSH桌面版本地代理模型选择插件"), text);
  assert.ok(text.includes("会话: DSH桌面版本地代理模型选择插件"), "「会话」行也是重命名后的标题: " + text);
  assert.ok(!text.includes("会话: s1"), "不把裸 session id 塞进通知: " + text);
  assert.ok(text.includes("内容: 改完了，通知里的会话改成标题了。"), "turn/end → answerBrief → deliver 接线：正文带本轮答复首句（本地摘取，0 token）: " + text);
}

// 53) 「通知哪些工作区」列宿主的全部工作区（storage 登记表），不只是跑过的
{
  const dir = mkdtempSync(join(tmpdir(), "task-notify-ws-"));
  try {
    writeFileSync(join(dir, "workspace.json"), JSON.stringify({
      unit: { name: "workspace", version: 2 },
      tables: {
        workspaces: {
          w1: { path: "E:/p/alpha", title: "自制插件", sessionIds: ["s1", "s2"] },
          w2: { path: "E:/p/beta", title: "", sessionIds: [] },
          w3: { path: "   ", title: "空路径不该出现", sessionIds: [] },
        },
      },
    }));
    process.env.DSH_STORAGES_DIR = dir;
    const im = fakeIm();
    const ctx = makeCtx({ dshIm: im.service });
    apply(ctx, ctx._setConfig(binding()));
    let body = await readStatus(ctx, "GET");
    assert.deepEqual(body.observed.map((item) => item.name), ["alpha", "beta"], "登记在册的两个都列出来（按会话数从多到少），空路径丢掉");
    assert.equal(body.observed[0].title, "自制插件", "带上工作区标题");
    assert.equal(body.observed[0].count, 2, "括号里的数字是会话数");
    const described = await callBridge(ctx, BRIDGE + "/describe");
    assert.equal(described.body.value.observed.length, 2, "桥的 describe 用同一份清单");

    ctx._emit("session/event", session("s9", "E:/p/gamma"), turnEnd(1, { kind: "completed" }));
    await settle();
    body = await readStatus(ctx, "GET");
    assert.deepEqual(body.observed.map((item) => item.name), ["alpha", "gamma", "beta"], "跑过但没登记的工作区也补进来");
  } finally {
    process.env.DSH_STORAGES_DIR = NO_STORAGES;
  }
}

// 54) H1：桥只认本机来源 —— 隧道域名 Host 与跨站 Origin 一律 403
{
  const im = fakeIm();
  const ctx = makeCtx({ dshIm: im.service });
  apply(ctx, ctx._setConfig(binding()));

  const tunneled = await callBridge(ctx, BRIDGE + "/describe", { headers: { host: "8c0bba4adb190f63.dsh-market.com" } });
  assert.equal(tunneled.status, 403, "隧道域名转发进来时 Host 不是回环，必须拒");
  assert.equal(tunneled.body.code, "forbidden");

  const crossSite = await callBridge(ctx, BRIDGE + "/mutate", {
    method: "POST",
    body: { ns: "task-notify", ops: [] },
    headers: { origin: "https://evil.example" },
  });
  assert.equal(crossSite.status, 403, "任意网页发起的跨站写必须拒");

  const noHost = await callBridge(ctx, BRIDGE + "/test", { method: "POST", body: {}, headers: { host: undefined } });
  assert.equal(noHost.status, 403, "没有 Host 头也拒");

  const localhost = await callBridge(ctx, BRIDGE + "/describe", { headers: { host: "localhost:19387", origin: "http://localhost:19387" } });
  assert.equal(localhost.status, 200, "localhost 前端照常能读");
  const noOrigin = await callBridge(ctx, BRIDGE + "/describe");
  assert.equal(noOrigin.status, 200, "无 Origin（同源/桌面壳）照常能读");
}

console.log("dsh-task-notify selftest: ok");
