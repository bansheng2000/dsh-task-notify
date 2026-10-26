// dsh-task-notify 设置卡片自检：client.js 是 window.__ModuleLoader__.load 形态，
// 不进宿主，所以这里给它一个假 window + 假 react，把卡片渲染成纯对象树来断言。
// 跑法：node test/client.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const NL = String.fromCharCode(10);

/** describe 的应答 —— 一份够卡片渲染全字段的配置。 */
const DESCRIBED = {
  ns: "task-notify",
  config: {
    enabled: true,
    format: "plain",
    skipSubagents: true,
    notifyQuestions: true,
    skipWhenWatching: true,
    afkAfterMs: 120000,
    statuses: { completed: true, error: true, aborted: false, blocked: true, "max-tokens": true, interrupted: true, forked: false },
    targets: [
      { enabled: true, channel: "weixin", botId: "wx_0123456789abcdef01234567", targetId: "tgt_1a2b3c4d5e6f7890" },
      { enabled: false, channel: "telegram", botId: "tg_0000000000000000", targetId: "" },
    ],
    workspaces: { ziyongchajian: [{ channel: "weixin", botId: "wx_0123456789abcdef01234567", targetId: "tgt_1a2b3c4d5e6f7890" }] },
    fields: { title: true, workspace: true, reason: true, sessionId: false, time: false },
    onlyWorkspaces: ["alpha"],
  },
  observed: [
    { name: "alpha", cwd: "E:/p/alpha", title: "自制插件", count: 3, last: "session-1" },
    { name: "beta", cwd: "E:/p/beta", count: 1, last: "session-2" },
  ],
  dshImInstalled: true,
  accounts: [{ botId: "wx_0123456789abcdef01234567", channel: "weixin" }],
  channels: [{ channel: "weixin", accounts: 1, botIds: ["wx_0123456789abcdef01234567"] }],
  notified: 3,
  skippedUnbound: 1,
  filtered: 2,
  deduped: 4,
  failed: 0,
};

/** 收集树里的所有节点（含 props.children 里的数组）。 */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return out;
  }
  if (typeof node !== "object") return out;
  out.push(node);
  walk(node.props?.children, out);
  return out;
}

function texts(tree) {
  return walk(tree).filter((node) => typeof node.type === "string" && node.type !== "input" && node.type !== "select" && node.type !== "option" && node.type !== "textarea" && node.type !== "button");
}

