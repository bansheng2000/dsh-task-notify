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
    statuses: { completed: true, error: true, aborted: false, blocked: true, "max-tokens": true, interrupted: true, forked: false },
    targets: [
      { enabled: true, channel: "weixin", botId: "wx_0123456789abcdef01234567", targetId: "tgt_1a2b3c4d5e6f7890" },
      { enabled: false, channel: "telegram", botId: "tg_0000000000000000", targetId: "" },
    ],
    workspaces: { ziyongchajian: [{ channel: "weixin", botId: "wx_0123456789abcdef01234567", targetId: "tgt_1a2b3c4d5e6f7890" }] },
  },
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
function loadExports(seed) {
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: { load: (entry) => { captured = entry; } },
  };
  new Function("window", SOURCE)(fakeWindow);
  assert.ok(captured, "client.js 应调 window.__ModuleLoader__.load");

  const queue = [...seed];
  const react = {
    useState: (initial) => {
      const value = queue.length > 0 ? queue.shift() : typeof initial === "function" ? initial() : initial;
      return [value, () => {}];
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
  // 工厂必须 return module.exports：宿主 cordis 拿返回值当插件，
  // 不 return 就是 "invalid plugin ... received undefined"，启动即崩。
  const plugin = captured.factory((spec) => (spec === "react" ? react : { jsx: (type, props) => ({ type, props }) }));
  assert.equal(typeof plugin?.apply, "function", "factory 必须 return module.exports");
  assert.equal(typeof plugin?.inject, "object", "inject 是数组");
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

// 5) 卡片渲染：开关、状态、收件目标、计数都从 describe 出来的配置来
const tree = base.NotifyCard({});
const nodes = walk(tree);
const boxes = nodes.filter((node) => node.type === "input" && node.props?.type === "checkbox");
assert.equal(boxes.length, 1 + 7 + 1 + 2, "总开关 + 七个状态 + 跳过子代理 + 每个收件目标一个启用勾");
assert.equal(boxes[0].props.checked, true, "总开关跟着 enabled");
assert.deepEqual(
  boxes.slice(1, 8).map((node) => node.props.checked),
  [true, true, false, true, true, true, false],
  "aborted / forked 在配置里关了，卡上就得是未勾选",
);
const picks = nodes.filter((node) => node.type === "select");
assert.equal(picks.length, 3, "format 下拉 + 两个目标的 channel 下拉");
assert.deepEqual(picks[0].props.children.map((o) => o.props.value), ["plain", "markdown"], "第一个下拉是消息格式");
assert.equal(picks[0].props.value, "plain");
assert.deepEqual(picks.slice(1).map((node) => node.props.value), ["weixin", "telegram"], "后面两个是各目标的通道");
assert.deepEqual(picks[1].props.children.map((o) => o.props.value), ["weixin"]);
assert.equal(picks[1].props.children[0].props.children, "weixin（1）", "下拉上带该通道的账户数");
const spans = nodes.filter((node) => node.type === "span").map((node) => node.props.children);
assert.ok(spans.includes("启用通知"));
assert.ok(spans.includes("跳过子代理"));
const flat = JSON.stringify(tree);
assert.ok(flat.includes("tgt_1a2b3c4d5e6f7890"), "已填的 targetId 显示在输入框里");
assert.ok(flat.includes("ziyongchajian=weixin"), "工作区规则回填到 textarea");
assert.ok(flat.includes("已推送 3 · 未绑定跳过 1 · 状态过滤 2 · 去重 4 · 失败 0"));

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

console.log("dsh-task-notify client selftest: ok");
