// dsh-task-notify — 设置卡片（免构建，直接注入宿主 ModuleLoader）
//
// 挂载点：侧栏 插件 → 已安装 → dsh-task-notify → 行配置。
// key 规则见 ui-plugin-manager 的 rowConfigKey：<包名>#<patch 里声明的行 id>。
// 所有改动经桥写回配置存储，插件的 config 对象随之更新，落盘即生效、不用重启。
window.__ModuleLoader__.load({
  id: "dsh-task-notify",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const { useCallback, useEffect, useState } = require("react");
    const { jsx } = require("react/jsx-runtime");

    const BRIDGE = "/api/dsh-task-notify-settings";
    const NS = "task-notify";
    const STATUS_ROWS = [
      ["completed", "完成"],
      ["error", "失败"],
      ["aborted", "取消"],
      ["blocked", "被拦截"],
      ["max-tokens", "超长中断"],
      ["interrupted", "中断"],
      ["forked", "已分叉"],
    ];

    /**
     * 桥调用。fetch / JSON.parse 抛出的异常在这里一律折成 {ok:false,message}：
     * 原来直接往上抛，调用方的 catch 接不到，界面表现就是「点了没反应」。
     */
    /** 桥最多等这么久。没有它，桥卡住时按钮上的 busy 会永远转（M5）。 */
    const BRIDGE_TIMEOUT_MS = 20_000;

    /** 老渲染进程没有 AbortSignal.timeout 时退回无信号（fetch 行为与改动前一致）。 */
    function bridgeSignal() {
      return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(BRIDGE_TIMEOUT_MS)
        : undefined;
    }

    async function bridgeCall(path, method, body) {
      try {
        const response = await fetch(BRIDGE + path, body === undefined
          ? { method, signal: bridgeSignal() }
          : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: bridgeSignal() });
        if (response.status === 404) return { ok: false, code: "bridge-missing", message: "桥未注册 —— 插件服务端没跑起来？" };
        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch {
          return {
            ok: false,
            code: "bridge-unreadable",
            message: "设置桥返回 HTTP " + response.status + " 而不是 JSON：" + text.slice(0, 120),
          };
        }
      } catch (error) {
        const name = String(error?.name ?? "");
        if (name === "TimeoutError" || name === "AbortError") {
          return { ok: false, code: "bridge-timeout", message: "设置桥 " + Math.round(BRIDGE_TIMEOUT_MS / 1000) + " 秒没应答（超时，别反复重试）" };
        }
        return { ok: false, code: "bridge-unreachable", message: "连不上设置桥：" + String(error?.message ?? error) };
      }
    }

    const bridgeGet = (path) => bridgeCall(path, "GET");
    const bridgePost = (path, body) => bridgeCall(path, "POST", body);

    /** 正文里可选带的字段；与服务端 FIELD_DEFAULTS 一致（缺省不带的就是 false）。 */
    const FIELD_ROWS = [
      ["title", "会话标题"],
      ["workspace", "工作区"],
      ["reason", "原因"],
      ["brief", "答复首句"],
      ["sessionId", "会话 id"],
      ["time", "时间"],
    ];
    // 渲染进程 import 不到宿主的 lib/index.js，所以这里只能有一份镜像；
    // 只是 describe 没给出该字段时的兜底 —— 权威值永远以 describe 的 config.fields 为准。
    const FIELD_DEFAULTS = { title: true, workspace: true, reason: true, brief: true, sessionId: false, time: false };

    /** 工作区勾选项标签：目录名（· 工作区标题）（跑过几次）。没次数就不写括号。 */
    function wsLabel(item) {
      const title = typeof item.title === "string" && item.title !== "" && item.title !== item.name ? " · " + item.title : "";
      const count = Number(item.count) > 0 ? "（" + Number(item.count) + " 次）" : "";
      return item.name + title + count;
    }

    const CSS = [
      ".tn-card{font-family:-apple-system,\"Segoe UI\",system-ui,sans-serif;color:#1d1d1f;border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:12px;min-width:0}",
      "@media (prefers-color-scheme:dark){.tn-card{color:#f5f5f7;border-color:rgba(255,255,255,.1);background:rgba(30,30,32,.5)}}",
      ".tn-title{font-size:14px;font-weight:700}",
      ".tn-hint{font-size:11px;opacity:.6;line-height:1.5}",
      ".tn-row{display:flex;flex-direction:column;gap:6px}",
      ".tn-label{font-size:12px;font-weight:600;opacity:.75}",
      ".tn-checks{display:flex;flex-wrap:wrap;gap:6px 14px}",
      ".tn-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer}",
      ".tn-input{padding:7px 9px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font-size:13px;font-family:inherit;min-width:0}",
      ".tn-input:focus{outline:2px solid rgba(0,122,255,.5);outline-offset:1px}",
      ".tn-textarea{min-height:70px;resize:vertical;line-height:1.6}",
      ".tn-item{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:9px;border:1px solid rgba(128,128,128,.22)}",
      ".tn-itemTop{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".tn-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".tn-btn{padding:6px 14px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font-size:13px;cursor:pointer;font-family:inherit}",
      ".tn-btnPrimary{background:#007aff;border-color:#007aff;color:#fff}",
      ".tn-btn:disabled{opacity:.5;cursor:default}",
      ".tn-status{font-size:11px;opacity:.7;font-family:ui-monospace,monospace;white-space:pre-wrap;word-break:break-all}",
      ".tn-err{color:#c5221f}",
      ".tn-warn{font-size:11px;padding:8px 10px;border-radius:8px;background:rgba(255,180,0,.12);border:1px solid rgba(255,180,0,.3);line-height:1.5}",
      ".tn-off{opacity:.5}"
    ].join("\n");

    function injectCss() {
      if (document.getElementById("dsh-task-notify-css")) return;
      const el = document.createElement("style");
      el.id = "dsh-task-notify-css";
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    /** workspaces 在卡片里存成一行一条：名称=channel|botId|targetId。 */
    function parseWorkspaces(text) {
      const out = {};
      for (const raw of String(text ?? "").split(String.fromCharCode(10))) {
        const line = raw.trim();
        if (line === "") continue;
        const cut = line.indexOf("=");
        if (cut <= 0) continue;
        const name = line.slice(0, cut).trim();
        const parts = line.slice(cut + 1).split("|").map((part) => part.trim());
        if (name !== "" && parts.length >= 3) {
          out[name] = [{ channel: parts[0], botId: parts[1], targetId: parts[2] }];
        }
      }
      return out;
    }

    /** 显示用：优先第一条启用的，否则第一条。停用的目标仍在配置里，只是不显示。 */
    function displayTarget(list) {
      if (!Array.isArray(list)) return null;
      return list.find((row) => row && row.enabled !== false) ?? list[0] ?? null;
    }

    /**
     * 保存时按行合并，不做整块覆盖：文本里那一行还是显示值（用户没动它）→ 把原数组原样留下，
     * 同一工作区的第 2..N 条目标与 enabled:false 才不会因为「打开卡片点一下保存」就消失。
     * 行被改写或新增 → 按文本写一条（文本语法只放得下一条）；文本里删掉的行 = 用户要删这条规则。
     */
    function mergeWorkspaces(before, parsed) {
      const out = {};
      const old = before && typeof before === "object" ? before : {};
      for (const [name, list] of Object.entries(parsed)) {
        const prev = Array.isArray(old[name]) ? old[name] : null;
        const shown = displayTarget(prev);
        const want = list[0] ?? null;
        const same = prev !== null && shown !== null && want !== null
          && shown.channel === want.channel && shown.botId === want.botId && shown.targetId === want.targetId;
        out[name] = same ? prev : list;
      }
      return out;
    }

    function formatWorkspaces(workspaces) {
      if (!workspaces || typeof workspaces !== "object") return "";
      return Object.entries(workspaces)
        .map(([name, list]) => {
          const first = displayTarget(list);
          if (first === null) return null;
          return name + "=" + (first.channel ?? "weixin") + "|" + (first.botId ?? "") + "|" + (first.targetId ?? "");
        })
        .filter((line) => line !== null)
        .join(String.fromCharCode(10));
    }

    function NotifyCard() {
      const [value, setValue] = useState(null);
      const [error, setError] = useState(null);
      const [note, setNote] = useState(null);
      const [busy, setBusy] = useState(false);
      const [wsText, setWsText] = useState(null);
      const [picked, setPicked] = useState(null);
      // 浏览器通知权限（null = 还没问过）。放在最后，别动前面 useState 的顺序：
      // 自检按声明顺序喂种子值。
      const [permission, setPermission] = useState(null);

      useEffect(() => {
        injectCss();
      }, []);

      const refresh = useCallback(async () => {
        try {
          const described = await bridgeGet("/describe");
          if (described.ok && described.value) {
            setValue(described.value);
            setError(null);
          } else {
            setError(described.message ?? "读取配置失败");
          }
        } catch (error) {
          setError(String(error.message ?? error));
        }
      }, []);

      useEffect(() => {
        void refresh();
      }, [refresh]);

      useEffect(() => {
        if (value && wsText === null) setWsText(formatWorkspaces(value.config.workspaces));
      }, [value, wsText]);

      /** 一次改若干配置项；describe 回来的 config 才是权威值，直接替换本地 state。 */
      const patch = useCallback(async (ops) => {
        setBusy(true);
        setError(null);
        const result = await bridgePost("/mutate", { ns: NS, ops });
        setBusy(false);
        if (result.ok && result.value) {
          setValue(result.value);
          setNote(null);
        } else {
          setError(result.message ?? "保存失败");
        }
      }, []);

      const setRule = useCallback((key, next) => {
        void patch([{ op: "set", path: ["rules", key], value: next }]);
      }, [patch]);

      /** 配置面兜底：宿主给的可能是 {config} 也可能是裸 rules，缺了不能直接取 .targets。 */
      const ruleRows = useCallback(() => {
        const rules = (value && (value.config ?? value.rules)) ?? {};
        return Array.isArray(rules.targets) ? rules.targets : [];
      }, [value]);

      /** 点击兜底：回调里抛出的任何错都要变成红字 —— 静默无反应是最难查的 bug。 */
      const safely = useCallback((run) => () => {
        try {
          const result = run();
          if (result && typeof result.catch === "function") {
            result.catch((error) => setError(String(error?.message ?? error)));
          }
        } catch (error) {
          setError(String(error?.message ?? error));
        }
      }, []);

      const setTarget = useCallback((index, field, next) => {
        const list = ruleRows().map((row, i) => (i === index ? Object.assign({}, row, { [field]: next }) : row));
        void patch([{ op: "set", path: ["rules", "targets"], value: list }]);
      }, [patch, ruleRows]);

      const addTarget = useCallback((account) => {
        const list = [...ruleRows()];
        list.push({ enabled: true, channel: account.channel, botId: account.botId, targetId: "" });
        void patch([{ op: "set", path: ["rules", "targets"], value: list }]);
      }, [patch, ruleRows]);

      const removeTarget = useCallback((index) => {
        const list = ruleRows().filter((row, i) => i !== index);
        void patch([{ op: "set", path: ["rules", "targets"], value: list }]);
      }, [patch, ruleRows]);

      /** 从 dsh-im 拉该账户下已登记的收件人，省得手抄 targetId。 */
      const pickTargets = useCallback(async (index, botId) => {
        setPicked(null);
        setError(null);
        // 空 botId 原来直接 return，点下去什么都不发生 —— 新装机器上这正是「点了没反应」。
        if (String(botId).trim() === "") {
          setError("先填这一行的 botId：点上面的「+ 渠道 · …」按钮会自动填上。");
          return;
        }
        const result = await bridgePost("/targets", { botId: String(botId).trim() });
        if (result.ok && result.value) setPicked({ index, options: result.value.targets ?? [] });
        else setError(result.message ?? "读取收件目标失败");
      }, []);

      const sendTest = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const result = await bridgePost("/test", {});
          const sent = result.ok && result.value && result.value.sent === true;
          const code = result.value && result.value.code ? result.value.code : result.message;
          setNote(sent ? "测试通知已交给通道（不代表已送达）。" : "没发出去：" + (code ?? "未知原因"));
        } finally {
          // 桥超时 / 返回非 JSON / 代码抛错，任何一条路径都要放掉 busy，按钮不能永远转。
          setBusy(false);
        }
      }, []);

      /** 浏览器通知权限只能在用户手势里问，所以挂在按钮上。 */
      const askPermission = useCallback(() => {
        if (typeof Notification !== "function") {
          setError("这个浏览器不支持系统通知（或宿主不是 Web GUI）。");
          return;
        }
        try {
          const result = Notification.requestPermission((state) => setPermission(state));
          if (result && typeof result.then === "function") {
            void result.then((state) => {
              setPermission(state);
              if (state !== "granted") setError("浏览器没给通知权限：在地址栏左侧的站点设置里允许「通知」，再点一次。");
            });
          }
        } catch (error) {
          setError(String(error?.message ?? error));
        }
      }, []);

      /** 「试一下桌面提醒」：让宿主往信箱里塞一条测试提醒，不用等哪条会话结束。 */
      const testAlert = useCallback(() => {
        if (typeof Notification === "function" && Notification.permission === "default") askPermission();
        void bridgePost("/alerts/test", {}).then((result) => {
          if (result.ok) setNote("已发一条测试提醒 —— 3 秒内没弹气泡，就看权限状态和系统的「勿扰 / 通知」设置");
          else setError(result.message ?? "测试提醒没发出去");
        });
      }, [askPermission]);

      const saveWorkspaces = useCallback(() => {
        // wsText 还没从 describe 填上时，空文本会解析成 {} 并把工作区规则整块清空。
        if (wsText === null) {
          setError("还没读到配置，先点「刷新」再保存（免得把工作区规则清空）。");
          return;
        }
        const rules = (value && (value.config ?? value.rules)) ?? {};
        void patch([{ op: "set", path: ["rules", "workspaces"], value: mergeWorkspaces(rules.workspaces, parseWorkspaces(wsText)) }]);
      }, [patch, value, wsText]);

      if (value === null) {
        return jsx("div", { className: "tn-card", children: error ?? "加载中…" });
      }

      const config = value.config ?? {};
      const accounts = Array.isArray(value.accounts) ? value.accounts : [];
      const channels = Array.isArray(value.channels) ? value.channels : [];
      const targets = Array.isArray(config.targets) ? config.targets : [];
      const statuses = config.statuses ?? {};
      const fields = config.fields ?? {};
      const only = Array.isArray(config.onlyWorkspaces) ? config.onlyWorkspaces : [];
      const graceMs = typeof config.autoContinueGraceMs === "number" ? config.autoContinueGraceMs : 60000;
    const afkMs = typeof config.afkAfterMs === "number" ? config.afkAfterMs : 120000;
      const observed = Array.isArray(value.observed) ? value.observed : [];
      const sound = typeof config.sound === "string" && config.sound !== "" ? config.sound : "beep";
      const permissionNow = permission ?? (typeof Notification === "function" ? Notification.permission : "unsupported");
      const permissionText = permissionNow === "granted"
        ? "浏览器已允许通知"
        : permissionNow === "denied"
          ? "浏览器已拒绝通知（去站点设置里改）"
          : permissionNow === "unsupported"
            ? "这个环境不支持系统通知"
            : "还没允许通知";

      const check = (key, label, checked, onChange) =>
        jsx("label", { key: key, className: "tn-check", children: [
          jsx("input", { type: "checkbox", checked: checked === true, onChange }),
          jsx("span", { children: label }),
        ] });

      const online = accounts.length === 0
        ? jsx("div", {
            className: "tn-warn",
            children: value.dshImInstalled === false
              ? "没找到 dsh-im 服务，本插件发不出通知。"
              : "dsh-im 当前没有在线账户：去 设置 → 集成 配好账号，再回来加收件目标。",
          })
        : null;

      const targetRows = targets.map((row, index) => {
        const botId = row.botId ?? "";
        const options = picked !== null && picked.index === index ? picked.options : [];
        let picker = null;
        if (options.length > 0) {
          picker = jsx("select", {
            key: "pick",
            className: "tn-input",
            defaultValue: "",
            onChange: (event) => {
              if (event.target.value !== "") setTarget(index, "targetId", event.target.value);
              setPicked(null);
            },
            children: [jsx("option", { key: "none", value: "", children: "— 选一个 targetId —" })].concat(
              options.map((option) => jsx("option", {
                key: option.targetId,
                value: option.targetId,
                children: (option.name ?? option.targetId) + " · " + option.targetId,
              })),
            ),
          });
        } else if (picked !== null && picked.index === index) {
          // 空列表必须说出下一步，否则「点了没反应」：dsh-im 侧一条收件目标都没有。
          picker = jsx("div", {
            key: "pick-empty",
            className: "tn-warn",
            children: "该账户在 dsh-im 里还没有已登记的收件目标。去 设置 → 集成 → 该机器人 → 投递设置 → 「从已聊过的会话选择」新建一条，再回来点这里。",
          });
        }
        // key 用内容而不是下标：删掉中间一行后 React 不会拿旧行的内部状态（下拉选择态）去填新行。
        const rowKey = "tgt-" + row.channel + "-" + botId + "-" + (row.targetId ?? "") + "-" + index;
        return jsx("div", { key: rowKey, className: row.enabled === false ? "tn-item tn-off" : "tn-item", children: [
          jsx("div", { className: "tn-itemTop", children: [
            jsx("input", {
              type: "checkbox",
              checked: row.enabled !== false,
              title: "启用这个收件目标",
              onChange: (event) => setTarget(index, "enabled", event.target.checked),
            }),
            jsx("select", {
              className: "tn-input",
              value: row.channel ?? "weixin",
              onChange: (event) => setTarget(index, "channel", event.target.value),
              children: channels.length === 0
                ? [jsx("option", { key: "cur", value: row.channel ?? "weixin", children: row.channel ?? "weixin" })]
                : channels.map((item) => jsx("option", {
                    key: item.channel,
                    value: item.channel,
                    children: item.channel + "（" + item.accounts + "）",
                  })),
            }),
            jsx("input", {
              className: "tn-input",
              list: "tn-botids",
              placeholder: "botId",
              value: botId,
              onChange: (event) => setTarget(index, "botId", event.target.value),
            }),
            jsx("input", {
              className: "tn-input",
              placeholder: "targetId",
              value: row.targetId ?? "",
              onChange: (event) => setTarget(index, "targetId", event.target.value),
            }),
            jsx("button", {
              type: "button",
              className: "tn-btn",
              onClick: safely(() => pickTargets(index, botId)),
              children: "选收件人",
            }),
            jsx("button", {
              type: "button",
              className: "tn-btn",
              title: "删除这个收件目标",
              onClick: safely(() => removeTarget(index)),
              children: "删除",
            }),
          ] }),
          picker,
        ] });
      });

      return jsx("div", { className: "tn-card", children: [
        jsx("datalist", {
          key: "bots",
          id: "tn-botids",
          children: accounts.map((account) => jsx("option", { key: account.botId, value: account.botId })),
        }),
        jsx("div", { key: "head", className: "tn-row", children: [
          jsx("div", { className: "tn-title", children: "任务完成通知" }),
          jsx("div", { className: "tn-hint", children: "任意工作区的会话一轮结束时推一条；改动即时生效，不用重启。" }),
        ] }),
        online,
        jsx("div", { key: "on", className: "tn-row", children: check("enabled", "启用通知", config.enabled, (event) => setRule("enabled", event.target.checked)) }),
        jsx("div", { key: "statuses", className: "tn-row", children: [
          jsx("div", { className: "tn-label", children: "推送哪些状态" }),
          jsx("div", { className: "tn-checks", children: STATUS_ROWS.map(([kind, label]) =>
            check(kind, label, statuses[kind] !== false, (event) => {
              const next = Object.assign({}, statuses);
              next[kind] = event.target.checked;
              void patch([{ op: "set", path: ["rules", "statuses"], value: next }]);
            })) }),
        ] }),
        jsx("div", { key: "misc", className: "tn-row", children: [
          jsx("div", { className: "tn-checks", children: [
            check("subagents", "跳过子代理", config.skipSubagents !== false, (event) => setRule("skipSubagents", event.target.checked)),
            check("questions", "会话要你选择时也提示", config.notifyQuestions !== false, (event) => setRule("notifyQuestions", event.target.checked)),
            check("watching", "我在看这个会话时不推", config.skipWhenWatching !== false, (event) => setRule("skipWhenWatching", event.target.checked)),
            jsx("label", { key: "afk", className: "tn-check", children: [
              jsx("span", { children: "无操作" }),
              jsx("input", {
                className: "tn-input",
                type: "number",
                min: 0,
                step: 10,
                title: "秒；超过这么久没动鼠标键盘，就当作人不在、照常推",
                value: String(Math.round(afkMs / 1000)),
                onChange: (event) => setRule("afkAfterMs", Math.max(0, Number(event.target.value) || 0) * 1000),
              }),
              jsx("span", { children: "秒算离开" }),
            ] }),
            jsx("label", { key: "grace", className: "tn-check", children: [
              jsx("span", { children: "中断/失败先等" }),
              jsx("input", {
                className: "tn-input",
                type: "number",
                min: 0,
                step: 5,
                title: "秒；0 = 立即推",
                value: String(Math.round(graceMs / 1000)),
                onChange: (event) => setRule("autoContinueGraceMs", Math.max(0, Number(event.target.value) || 0) * 1000),
              }),
              jsx("span", { children: "秒再判定（被 auto-continue 续上就不推）" }),
            ] }),
            jsx("label", { key: "format", className: "tn-check", children: [
              jsx("span", { children: "格式" }),
              jsx("select", {
                className: "tn-input",
                value: config.format ?? "plain",
                onChange: (event) => setRule("format", event.target.value),
                children: ["plain", "markdown"].map((item) => jsx("option", { key: item, value: item, children: item })),
              }),
            ] }),
          ] }),
        ] }),
        jsx("div", { key: "desktop", className: "tn-row", children: [
          jsx("div", { className: "tn-label", children: "桌面上也叫一声（只在打开着这个页面时有效）" }),
          jsx("div", { className: "tn-checks", children: [
            check("desktopNotice", "系统通知（点一下跳到那条会话）", config.desktopNotice !== false, (event) => setRule("desktopNotice", event.target.checked)),
            check("titleBadge", "标签页未读标记", config.titleBadge !== false, (event) => setRule("titleBadge", event.target.checked)),
            jsx("label", { key: "sound", className: "tn-check", children: [
              jsx("span", { children: "提示音" }),
              jsx("select", {
                className: "tn-input",
                value: sound,
                onChange: (event) => setRule("sound", event.target.value),
                children: SOUND_ROWS.map((row) => jsx("option", { key: row[0], value: row[0], children: row[1] })),
              }),
            ] }),
            jsx("button", {
              type: "button",
              className: "tn-btn",
              title: "按当前设置放一声，不产生通知",
              onClick: safely(() => playSound(sound, config.soundUrl ?? "")),
              children: "试听",
            }),
            jsx("button", {
              key: "testAlert",
              type: "button",
              className: "tn-btn",
              title: "让宿主发一条测试提醒：气泡 + 提示音 + 未读标记",
              onClick: safely(() => testAlert()),
              children: "试一下桌面提醒",
            }),
            permissionNow === "granted" || sound === "none" ? null : jsx("button", {
              key: "perm",
              type: "button",
              className: "tn-btn",
              onClick: safely(() => askPermission()),
              children: "允许系统通知…",
            }),
            jsx("span", { key: "permState", className: "tn-hint", children: permissionText }),
          ] }),
          sound === "custom"
            ? jsx("input", {
                key: "soundUrl",
                className: "tn-input",
                placeholder: "音频地址，如 https://…/ding.mp3",
                value: config.soundUrl ?? "",
                onChange: (event) => setRule("soundUrl", event.target.value),
              })
            : null,
          jsx("div", { className: "tn-hint", children: "系统通知由浏览器弹 Windows 原生气泡：点气泡会回到页面并跳到那条会话；beep/chime 是现场合成的，不用额外文件。页面关着时只有 IM 通知。" }),
        ] }),
        jsx("div", { key: "fields", className: "tn-row", children: [
          jsx("div", { className: "tn-label", children: "通知里包含" }),
          jsx("div", { className: "tn-checks", children: FIELD_ROWS.map(([key, label]) =>
            check("f-" + key, label, fields[key] === undefined ? FIELD_DEFAULTS[key] : fields[key] !== false, (event) => {
              const next = Object.assign({}, fields);
              next[key] = event.target.checked;
              void patch([{ op: "set", path: ["rules", "fields"], value: next }]);
            })) }),
        ] }),
        jsx("div", { key: "wsPick", className: "tn-row", children: [
          jsx("div", { className: "tn-label", children: "通知哪些工作区" }),
          observed.length === 0
            ? jsx("div", { className: "tn-hint", children: "没读到任何工作区。不勾任何一项 = 全部工作区都通知。" })
            : jsx("div", { className: "tn-checks", children: observed.map((item) =>
                check("w-" + item.name, wsLabel(item), only.indexOf(item.name) >= 0 || only.indexOf(item.cwd) >= 0, (event) => {
                  const next = event.target.checked
                    ? only.concat([item.name]).filter((one, i, all) => all.indexOf(one) === i)
                    : only.filter((one) => one !== item.name && one !== item.cwd);
                  void patch([{ op: "set", path: ["rules", "onlyWorkspaces"], value: next }]);
                })) }),
          jsx("div", { className: "tn-hint", children: "这里列的是宿主的全部工作区（括号里是跑完的任务数）。勾中的才发；全部取消勾选=所有工作区都发。" }),
        ] }),
        jsx("div", { key: "targets", className: "tn-row", children: [
          jsx("div", { className: "tn-label", children: "收件目标（渠道 + 账户）" }),
          accounts.length === 0
            ? null
            : jsx("div", { className: "tn-itemTop", children: accounts.map((account) => jsx("button", {
                key: "add-" + account.botId,
                type: "button",
                className: "tn-btn",
                title: account.botId,
                onClick: safely(() => addTarget(account)),
                children: "+ " + account.channel + " · …" + account.botId.slice(-6),
              })) }),
          targetRows.length === 0 && accounts.length > 0
            ? jsx("div", { className: "tn-hint", children: "还没有收件目标 —— 点上面任一在线账户加一条，再点「选收件人」填 targetId。" })
            : null,
          targetRows,
          jsx("div", { className: "tn-hint", children: "每行的勾选框=是否启用这条；botId / targetId 对不上会记 skippedUnbound 并跳过，不报错。改一下即存。" }),
        ] }),
        jsx("div", { key: "ws", className: "tn-row", children: [
          jsx("div", { className: "tn-label", children: "按工作区换收件目标（可选，与上面「通知哪些工作区」无关）" }),
          jsx("textarea", {
            className: "tn-input tn-textarea",
            placeholder: "项目目录名=weixin|wx_...|tgt_...",
            value: wsText ?? "",
            onChange: (event) => setWsText(event.target.value),
          }),
          jsx("div", { className: "tn-actions", children: jsx("button", {
            type: "button",
            className: "tn-btn",
            disabled: busy,
            onClick: saveWorkspaces,
            children: "保存工作区规则",
          }) }),
          jsx("div", { className: "tn-hint", children: "一行一条：工作区目录名=channel|botId|targetId。匹配顺序：完整路径 → 目录名 → 上面的默认目标。没改动的行原样保留（同工作区的第 2 条起、停用的目标都不会因为保存而丢）；删掉整行才是删这条规则。" }),
        ] }),
        jsx("div", { key: "actions", className: "tn-actions", children: [
          jsx("button", { type: "button", className: "tn-btn tn-btnPrimary", disabled: busy, onClick: () => void refresh(), children: "刷新" }),
          jsx("button", { type: "button", className: "tn-btn", disabled: busy, onClick: () => void sendTest(), children: busy ? "发送中…" : "发测试通知" }),
          note === null ? null : jsx("span", { key: "note", className: "tn-status", children: note }),
        ] }),
        jsx("div", {
          key: "counts",
          className: "tn-status",
          children: "已推送 "
            + (value.notified ?? 0)
            + " · 未绑定跳过 " + (value.skippedUnbound ?? 0)
            + " · 状态过滤 " + (value.filtered ?? 0)
            + " · 去重 " + (value.deduped ?? 0)
            + " · 失败 " + (value.failed ?? 0),
        }),
        error === null ? null : jsx("div", { key: "error", className: "tn-status tn-err", children: error }),
      ] });
    }

    /** 插件列表页那一行的摘要文字。 */
    function summaryText(state) {
      const rules = (state && (state.rules ?? state.config?.rules ?? state)) ?? {};
      if (rules.enabled !== true) return "未启用";
      const list = Array.isArray(rules.targets) ? rules.targets : [];
      const live = list.filter((row) => row && row.enabled !== false && row.botId && row.targetId).length;
      return live + " 个收件目标";
    }

    /** 屏幕上正在显示的会话 id；宿主没提供该服务（老版本 / CLI）时返回 undefined。 */
    function mountedSessionId(ctx) {
      try {
        const value = ctx?.get?.("sidebarRight")?.mounted?.getSnapshot?.();
        return typeof value === "string" && value !== "" ? value : undefined;
      } catch {
        return undefined;
      }
    }

    /** 跳到某个会话：0.1.6 之后的宿主把主视图选择挪到了 uiWorkspace 面，老宿主还在 sessions 上。 */
    function openSession(ctx, sessionId) {
      if (typeof sessionId !== "string" || sessionId === "") return false;
      try {
        const workspace = ctx?.get?.("uiWorkspace");
        if (workspace && typeof workspace.openSession === "function") {
          workspace.openSession(sessionId);
          return true;
        }
      } catch { /* 老宿主没有这个面 */ }
      try {
        if (typeof ctx?.sessions?.open === "function") {
          ctx.sessions.open(sessionId);
          return true;
        }
      } catch { /* 没有就没有 */ }
      return false;
    }

    /**
     * 提示音：beep / chime 用 WebAudio 现场合成 —— 不打包音频文件，也就不多一个文件要同步。
     * custom 放用户给的地址（http(s) 或站内路径）。
     */
    let audioContext = null;
    function soundContext() {
      const Ctor = typeof window !== "undefined" ? (window.AudioContext ?? window.webkitAudioContext) : undefined;
      if (typeof Ctor !== "function") return null;
      if (audioContext === null) {
        try { audioContext = new Ctor(); } catch { return null; }
      }
      return audioContext;
    }

    const SOUND_PATTERNS = {
      beep: [[880, 0, 0.12], [1320, 0.14, 0.12]],
      chime: [[784, 0, 0.16], [988, 0.16, 0.16], [1175, 0.32, 0.24]],
    };
    const SOUND_ROWS = [["none", "不响"], ["beep", "短促 beep"], ["chime", "三声 chime"], ["custom", "自定义地址"]];

    function playSound(kind, url) {
      if (!kind || kind === "none") return;
      if (kind === "custom") {
        if (typeof url !== "string" || url === "") return;
        try {
          const audio = new window.Audio(url);
          void audio.play?.()?.catch?.(() => {});
        } catch { /* 放不出来就安静 */ }
        return;
      }
      const pattern = SOUND_PATTERNS[kind] ?? SOUND_PATTERNS.beep;
      const audio = soundContext();
      if (audio === null) return;
      try {
        if (audio.state === "suspended") void audio.resume?.();
        const start = audio.currentTime;
        for (const [freq, at, duration] of pattern) {
          const osc = audio.createOscillator();
          const gain = audio.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, start + at);
          gain.gain.exponentialRampToValueAtTime(0.18, start + at + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + at + duration);
          osc.connect(gain).connect(audio.destination);
          osc.start(start + at);
          osc.stop(start + at + duration + 0.02);
        }
      } catch { /* 音频被策略挡住：静默 */ }
    }

    /** 标签页标题上的未读前缀：「(3) 原标题」。 */
    const BADGE_RE = /^\(\d+\)\s*/;
    function titleBase(title) {
      return String(title ?? "").replace(BADGE_RE, "");
    }

    /** 桌面通知的轮询间隔。本机请求，3 秒足够，也不算负担。 */
    const DESKTOP_POLL_MS = 3000;

    /**
     * 已消费游标存在 localStorage：同一个 DSH 开了两个窗口/标签页时，
     * 两边都会轮询同一个信箱 —— 不共享的话一条提醒会各弹一次。
     */
    const ALERT_CURSOR_KEY = "dsh-task-notify:alertCursor";
    function readCursor() {
      try {
        const value = Number(window.localStorage?.getItem(ALERT_CURSOR_KEY));
        return Number.isFinite(value) && value > 0 ? value : 0;
      } catch {
        return 0;
      }
    }
    function writeCursor(seq) {
      try { window.localStorage?.setItem(ALERT_CURSOR_KEY, String(seq)); } catch { /* 隐私模式没有 localStorage：退回单页去重 */ }
    }

    /** 一个页面只装一次：宿主重复 apply（热重载 / 双实例）时不要起第二个轮询。 */
    let desktopStarted = false;

    /**
     * 桌面提醒三件套：系统通知（原生 Windows 气泡，点一下跳会话）、提示音、标签页未读。
     * 数据来自宿主信箱 POST /alerts；没开 Web 页面时这里根本不跑，宿主的 IM 通道照旧。
     */
    function installDesktop(ctx) {
      if (typeof window === "undefined" || typeof document === "undefined" || typeof fetch !== "function") return;
      if (desktopStarted) return;
      desktopStarted = true;
      let cursor = readCursor();
      let unread = 0;
      let base = document.title;
      let timer = null;

      const paint = () => {
        const next = unread > 0 ? "(" + unread + ") " + base : base;
        if (document.title !== next) document.title = next;
      };
      const clear = () => {
        if (unread === 0) return;
        base = titleBase(document.title);
        unread = 0;
        paint();
      };
      const notify = (alert) => {
        if (typeof Notification !== "function" || Notification.permission !== "granted") return;
        let note;
        try {
          note = new Notification(String(alert.label ?? "任务通知"), {
            body: [alert.title, alert.brief || alert.ws].filter((one) => typeof one === "string" && one !== "").join(" · "),
            tag: "dsh-task-notify:" + String(alert.sessionId ?? ""),
            silent: true, // 声音按配置自己放，别双响
          });
        } catch { return; }
        note.onclick = () => {
          try { window.focus(); } catch { /* 忽略 */ }
          openSession(ctx, alert.sessionId);
          try { note.close(); } catch { /* 忽略 */ }
        };
      };
      const consume = (alert, desktop) => {
        // 页面正显示这条会话 = 人正在看，不算未读（宿主那边一般也已经吞掉这条）。
        if (document.visibilityState === "visible" && mountedSessionId(ctx) === alert.sessionId) return;
        if (desktop.badge !== false) {
          base = titleBase(base);
          unread += 1;
          paint();
        }
        playSound(desktop.sound, desktop.soundUrl);
        if (desktop.notice !== false) notify(alert);
      };
      const poll = async () => {
        const result = await bridgePost("/alerts", { since: cursor });
        if (!result.ok || !result.value) return;
        const value = result.value;
        const desktop = value.desktop ?? {};
        for (const alert of Array.isArray(value.alerts) ? value.alerts : []) {
          if (typeof alert?.seq !== "number") continue;
          cursor = Math.max(cursor, alert.seq);
          // 另一个窗口可能刚消费过这条（游标在 localStorage 里共享）。
          if (alert.seq <= readCursor()) continue;
          writeCursor(alert.seq);
          consume(alert, desktop);
        }
        if (typeof value.since === "number") cursor = Math.max(cursor, value.since);
      };

      window.addEventListener("focus", clear);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") clear();
      });
      // 首次交互后解锁 WebAudio（浏览器策略：没有用户手势不许出声）。
      const unlock = () => {
        const audio = soundContext();
        if (audio !== null && audio.state === "suspended") void audio.resume?.();
      };
      for (const type of ["pointerdown", "keydown"]) {
        window.addEventListener(type, unlock, { passive: true, capture: true });
      }
      timer = setInterval(() => { void poll(); }, DESKTOP_POLL_MS);
      if (typeof timer?.unref === "function") timer.unref();
      void poll();
      try {
        ctx?.on?.("dispose", () => clearInterval(timer));
      } catch { /* 忽略 */ }
    }

    /** 心跳间隔：远小于宿主的 afkAfterMs（缺省 2 分钟），保证判定窗口内总有新鲜上报。 */
    const PRESENCE_EVERY_MS = 15_000;

    /**
     * 把「屏幕上是哪个会话 + 人还有没有在动」报给宿主，宿主据此决定「你正看着就不推」。
     * 读不到会话 / 没有浏览器环境时一律不报 —— 宿主那边于是照常推，绝不吞通知。
     */
    function installPresence(ctx) {
      if (typeof window === "undefined" || typeof document === "undefined") return;
      if (typeof window.addEventListener !== "function") return;

      let lastInputAt = Date.now();
      let sent = { sessionId: undefined, at: 0 };
      const markInput = () => { lastInputAt = Date.now(); };
      const send = (sessionId, visible) => { void bridgePost("/presence", { sessionId, visible, lastInputAt }); };
      const report = (force) => {
        const sessionId = mountedSessionId(ctx);
        const now = Date.now();
        if (sessionId !== sent.sessionId) {
          // 切走了：把旧会话标成「没在看」，否则它最多 afkAfterMs 内还会被误判成看着。
          if (sent.sessionId !== undefined) send(sent.sessionId, false);
          sent = { sessionId, at: 0 };
        }
        if (sessionId === undefined) return;
        if (!force && now - sent.at < PRESENCE_EVERY_MS) return;
        sent.at = now;
        send(sessionId, document.visibilityState !== "hidden");
      };

      for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
        window.addEventListener(type, markInput, { passive: true, capture: true });
      }
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") markInput();
        report(true);
      });
      // 切换会话要立刻上报，不能等下一个心跳。
      let unsubscribe;
      try {
        unsubscribe = ctx?.get?.("sidebarRight")?.mounted?.subscribe?.(() => report(true));
      } catch { /* 老宿主没有 mounted observable：靠心跳兜底 */ }
      const timer = setInterval(() => report(false), PRESENCE_EVERY_MS);
      if (typeof timer?.unref === "function") timer.unref();
      try {
        ctx?.on?.("dispose", () => {
          clearInterval(timer);
          if (typeof unsubscribe === "function") unsubscribe();
        });
      } catch { /* 忽略 */ }
      report(true);
    }

    const inject = ["slots"];

    function apply(ctx) {
      // 侧栏 插件 → 已安装 → dsh-task-notify → 行配置页。
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register(
          {
            name: "plugins.row.config",
            key: "dsh-task-notify#task-notify",
          },
          (slotProps) =>
            slotProps && slotProps.view === "summary"
              ? summaryText(slotProps.state ?? slotProps.config)
              : jsx(NotifyCard, {}),
        ),
      );
      // 「我在看这个会话就不推」的上报端；拿不到信息时静默，宿主照常推。
      installPresence(ctx);
      // 系统通知 / 提示音 / 标签页未读；宿主信箱没起来时静默退化成「只有 IM 通知」。
      installDesktop(ctx);
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.NotifyCard = NotifyCard;
    exports.summaryText = summaryText;
    exports.parseWorkspaces = parseWorkspaces;
    exports.formatWorkspaces = formatWorkspaces;
    exports.displayTarget = displayTarget;
    exports.mergeWorkspaces = mergeWorkspaces;
    exports.bridgeCall = bridgeCall;
    exports.mountedSessionId = mountedSessionId;
    exports.openSession = openSession;
    exports.installDesktop = installDesktop;
    exports.playSound = playSound;
    exports.titleBase = titleBase;

    // 必须 return：宿主 cordis 拿工厂的返回值当插件对象。只往 exports 上挂而
    // 不 return，渲染进程会拿到 undefined，直接崩在 "invalid plugin, expect
    // function or object with an apply method, received undefined"。
    return module.exports;
  },
});