/** 假 hooks：useState 按调用顺序吐种子值（卡片里的顺序是固定的），useEffect 不跑。 */
function loadExports(seed, windowExtra) {
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: { load: (entry) => { captured = entry; } },
    ...(windowExtra ?? {}),
  };
  new Function("window", SOURCE)(fakeWindow);
  assert.ok(captured, "client.js 应调 window.__ModuleLoader__.load");

  const queue = [...seed];
  const sets = [];
  const react = {
    useState: (initial) => {
      const value = queue.length > 0 ? queue.shift() : typeof initial === "function" ? initial() : initial;
      // 记下 setXxx 调过什么：「点了没反应」这类 bug 就死在这条路径上。
      const slot = sets.length;
      const set = (...args) => { sets[slot] = { index: slot, args }; };
      sets[slot] = { index: slot, args: [] };
      return [value, set];
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  // 工厂必须 return module.exports：宿主 cordis 拿返回值当插件，
  // 不 return 就是 "invalid plugin ... received undefined"，启动即崩。
  const plugin = captured.factory((spec) => (spec === "react" ? react : { jsx: (type, props) => ({ type, props }) }));
  assert.equal(typeof plugin?.apply, "function", "factory 必须 return module.exports");
  assert.equal(typeof plugin?.inject, "object", "inject 是数组");
  plugin.__sets = sets;
  return plugin;
}

// 1) 入口形态：ModuleLoader.load + apply/inject 导出，seam 只有 slots
// 种子顺序 = useState 声明顺序：value, error, note, busy, wsText, picked（真实界面里 wsText 由 useEffect 从 describe 填）。
const base = loadExports([DESCRIBED, null, null, false, "ziyongchajian=weixin|wx_0123456789abcdef01234567|tgt_1a2b3c4d5e6f7890", null]);
assert.deepEqual(base.inject, ["slots"], "卡片只挂 slots，硬依赖会让 fiber 永不激活");

// 2) 挂载点：plugins.row.config + key <包名>#<行 id>
let registered = null;
let slotName = null;
base.apply({
  slots: {
    inject: (name, register) => { slotName = name; register(); },
    register: (definition, render) => { registered = { definition, render }; },
  },
});
assert.equal(slotName, "plugins.row.config");
assert.equal(registered.definition.name, "plugins.row.config");
assert.equal(registered.definition.key, "dsh-task-notify#task-notify");

// 3) summary 视图给插件列表页一行摘要；其它视图出卡片
assert.equal(registered.render({ view: "summary", state: DESCRIBED.config }), "1 个收件目标", "停用的那条不算");
assert.equal(registered.render({ view: "summary", state: { rules: { enabled: false } } }), "未启用");
assert.equal(typeof registered.render({}).type, "function", "非 summary 渲染 React 组件");

// 4) workspaces 文本 <-> 配置对象 双向转换
assert.deepEqual(base.parseWorkspaces("  alpha = weixin | wx_1 | tgt_2 " + NL + NL + "坏行没有等号"), {
  alpha: [{ channel: "weixin", botId: "wx_1", targetId: "tgt_2" }],
});
assert.equal(base.formatWorkspaces(DESCRIBED.config.workspaces), "ziyongchajian=weixin|wx_0123456789abcdef01234567|tgt_1a2b3c4d5e6f7890");
assert.equal(base.formatWorkspaces(null), "");

// 4b) M4：显示取第一条启用的；保存按行合并，不抹掉同工作区的第 2..N 条与 enabled:false
assert.equal(
  base.formatWorkspaces({ alpha: [
    { channel: "weixin", botId: "wx_1", targetId: "tgt_1", enabled: false },
    { channel: "weixin", botId: "wx_2", targetId: "tgt_2", enabled: true },
  ] }),
  "alpha=weixin|wx_2|tgt_2",
  "显示第一条启用的目标（停用的那条仍在配置里）",
);
const twoTargets = { alpha: [
  { channel: "weixin", botId: "wx_1", targetId: "tgt_1", enabled: true },
  { channel: "weixin", botId: "wx_2", targetId: "tgt_2", enabled: false },
] };
assert.deepEqual(
  base.mergeWorkspaces(twoTargets, base.parseWorkspaces("alpha=weixin|wx_1|tgt_1")),
  twoTargets,
  "行没改过：原数组整条保留（第 2 条与 enabled:false 都还在）",
);
assert.deepEqual(
  base.mergeWorkspaces(twoTargets, base.parseWorkspaces("alpha=weixin|wx_9|tgt_9" + NL + "beta=weixin|wx_1|tgt_1")),
  {
    alpha: [{ channel: "weixin", botId: "wx_9", targetId: "tgt_9" }],
    beta: [{ channel: "weixin", botId: "wx_1", targetId: "tgt_1" }],
  },
  "改过的行按文本写一条、新行照写、文本里没有的工作区=删掉",
);
assert.deepEqual(base.mergeWorkspaces(null, base.parseWorkspaces("alpha=weixin|wx_1|tgt_1")), {
  alpha: [{ channel: "weixin", botId: "wx_1", targetId: "tgt_1" }],
}, "没有基线配置时按文本写");

// 4c) M4：wsText 还没填上（describe 没回来）时点保存只报错，不发清空请求
const unloaded = loadExports([DESCRIBED, null, null, false, null, null]);
const unloadedTree = unloaded.NotifyCard({});
const saveBtn = walk(unloadedTree).find((node) => node.type === "button" && node.props?.children === "保存工作区规则");
assert.ok(saveBtn, "卡片上有「保存工作区规则」按钮");
saveBtn.props.onClick();
assert.ok(String(unloaded.__sets[1].args[0]).includes("先点「刷新」"), "没读到配置时点保存要拦下来并提示");

// 4d) M5：桥调用一定带超时信号；超时要给独立错误码而不是「连不上」
{
  const savedFetch = globalThis.fetch;
  const savedAbort = globalThis.AbortSignal;
  const seen = [];
  globalThis.AbortSignal = { timeout: (ms) => "SIG:" + ms };
  globalThis.fetch = async (url, options) => { seen.push({ url, options }); return { status: 200, text: async () => "{\"ok\":true}" }; };
  try {
    assert.deepEqual(await base.bridgeCall("/describe", "GET"), { ok: true });
    assert.equal(seen[0].options.signal, "SIG:20000", "GET 也带 20 秒超时信号");
    await base.bridgeCall("/test", "POST", { ns: "task-notify" });
    assert.equal(seen[1].options.signal, "SIG:20000", "POST 同样带超时信号");
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.AbortSignal = savedAbort;
  }
}
{
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
  try {
    const timedOut = await base.bridgeCall("/describe", "GET");
    assert.equal(timedOut.code, "bridge-timeout", "超时要有独立错误码，别和连不上混在一起");
    assert.ok(timedOut.message.includes("没应答"));
  } finally {
    globalThis.fetch = savedFetch;
  }
}

// 5) 卡片渲染：开关、状态、收件目标、计数都从 describe 出来的配置来
const tree = base.NotifyCard({});
const nodes = walk(tree);
const boxes = nodes.filter((node) => node.type === "input" && node.props?.type === "checkbox");
assert.equal(boxes.length, 1 + 7 + 3 + 2 + 2 + 7 + 2, "总开关 + 七个状态 + 跳过子代理 + 待答问题 + 我在看就不推 + 桌面通知/常驻/标签页未读 + 每个收件目标一个启用勾 + 六个正文字段 + 两个见过的工作区");
assert.equal(boxes[0].props.checked, true, "总开关跟着 enabled");
assert.deepEqual(
  boxes.slice(1, 8).map((node) => node.props.checked),
  [true, true, false, true, true, true, false],
  "aborted / forked 在配置里关了，卡上就得是未勾选",
);
const picks = nodes.filter((node) => node.type === "select");
assert.equal(picks.length, 4, "format 下拉 + 提示音下拉 + 两个目标的 channel 下拉");
assert.deepEqual(picks[0].props.children.map((o) => o.props.value), ["plain", "markdown"], "第一个下拉是消息格式");
assert.equal(picks[0].props.value, "plain");
assert.deepEqual(picks[1].props.children.map((o) => o.props.value), ["none", "beep", "chime", "custom"], "第二个下拉是提示音");
assert.equal(picks[1].props.value, "beep", "没配过就是缺省的 beep");
assert.deepEqual(picks.slice(2).map((node) => node.props.value), ["weixin", "telegram"], "后面两个是各目标的通道");
assert.deepEqual(picks[2].props.children.map((o) => o.props.value), ["weixin"]);
assert.equal(picks[2].props.children[0].props.children, "weixin（1）", "下拉上带该通道的账户数");
const spans = nodes.filter((node) => node.type === "span").map((node) => node.props.children);
assert.ok(spans.includes("启用通知"));
assert.ok(spans.includes("跳过子代理"));
assert.ok(spans.includes("会话要你选择时也提示"));
assert.ok(spans.includes("我在看这个会话时不推"));
assert.ok(spans.includes("秒算离开"), "afkAfterMs 有秒数输入框");
assert.ok(spans.includes("系统通知（点一下跳到那条会话）"), "卡片上有系统通知开关");
assert.ok(spans.includes("标签页未读标记"), "卡片上有标签页未读开关");
assert.ok(
  nodes.some((node) => node.type === "button" && node.props?.children === "试听"),
  "提示音可以试听",
);
const flat = JSON.stringify(tree);
assert.ok(flat.includes("tgt_1a2b3c4d5e6f7890"), "已填的 targetId 显示在输入框里");
assert.ok(flat.includes("ziyongchajian=weixin"), "工作区规则回填到 textarea");
assert.ok(flat.includes("已推送 3 · 未绑定跳过 1 · 状态过滤 2 · 去重 4 · 失败 0"));
assert.ok(flat.includes("alpha · 自制插件（3 次）"), "工作区勾选项带标题与次数");

// 6) dsh-im 没在线账户时给提示，而不是空白卡片
const offline = loadExports([
  Object.assign({}, DESCRIBED, { accounts: [], channels: [], dshImInstalled: true }),
  null, null, false, null, null,
]);
const warn = JSON.stringify(offline.NotifyCard({}));
assert.ok(warn.includes("dsh-im 当前没有在线账户"), warn.slice(0, 200));

// 7) 桥 404 时卡片给出可读的错，而不是一直转圈
const missing = loadExports([
  null,
  "桥未注册 —— 插件服务端没跑起来？",
  null, false, null, null,
]);
assert.ok(JSON.stringify(missing.NotifyCard({})).includes("桥未注册"));

// 8) 「选收件人」点了必须有反应：botId 为空要给提示，dsh-im 那边空列表要给出下一步
const blank = loadExports([
  Object.assign({}, DESCRIBED, {
    config: Object.assign({}, DESCRIBED.config, {
      targets: [{ enabled: true, channel: "weixin", botId: "", targetId: "" }],
    }),
  }),
  null, null, false, null, null,
]);
const pickBtn = walk(blank.NotifyCard({})).find((node) => node.type === "button" && node.props?.children === "选收件人");
assert.ok(pickBtn, "卡片上得有「选收件人」按钮");
pickBtn.props.onClick();
assert.equal(blank.__sets[1].args.length, 1, "botId 为空必须 setError，不能静默 return");
assert.match(String(blank.__sets[1].args[0]), /botId/, "提示要说清楚缺什么");

const empty = loadExports([DESCRIBED, null, null, false, null, { index: 0, options: [] }]);
const emptyTree = JSON.stringify(empty.NotifyCard({}));
assert.ok(emptyTree.includes("还没有已登记的收件目标"), "dsh-im 返回空列表时要给出下一步，而不是什么都不渲染");

const filled = loadExports([DESCRIBED, null, null, false, null, { index: 0, options: [{ targetId: "tgt_9", name: "老王" }] }]);
const filledSelects = walk(filled.NotifyCard({})).filter((node) => node.type === "select");
assert.equal(filledSelects.length, 5, "有可选项时多出一个下拉（format + 提示音 + 两个 channel + 收件人）");
const pickSelect = filledSelects.find((node) => JSON.stringify(node.props.children).includes("tgt_9"));
assert.ok(pickSelect, "下拉里列着 dsh-im 返回的那个 targetId");

// 9) 桥请求失败必须变成卡片上的一句人话，而不是被吞掉的 rejected promise
const realFetch = globalThis.fetch;
try {
  globalThis.fetch = () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:19387"));
  const down = await base.bridgeCall("/targets", "POST", { botId: "wx_1" });
  assert.equal(down.ok, false, "fetch 抛异常也要返回 ok:false");
  assert.equal(down.code, "bridge-unreachable");

  globalThis.fetch = () => Promise.resolve({ status: 404, text: async () => "" });
  assert.equal((await base.bridgeCall("/describe", "GET")).code, "bridge-missing");

  globalThis.fetch = () => Promise.resolve({ status: 401, text: async () => "<html>login</html>" });
  const html = await base.bridgeCall("/targets", "POST", { botId: "wx_1" });
  assert.equal(html.code, "bridge-unreadable", "宿主鉴权页/HTML 也要读得出原因");
  assert.match(html.message, /401/);
} finally {
  globalThis.fetch = realFetch;
}

// 10) 正文可配（「通知里包含」）+ 工作区可勾（「通知哪些工作区」）：勾一下就要写回配置
const fieldBoxes = boxes.slice(14, 20);
assert.deepEqual(fieldBoxes.map((node) => node.props.checked), [true, true, true, true, false, false], "字段缺省：标题/工作区/原因/答复首句勾上，会话 id 与时间不勾");
const wsBoxes = boxes.slice(20, 22);
assert.deepEqual(wsBoxes.map((node) => node.props.checked), [true, false], "工作区勾选跟着 onlyWorkspaces（只勾了 alpha）");

let posted = null;
const realFetchMutate = globalThis.fetch;
globalThis.fetch = (url, init) => { posted = JSON.parse(init.body); return Promise.resolve({ status: 200, text: async () => JSON.stringify({ ok: true, value: DESCRIBED }) }); };
try {
  fieldBoxes[4].props.onChange({ target: { checked: true } });
  assert.equal(posted.ops[0].path.join("."), "rules.fields", "勾字段写 rules.fields");
  assert.equal(posted.ops[0].value.sessionId, true, "勾上会话 id");
  assert.equal(posted.ops[0].value.title, true, "其它字段原样保留");

  posted = null;
  wsBoxes[1].props.onChange({ target: { checked: true } });
  assert.deepEqual(posted.ops[0].value, ["alpha", "beta"], "勾上工作区写 onlyWorkspaces（目录名）");

  posted = null;
  wsBoxes[0].props.onChange({ target: { checked: false } });
  assert.deepEqual(posted.ops[0].value, [], "取消勾选就把它摘掉");

  // 11) 「+ 账户」按钮：点一下必须真的发 mutate，且带上 targetId 为空的新行
  const addBtn = nodes.find((node) => node.type === "button" && String(node.props?.children).startsWith("+ "));
  assert.ok(addBtn, "在线账户旁边要有「+ 渠道 · …」按钮");
  posted = null;
  addBtn.props.onClick();
  assert.ok(posted, "点「+ 账户」必须发一次 mutate");
  const rows = posted.ops[0].value;
  assert.equal(rows.length, DESCRIBED.config.targets.length + 1, "新行追加在列表末尾");
  assert.deepEqual(rows[rows.length - 1], { enabled: true, channel: "weixin", botId: "wx_0123456789abcdef01234567", targetId: "" }, "新行允许 targetId 为空，服务端不能把它回填成 []");
  // patch 开头会 setError(null) 清错误；留下字符串就是真报错了。
  assert.equal(base.__sets[1].args[0] ?? null, null, "点击不能报错（静默无反应就是死在这条路径上）");
} finally {
  globalThis.fetch = realFetchMutate;
}

// 4d) 桌面提醒通道（0.10.0）：轮询 /alerts → 弹气泡 + 响提示音 + 标签页未读，点气泡跳会话
{
  // client.js 里的 installDesktop 直接摸 window / document / Notification / fetch，
  // 这里给它们造一套最小替身，跑真正的消费逻辑（不是断言源码里有没有那几行）。
  const notifications = [];
  const opened = [];
  const tones = [];
  let payload = { since: 0, alerts: [], desktop: { notice: true, badge: true, sound: "beep", soundUrl: "" } };

  const listeners = { window: {}, document: {} };
  const fakeWindow = {
    focus: () => {},
    addEventListener: (type, fn) => { (listeners.window[type] ??= []).push(fn); },
    AudioContext: class {
      constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
      createOscillator() {
        return { type: "", frequency: { value: 0 }, connect: (node) => node, start: () => {}, stop: () => {} };
      }
      createGain() {
        return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: (node) => { tones.push(node); return node; } };
      }
    },
    Audio: class { constructor(url) { this.url = url; } play() { tones.push(this.url); return Promise.resolve(); } },
    // 两个窗口共享同一份 localStorage —— 跨页去重就靠它。
    localStorage: (() => {
      const store = new Map();
      return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
      };
    })(),
  };
  const fakeDocument = {
    title: "我的工作台",
    visibilityState: "hidden",
    addEventListener: (type, fn) => { (listeners.document[type] ??= []).push(fn); },
  };
  class FakeNotification {
    static permission = "granted";
    constructor(label, options) {
      this.label = label;
      this.body = options.body;
      this.tag = options.tag;
      this.closed = false;
      this.requireInteraction = options.requireInteraction;
      notifications.push(this);
    }
    close() { this.closed = true; }
  }

  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    Notification: globalThis.Notification,
  };
  globalThis.window = fakeWindow;
  globalThis.document = fakeDocument;
  globalThis.Notification = FakeNotification;
  // client.js 里的 `window` 是 ModuleLoader 传入的那个对象，不是 globalThis.window，
  // 所以浏览器能力要挂到那个假 window 上（见 loadExports 的第二参数）。
  let asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { status: 200, text: async () => JSON.stringify({ ok: true, value: payload }) };
  };

  // 定时器不真等 3 秒：拦下 setInterval，留一个 tick() 手动触发。
  const savedInterval = globalThis.setInterval;
  let tick = async () => {};
  globalThis.setInterval = (fn) => {
    tick = async () => { fn(); await new Promise((resolve) => setTimeout(resolve, 10)); };
    return { unref() {} };
  };

  try {
    const base2 = loadExports([DESCRIBED, null, null, false, null, null], fakeWindow);
    // 宿主当前显示的是别的会话（s9）：s1 的通知该弹、该算未读；s9 的不吵。
    const ctx = {
      on: () => {},
      get: (name) => {
        if (name === "uiWorkspace") return { openSession: (id) => opened.push(id) };
        if (name === "sidebarRight") return { mounted: { getSnapshot: () => "s9" } };
        return undefined;
      },
    };
    base2.installDesktop(ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(asked.length, 1, "装了就该立刻轮一次");
    assert.equal(asked[0].url, "/api/dsh-task-notify-settings/alerts", "走 /alerts 路由");
    assert.deepEqual(asked[0].body, { since: 0 }, "首次游标从 0 开始");
    assert.equal(notifications.length, 0, "没有新提醒时不打扰");
    assert.equal(fakeDocument.title, "我的工作台", "没有新提醒时不动标题");

    const base3 = loadExports([DESCRIBED, null, null, false, null, null], fakeWindow);
    asked = [];
    globalThis.fetch = async (url, init) => {
      asked.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return {
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          value: {
            since: 2,
            alerts: [
              { seq: 2, sessionId: "s1", label: "✅ 任务完成", title: "重构通知", brief: "改完了", ws: "w" },
              { seq: 3, sessionId: "s9", label: "❌ 任务失败", title: "正在看的会话", brief: "", ws: "w" },
            ],
            desktop: { notice: true, badge: true, sound: "beep" },
          },
        }),
      };
    };
    // 「正看着」只可能发生在页面可见时；页签在后台就照常弹。
    fakeDocument.visibilityState = "visible";
    base3.installDesktop(ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(notifications.length, 1, "只给不看的那条弹气泡（正看着的 s9 不吵）");
    assert.equal(notifications[0].label, "✅ 任务完成");
    assert.equal(notifications[0].tag, "dsh-task-notify:s1", "气泡按会话打成同一个 tag");
    assert.equal(notifications[0].requireInteraction, true, "气泡默认常驻：不点不自己滑走");
    assert.ok(String(notifications[0].body).includes("重构通知"), "气泡正文带会话标题");
    assert.equal(fakeDocument.title, "(1) 我的工作台", "标签页标题加未读前缀（正看着的 s9 不算未读）");
    assert.ok(tones.length > 0, "同时响提示音（beep 现场合成）");
    assert.deepEqual(asked[0].body, { since: 0 }, "第一轮用 since=0 拉全量");
    // 手工推进定时器：换一份 payload 再轮一次，游标应带着上一轮的 since=2 去问。
    await tick();
    // 游标 = max(本轮最大 seq=3, value.since=2) → 3，下一轮只拉增量。
    assert.deepEqual(asked[asked.length - 1].body, { since: 3 }, "游标推进到本轮最大 seq，下一轮只拉增量");

    // 同一个页面重复 apply（宿主热重载 / 双实例）：第二次不能起第二个轮询。
    const askedBefore = asked.length;
    base3.installDesktop(ctx);
    assert.equal(asked.length, askedBefore, "同一页面只装一次（第二个轮询会把一条提醒弹两遍）");

    // 另一个窗口：共享游标里已经是 3，不该把旧提醒再弹一遍。
    const otherTab = loadExports([DESCRIBED, null, null, false, null, null], fakeWindow);
    const otherAsked = [];
    globalThis.fetch = async (url, init) => {
      otherAsked.push(init?.body ? JSON.parse(init.body) : null);
      return { status: 200, text: async () => JSON.stringify({ ok: true, value: { since: 3, alerts: [], desktop: { notice: true, badge: true, sound: "beep" } } }) };
    };
    const notificationsBefore = notifications.length;
    otherTab.installDesktop(ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(otherAsked[0], { since: 3 }, "另一个窗口带着共享游标来取，不会重放");
    assert.equal(notifications.length, notificationsBefore, "另一个窗口不重复弹");

    notifications[0].onclick();
    assert.deepEqual(opened, ["s1"], "点气泡跳到那条会话");
    assert.equal(notifications[0].closed, true, "点完把气泡关掉");

    for (const fn of listeners.window.focus ?? []) fn();
    assert.equal(fakeDocument.title, "我的工作台", "页面获得焦点后未读标记恢复");

    // 关掉开关：不再弹也不加标记，但服务端照样计数（消费端只负责表现）
    const base4 = loadExports([DESCRIBED, null, null, false, null, null], fakeWindow);
    notifications.length = 0;
    globalThis.fetch = async () => ({
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        value: { since: 1, alerts: [{ seq: 1, sessionId: "s2", label: "✅", title: "t", brief: "", ws: "w" }], desktop: { notice: false, badge: false, sound: "none" } },
      }),
    });
    base4.installDesktop(ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 常驻可以关掉：requireInteraction false 就是系统默认时长（几秒后自己消失）。
    const base5 = loadExports([DESCRIBED, null, null, false, null, null], fakeWindow);
    notifications.length = 0;
    globalThis.fetch = async () => ({
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        value: { since: 99, alerts: [{ seq: 99, sessionId: "s7", label: "✅", title: "t", brief: "", ws: "w" }], desktop: { notice: true, badge: false, sound: "none", sticky: false } },
      }),
    });
    base5.installDesktop(ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(notifications.length, 1, "noticeSticky 关掉仍然弹，只是不常驻");
    assert.equal(notifications[0].requireInteraction, false, "关掉常驻后按系统默认时长消失");

    // 收尾：把「都不弹」这一档也走一遍
    const base4b = loadExports([DESCRIBED, null, null, false, null, null], fakeWindow);
    notifications.length = 0;
    globalThis.fetch = async () => ({
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        value: { since: 100, alerts: [{ seq: 100, sessionId: "s8", label: "✅", title: "t", brief: "", ws: "w" }], desktop: { notice: false, badge: false, sound: "none", sticky: true } },
      }),
    });
    base4b.installDesktop(ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(notifications.length, 0, "desktopNotice 关掉就不弹");
    assert.equal(fakeDocument.title, "我的工作台", "titleBadge 关掉就不加未读");
  } finally {
    globalThis.setInterval = savedInterval;
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.fetch = saved.fetch;
    globalThis.Notification = saved.Notification;
  }
}

