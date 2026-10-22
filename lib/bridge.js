/*
 * dsh-task-notify — 设置桥（HTTP）
 *
 * 前端设置卡片靠它读写配置。与 dsh-model-proxy / dsh-free-search 同一约定：
 * - 前缀 /api/dsh-task-notify-settings
 * - 只接受回环来源；GET 读、POST 写
 * - 一律 {ok:true,value} / {ok:false,code,message}
 *
 * 配置改动经 settings.mutate 落盘，插件的 config 对象随之就地更新，
 * 所以卡片改完开关不用重启 DSH。
 */

const BRIDGE_PREFIX = "/api/dsh-task-notify-settings";
const MAX_JSON_BODY_BYTES = 256 * 1024;
/** body 超限的哨兵：与「JSON 畸形」分开，免得排查时被同一句文案带偏。 */
const BODY_TOO_LARGE = Symbol("body-too-large");

function writeJson(res, status, body) {
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  } catch {
    // 客户端已经断开：没有接收端，也没什么可回的。
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) return BODY_TOO_LARGE;
      chunks.push(chunk);
    }
  } catch {
    return undefined; // body 传到一半断开：按畸形 body 处理，别把异常漏给宿主
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** 回环 authority：localhost / [::1] / 127.x.x.x（带端口算，带 path/query/userinfo 不算）。 */
function isLocalAuthority(authority) {
  if (typeof authority !== "string" || authority === "") return false;
  try {
    const url = new URL("http://" + authority);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
    const hostname = url.hostname.replace(/\.$/, "");
    return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
  } catch { return false; }
}

/**
 * 桥能改配置、能实发测试消息，只认本机来源。
 *
 * 只看 remoteAddress 不够：本机反代/快速隧道（cloudflared）转发进来时它恒为 127.0.0.1，
 * 公网请求会被当成回环。所以按 dsh-im 的口径看请求头：
 * - Host 必须是回环 authority → 掐掉隧道域名与 DNS rebinding；
 * - Origin 存在且是 http(s) 时必须也回环 → 掐掉任意网页发起的跨站写。
 */
export function isLoopbackRequest(req) {
  const headers = req?.headers ?? {};
  if (!isLocalAuthority(headers.host)) return false;
  const origin = headers.origin;
  if (typeof origin !== "string" || origin === "" || origin === "null") return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return true;
    return isLocalAuthority(url.host);
  } catch { return false; }
}

/**
 * 建桥的路由表。
 *
 * @param {object} deps
 * @param {string} deps.ns 本插件命名空间
 * @param {() => Record<string, unknown>} deps.getConfig 当前配置（普通值）
 * @param {(ns: string, ops: object[]) => Promise<void>} deps.mutate 写配置
 * @param {() => Promise<{accounts: object[], channels: object[]}>} deps.listAccounts dsh-im 在线账户
 * @param {(botId: string) => Promise<{targetId: string, name?: string}[]>} deps.listTargets 该账户下可选收件目标
 * @param {(text: string) => Promise<object>} deps.sendTest 实发一条测试通知
 * @param {(body: object) => object} deps.reportPresence 记一次「我在看哪个会话」上报
 * @param {() => object} deps.stats 当前计数
 * @returns {{kind: string, path: string, handler: Function}[]}
 */
export function makeBridgeRoutes(deps) {
  const { ns, getConfig, mutate, listAccounts, listTargets, sendTest, reportPresence, stats } = deps;

  const guard = (req, res, method) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, code: "forbidden", message: "loopback requests only" });
      return false;
    }
    if (req.method !== method) {
      writeJson(res, 405, { ok: false, code: "method-not-allowed", message: "method not allowed: " + (req.method ?? "") });
      return false;
    }
    return true;
  };

  const handlers = {
    /** 读当前配置 + dsh-im 在线账户 + 计数，前端用它渲染整张卡片。 */
    async describe() {
      try {
        const online = await listAccounts();
        return { ok: true, value: Object.assign({ ns, config: getConfig() }, online, stats()) };
      } catch (error) {
        return { ok: false, code: "describe-failed", message: messageOf(error) };
      }
    },

    /** 写配置。只允许改本插件自己的命名空间。 */
    async mutate(body) {
      if (body === null || typeof body !== "object" || !Array.isArray(body.ops)) {
        return { ok: false, code: "settings-rejected", message: "malformed bridge settings request" };
      }
      if (String(body.ns ?? ns) !== ns) {
        return { ok: false, code: "settings-not-exposed", message: "settings namespace is not exposed" };
      }
      for (const op of body.ops) {
        if (op === null || typeof op !== "object" || typeof op.path?.[0] !== "string") {
          return { ok: false, code: "settings-rejected", message: "malformed settings op" };
        }
      }
      try {
        await mutate(ns, body.ops);
      } catch (error) {
        return { ok: false, code: "settings-write-failed", message: messageOf(error) };
      }
      return handlers.describe();
    },

    /** 某账户下 dsh-im 已登记的收件目标，前端拿它填 targetId。 */
    async targets(body) {
      const botId = typeof body?.botId === "string" ? body.botId.trim() : "";
      if (botId === "") return { ok: false, code: "bot-id-required", message: "botId is required" };
      try {
        return { ok: true, value: { botId, targets: await listTargets(botId) } };
      } catch (error) {
        return { ok: false, code: "targets-failed", message: messageOf(error) };
      }
    },

    /** 前端上报「我正看着这个会话」；宿主据此决定要不要推。 */
    async presence(body) {
      try {
        return reportPresence(body ?? {});
      } catch (error) {
        return { ok: false, code: "presence-failed", message: messageOf(error) };
      }
    },

    /** 实发一条测试通知：只证明平台接口收下了，不代表已送达。 */
    async test() {
      try {
        return { ok: true, value: await sendTest() };
      } catch (error) {
        return { ok: false, code: "test-failed", message: messageOf(error) };
      }
    },
  };

  const post = (path, handler) => ({
    kind: "exact",
    path: BRIDGE_PREFIX + path,
    handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      try {
      // 只看 body 能不能 JSON.parse 是不够的：浏览器把 text/plain 当 CORS 安全列类型，
      // 跨站页面无需预检就能 POST 进来（CSRF）。所以要显式的 application/json。
      const contentType = String(req.headers?.["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        writeJson(res, 415, { ok: false, code: "unsupported-media-type", message: "content-type must be application/json" });
        return;
      }
      const body = await readJsonBody(req);
      if (body === BODY_TOO_LARGE) {
        writeJson(res, 413, { ok: false, code: "body-too-large", message: "JSON body must be at most " + MAX_JSON_BODY_BYTES + " bytes" });
        return;
      }
      if (body === undefined) {
        writeJson(res, 400, { ok: false, code: "settings-rejected", message: "malformed JSON body" });
        return;
      }
      writeJson(res, 200, await handler(body));
      } catch (error) {
        // 路由里任何抛出都不许变成未处理拒绝：回包 + 让宿主日志留痕。
        writeJson(res, 500, { ok: false, code: "bridge-threw", message: messageOf(error) });
      }
    },
  });

  return [
    { kind: "exact", path: BRIDGE_PREFIX + "/describe", handler: async (req, res) => {
      if (!guard(req, res, "GET")) return;
      writeJson(res, 200, await handlers.describe());
    } },
    post("/mutate", handlers.mutate),
    post("/targets", handlers.targets),
    post("/test", handlers.test),
    post("/presence", handlers.presence),
  ];
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export { BRIDGE_PREFIX };