// 4e) L6(i)：收件目标行的 key 按内容生成，删中间一行不会让 React 复用错行
{
  // 假 react 的 useState 每次渲染都会取走一个种子，所以这里必须用新加载的实例渲染，不能复用前面渲染过多次的 base。
  const fresh = loadExports([DESCRIBED, null, null, false, "ziyongchajian=weixin|wx_0123456789abcdef01234567|tgt_1a2b3c4d5e6f7890", null]);
  const rows = walk(fresh.NotifyCard({})).filter((node) => node.props?.className === "tn-item" || node.props?.className === "tn-item tn-off");
  assert.equal(rows.length, 2, "两个目标两行");
  const keys = rows.map((node) => node.props.key);
  assert.equal(new Set(keys).size, 2, "两行 key 必须不同（用下标做 key 时这里是 0 和 1，仍然不同，见下一条断言）");
  assert.ok(keys.every((key) => typeof key === "string" && key.startsWith("tgt-")), "key 得是内容键，不是下标：实际 " + JSON.stringify(keys));
  assert.ok(keys[0].includes("weixin") && keys[0].includes("tgt_1a2b3c4d5e6f7890"), "第一行的 key 带上渠道与 targetId");
  assert.ok(keys[1].includes("telegram"), "第二行的 key 跟着内容走");
}
console.log("dsh-task-notify client selftest: ok");
