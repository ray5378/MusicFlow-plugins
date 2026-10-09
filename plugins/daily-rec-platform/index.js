/**
 * MusicFlow 外置插件：daily-rec-platform —— QQ 音乐 / 网易云音乐 每日推荐。
 *
 * §0 契约与沙箱限制
 * - 沙箱契约:globalThis.__mfPlugin = { manifest, create(host) };单文件 ES,无
 *   import/require/fetch/process/eval、无定时器、无 TextDecoder/atob/btoa 依赖。
 * - 加密铁律(Q10-B/§10.2):协议加密全部经 host.crypto 十原语编排(§4b),跨桥二进制
 *   一律 hex/base64 字符串(jsToHandle 不认 TypedArray;U+0000 跨桥截断);
 *   host.crypto 失败返回 { error } 而非抛出。
 * - 路由(R4):全斜杠式,禁下划线猜测;selfCheck() 探测关键路由,404 报进 health()。
 * - 凭据(R3/R11):只存 host.storage;日志只打指纹(前6位+长度);解绑即删;
 *   无密码登录、不留扩展点。
 * - QrPayload 契约(§14.2):startBind → {kind,value,ttlSec,pollIntervalMs,sessionKey};
 *   pollBind → { code: 800|801|802|803, state, account?, message? }
 *   (code: 800=confirmed/801=waiting/802=expired/803=scanned —— 与核心 v4.3.0
 *   扫码弹窗的 801 待扫/802 过期/800 成功约定对齐;state 为设计文档 §14.2 文本态)。
 * - 选源(§11):host.songs.match(核心统一匹配器,四维评分在核心维护)未命中才走
 *   host.sources.complete(透传 album+duration 秒,gate-check 硬卡);禁自拼在线 URL。
 *
 * 段结构:§1 PLATFORM_DEFS / §2 ROUTES / §3 Utils / §4 UpstreamClient /
 *        §4b CryptoOrchestrator / §5 CredentialStore / §5b SessionGuard /
 *        §6 QrLoginService / §7 Normalizer / §8 MatchPipeline / §9 SelectionPolicy /
 *        §10 PlaylistWriter / §10b HistoryRoller / §11 Diagnostics / §12 DailySnapshot /
 *        §13 manifest / §14 create(host)
 */

// ============================== §1 PLATFORM_DEFS ==============================
// 两平台静态定义。⚠️ 网易云/QQ 的部分协议端点与轮询码值需真机联调做最终校准
// (设计 §14.2「精确码值 T02 以实测钉死」);selfCheck() 会把 404 报进 health()。

var PLATFORMS = {
  netease: {
    label: "网易云音乐",
    slug: "netease",
    extPrefix: "wy", // externalSongId 前缀(wy:123456)
    routes: {
      qrKey: "/login/qrcode/unikey", // weapi POST {type:1} → unikey
      qrCheck: "/login/qrcode/client/login", // weapi POST {key,type:1} → 800/801/802/803
      daily: "/recommend/songs", // weapi POST → data.dailySongs[](主接口,日推单曲)
      authProbe: "/api/w/nuser/account/get", // 运行时有效性检测:account != null 才算已登录
      refresh: null, // ⚠️ 无刷新通道:token/refresh 无法复活过期会话,不做
      history: null // P1 R12(网易云有,QQ 侧无;首发不接)
    },
    apiBase: "https://music.163.com",
    playlistPrefix: "pl-daily-rec-netease-",
    historyId: "pl-daily-rec-netease-history",
    qrUrlTpl: "https://music.163.com/login?codekey={key}", // 只拿 unikey,url 由核心归一化成二维码
    qrTtlSec: 302, // 实测 ≈5 分钟
    pollIntervalMs: 2500,
    credTtlSec: null, // 查不到权威值 → 禁止预设 TTL,只做运行时检测
    homeUrl: "https://music.163.com/#/discover"
  },
  qq: {
    label: "QQ 音乐",
    slug: "qq",
    extPrefix: "qq",
    routes: {
      qrKey: "/login/qr/key", // musicu.fcg 模块:取二维码
      qrCheck: "/login/qr/check", // musicu.fcg 模块:轮询
      daily: "/recommend/songs", // musicu.fcg:每日30首卡片 → tid → playlist_detail
      authProbe: "/user/playlist", // 无凭据返回 "Auth info missing"
      refresh: "/login/refresh", // 真刷新:refresh_key/musickey 换新
      history: null
    },
    apiBase: "https://u.y.qq.com",
    playlistPrefix: "pl-daily-rec-qq-",
    historyId: "pl-daily-rec-qq-history",
    qrUrlTpl: null, // QQ 直出 PNG dataURL → kind:'image'
    qrTtlSec: 120, // 代码实证;会话硬过期 130s / 空闲 15s
    pollIntervalMs: 8000, // ⚠️ 必须 < 15s,否则会话被平台销毁
    credTtlSec: 259200, // 3 天(代码实证)
    refreshAheadSec: 43200, // 到期前 ~12h 静默刷新
    homeUrl: "https://y.qq.com/"
  }
};

var PLATFORM_ORDER = ["netease", "qq"];

// ============================== §2 ROUTES(常量) ==============================
// QQ musicu.fcg 模块/方法。⚠️ 模块名与码值需真机联调校准;保持集中定义便于一处改。

var QQ_FCG_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";
var QQ_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MusicFlow-Plugin/1.0";
var QQ_QR_KEY_MODULE = { module: "music.Login.QrCodeLoginCgiService", method: "QrGetLoginQrCode" };
var QQ_QR_CHECK_MODULE = { module: "music.Login.QrCodeLoginCgiService", method: "QrCheckLoginQrCode" };
var QQ_DAILY_MODULE = { module: "music.scheduledDailysong.PlayInfoService", method: "get_scheduled_dailysong" };
var QQ_PLAYLIST_DETAIL_MODULE = { module: "music.musichallSong.PlaylistInfoServer", method: "GetPlaylistInfo" };
var QQ_SEARCH_MODULE = { module: "music.search.SearchCgiService", method: "DoSearchForQQMusicDesktop" };
var NET_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MusicFlow-Plugin/1.0";

// 网易云轮询码值(实测主流值):800=过期 801=等待扫码 802=已扫码待确认 803=已确认。
// QQ 轮询码值:设计文档口径 801 waiting / 802 expired / 803 scanned,成功按 0 处理
// (⚠️ 待真机钉死后在 QR_STATE_MAP 单点修改)。
var NET_QR_STATE = { 800: "expired", 801: "waiting", 802: "scanned", 803: "confirmed" };
var QQ_QR_STATE = { 0: "confirmed", 801: "waiting", 802: "expired", 803: "scanned" };

// 网易云 qrCheck 候选路由(R4 校准点):平台历史上有多个形态,启动后逐个探测,
// 命中(返回 800/801/802/803)即缓存到 storage「routeok:netease:qrCheck」,
// 后续直接复用 —— 不靠猜,靠实测钉死。
var NET_QR_CHECK_CANDIDATES = ["/login/qrcode/client/login", "/login/qrcode/client_login", "/login/qr/check"];

// ================================ §3 Utils ================================

function utils_fp(value) {
  // 凭据指纹:前6位 + 长度(绝打全文)。
  var s = String(value == null ? "" : value);
  if (!s) return "(空)";
  return s.slice(0, 6) + "#" + s.length;
}

function utils_today() {
  var d = new Date();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + (m < 10 ? "0" + m : "" + m) + (day < 10 ? "0" + day : "" + day);
}

function utils_dateOffset(days) {
  // YYYYMMDD,支持负偏移(历史回溯)。
  var d = new Date(Date.now() + days * 86400000);
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + (m < 10 ? "0" + m : "" + m) + (day < 10 ? "0" + day : "" + day);
}

function utils_randToken(len) {
  // 会话句柄:base62 随机串(纯 JS Math.random,沙箱允许)。
  var chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  var out = "";
  for (var i = 0; i < (len || 24); i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function utils_norm(s) {
  // 归一化:全角→半角空白、异体破折号→空格、去首尾空白、小写(匹配候选用)。
  return String(s == null ? "" : s)
    .replace(/[‐-―－—–]/g, " ")
    .replace(/[\u3000\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

var SUFFIX_RE = /[\(（【\[](live|dj|remaster(ed)?|explicit|clean|demo|inst(rumental)?|acoustic|cover|version|ver\.?|混音|伴奏|现场|录音室版?)[\)\]】\]]*[\)）】\]]?\s*$/i;

function utils_stripSuffix(title) {
  // 后缀剥离:(Live)/(DJ版)/(Remastered) 等修饰,最多剥两层(嵌套括号)。
  var s = utils_norm(title);
  for (var i = 0; i < 2; i++) {
    var t = s.replace(SUFFIX_RE, "").trim();
    if (t === s) break;
    s = t;
  }
  return s || utils_norm(title);
}

function utils_splitArtists(artist) {
  // 多歌手拆解:/ 、; 、feat./ft./& 、、。
  var a = String(artist == null ? "" : artist);
  var parts = a.split(/\s*(?:\/|;|、|,|&|feat\.|ft\.|Feat\.|Ft\.|with)\s*/i);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = utils_norm(parts[i]);
    if (p) out.push(p);
  }
  return out.length ? out : [utils_norm(a)];
}

function utils_titleCase(s) {
  return String(s || "").replace(/(^|\s)([a-z])/g, function (_, w, c) { return w + c.toUpperCase(); });
}

// ========================= §4b CryptoOrchestrator ==========================
// host.crypto 十原语编排(Q10-B,§10.6 订正版):base64/UTF-8 全走宿主原语,
// 插件不依赖沙箱 atob、不手写 UTF-8 解码器。weapi 固定密钥/公钥与 QQ 双密钥
// 与上游参考件逐字节一致(KAT 对拍:tests/crypto-kat.mjs)。

function CryptoOrchestrator(host) {
  var WY_PRESET_KEY = "0CoJUm6Qyw8W8jud";
  var WY_IV = "0102030405060708";
  var WY_PUBLIC_KEY =
    "-----BEGIN PUBLIC KEY-----\n" +
    "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n" +
    "-----END PUBLIC KEY-----";
  var BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  // QQ ag-1 请求密钥(16B,hex)与响应 XOR 密钥(21B,latin1 逐字节内嵌,跨桥无碍)。
  var QQ_REQUEST_KEY_HEX = "bd305f10d0ff74b6ef54dab835b5e1cf";
  var QQ_RESPONSE_KEY = String.fromCharCode(
    0x7a, 0x3f, 0x8c, 0x1d, 0x5e, 0x9b, 0x2f, 0x0a, 0x6c, 0x4d,
    0x7e, 0x8b, 0x1f, 0x3a, 0x5c, 0x9d, 0x0e, 0x2b, 0x6f, 0x4a, 0x81
  );

  // host.crypto 十原语为**同步**函数(主仓 pluginCrypto.ts:hostSync 语义),
  // 返回 string 或 { error }——统一在 prim() 转 { error } 为抛出,由上层分级。
  function prim(result, label) {
    if (result && typeof result === "object" && typeof result.error === "string") {
      throw new Error(label + ": " + result.error);
    }
    return result;
  }

  function randSecretKey(fixed) {
    if (fixed) return String(fixed); // KAT 注入固定向量
    var out = "";
    for (var i = 0; i < 16; i++) out += BASE62.charAt(Math.floor(Math.random() * 62));
    return out;
  }

  /** 网易云 weapi(obj, fixedKey?):双层 AES-CBC + RSA(倒序密钥)。 */
  this.weapi = function (obj, fixedKey) {
    var text = JSON.stringify(obj == null ? {} : obj);
    var secretKey = randSecretKey(fixedKey);
    var l1 = prim(host.crypto.aesEncrypt({ mode: "cbc", data: text, key: WY_PRESET_KEY, iv: WY_IV, outputEncoding: "base64" }), "weapi L1");
    var params = prim(host.crypto.aesEncrypt({ mode: "cbc", data: l1, key: secretKey, iv: WY_IV, outputEncoding: "base64" }), "weapi L2");
    var reversed = secretKey.split("").reverse().join("");
    var encSecKey = prim(host.crypto.rsaEncrypt({ data: reversed, publicKey: WY_PUBLIC_KEY, padding: "none", outputEncoding: "hex" }), "weapi rsa");
    return { params: params, encSecKey: encSecKey };
  };

  /** QQ ag-1 请求加密:AES-128-GCM(key hex)→ base64(IV‖CT‖TAG),IV 宿主随机。 */
  this.ag1Encrypt = function (obj, fixedIv) {
    var opts = {
      mode: "gcm",
      data: typeof obj === "string" ? obj : JSON.stringify(obj == null ? {} : obj),
      key: QQ_REQUEST_KEY_HEX,
      keyEncoding: "hex",
      outputEncoding: "base64"
    };
    if (fixedIv) { opts.iv = fixedIv; } // KAT 固定向量(12 字节 utf8)
    return prim(host.crypto.aesEncrypt(opts), "ag1 enc");
  };

  /** 循环 XOR(latin1 字符串域,纯 JS)。 */
  function xorCycle(s, key) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      out += String.fromCharCode(s.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  }

  /** QQ ag-1 响应解密:base64Decode(latin1) → XOR → utf8Decode(宿主原语,禁手写)。 */
  this.ag1DecryptResponse = function (b64Body) {
    var raw = prim(host.crypto.base64Decode(b64Body), "ag1 b64");
    var xored = xorCycle(raw, QQ_RESPONSE_KEY);
    return prim(host.crypto.utf8Decode(xored), "ag1 utf8");
  };

  /** QQ zzcSign:sha1 大写 → 索引抽取 ×2 + hash 字节⊕混淆值(latin1→base64 去 /+=)。 */
  this.zzcSign = function (payload) {
    var sha1hex = prim(host.crypto.sha1(payload), "zzc sha1");
    var hash = String(sha1hex).toUpperCase();
    var part1Idx = [23, 14, 6, 36, 16, 40, 7, 19];
    var part1 = "";
    for (var i = 0; i < part1Idx.length; i++) {
      if (part1Idx[i] < 40) part1 += hash.charAt(part1Idx[i]);
    }
    var part2Idx = [16, 1, 32, 12, 19, 27, 8, 5];
    var part2 = "";
    for (var j = 0; j < part2Idx.length; j++) part2 += hash.charAt(part2Idx[j]);
    var scramble = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];
    var part3 = "";
    for (var k = 0; k < scramble.length; k++) {
      var hashValue = parseInt(hash.substr(k * 2, 2), 16);
      part3 += String.fromCharCode(scramble[k] ^ (isNaN(hashValue) ? 0 : hashValue));
    }
    var b64 = prim(host.crypto.base64Encode(part3, { inputEncoding: "latin1" }), "zzc b64");
    var b64Part = String(b64).replace(/[\/+=]/g, "");
    return ("zzc" + part1 + b64Part + part2).toLowerCase();
  };
}

// ============================ §4 UpstreamClient ============================

function UpstreamClient(host, crypto) {
  var errOf = function (code, message) { return { __err: true, code: code, message: message || "" }; };

  function classifyNetease(status, body) {
    if (status === 0) return errOf("NETWORK", "网络不可达");
    if (status >= 500) return errOf("UPSTREAM_5XX", "网易云服务异常(" + status + ")");
    if (status === 404) return errOf("ROUTE_NOT_FOUND", "网易云路由 404");
    var code = body && body.code;
    if (code === 301 || code === 302 || code === 512) return errOf("AUTH_EXPIRED", "网易云凭据失效(code " + code + ")");
    // 800/801/802/803 = qrCheck 轮询码值,不是业务错误,放行给 pollBind 解读。
    if (NET_QR_STATE[code]) return null;
    if (code !== 200 && code !== undefined && code !== 0) {
      // 鉴权探针二次定性:业务 4xx + 空 body → AUTH_UNKNOWN(§7 ④)。
      if (status >= 400 && !body) return errOf("AUTH_UNKNOWN", "网易云响应异常(" + status + "+空)");
      return errOf("UPSTREAM_ERROR", "网易云业务错误(code " + code + ")");
    }
    return null;
  }

  function classifyQQ(status, body) {
    if (status === 0) return errOf("NETWORK", "网络不可达");
    if (status >= 500) return errOf("UPSTREAM_5XX", "QQ 音乐服务异常(" + status + ")");
    if (status === 404) return errOf("ROUTE_NOT_FOUND", "QQ 路由 404");
    var text = typeof body === "string" ? body : "";
    if (text.indexOf("Auth info missing") !== -1) return errOf("AUTH_EXPIRED", "QQ 凭据失效");
    if (body && typeof body === "object" && body.code !== undefined && body.code !== 0 && !isQQDataOk(body)) {
      return errOf("UPSTREAM_ERROR", "QQ 业务错误(code " + body.code + ")");
    }
    return null;
  }

  function isQQDataOk(body) {
    return !!(body && body.data && !body.data.err);
  }

  /** 从 host.http 响应头采集 set-cookie(逗号合并不拆分,按整串回带)。 */
  function collectCookies(res) {
    var h = (res && res.headers) || {};
    return h["set-cookie"] || h["Set-Cookie"] || "";
  }

  /** 网易云 weapi POST。返回 {json, setCookie} 或抛 {__err}。 */
  this.neteasePost = function (route, data, cookie) {
    var payload;
    try {
      payload = crypto.weapi(data); // 同步(§4b)
    } catch (e) {
      return Promise.reject(errOf("NETWORK", "网易云加密失败: " + ((e && e.message) || e)));
    }
    var def = PLATFORMS.netease;
    var url = def.apiBase + "/weapi" + route;
    var body = "params=" + encodeURIComponent(payload.params) + "&encSecKey=" + payload.encSecKey;
    return host.http(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": NET_UA,
        Referer: "https://music.163.com",
        Cookie: cookie || ""
      },
      body: body,
      timeout: 15000
    }).then(function (res) {
      var json = null;
      try { json = JSON.parse(res.body); } catch (e) { json = null; }
      var err = classifyNetease(res.status, json);
      if (err) throw err;
      return { json: json, setCookie: collectCookies(res), status: res.status };
    }, function (e) {
      if (e && e.__err) throw e;
      throw errOf("NETWORK", "网易云请求失败: " + ((e && e.message) || e));
    });
  };

  /** QQ musicu.fcg(ag-1 加密请求体 + zzcSign 查询签名)。 */
  this.qqPost = function (reqBody, cookie) {
    var bodyText = JSON.stringify(reqBody);
    var encBody, sign;
    try {
      encBody = crypto.ag1Encrypt(reqBody); // 同步(§4b)
      sign = crypto.zzcSign(bodyText);
    } catch (e) {
      return Promise.reject(errOf("NETWORK", "QQ 加密失败: " + ((e && e.message) || e)));
    }
    var url = QQ_FCG_URL + "?sign=" + encodeURIComponent(sign);
    return host.http(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "User-Agent": QQ_UA,
        Referer: "https://y.qq.com/",
        Cookie: cookie || ""
      },
      body: encBody,
      timeout: 15000
    }).then(function (res) {
      if (!res.ok || !res.body) {
        var err = classifyQQ(res.status, res.body);
        if (err) throw err;
      }
      var text;
      try {
        text = crypto.ag1DecryptResponse(res.body); // 同步(§4b)
      } catch (e) {
        // 非 base64 响应:透出原始 body 片段便于路由/协议校准(真机联调钉死)。
        throw errOf("UPSTREAM_ERROR", "QQ 响应非 ag-1 base64: " + String(res.body || "").slice(0, 200));
      }
      var json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      var err2 = classifyQQ(res.status, json || res.body);
      if (err2) throw err2;
      return { json: json, setCookie: collectCookies(res), status: res.status, raw: text };
    }, function (e) {
      if (e && e.__err) throw e;
      throw errOf("NETWORK", "QQ 请求失败: " + ((e && e.message) || e));
    });
  };

  /** QQ 请求包装:自动带 Comm 头与模块键(req_0)。 */
  this.qqMusicu = function (moduleDef, param, cookie, uin) {
    var body = {};
    body.Comm = { ct: 19, cv: 1873, uin: Number(uin) || 0, format: "json", ctid: 205 };
    body.req_0 = { module: moduleDef.module, method: moduleDef.method, param: param == null ? {} : param };
    return this.qqPost(body, cookie);
  };

  /** 启动路由自检:逐个 GET 探测(HEAD 语义不保证),404 记录。 */
  this.selfCheck = function () {
    var results = [];
    var probe = function (url) {
      return host.http(url, { method: "GET", timeout: 8000 }).then(function (res) {
        return { url: url, status: res.status, ok: res.status !== 404 };
      }, function (e) {
        return { url: url, status: 0, ok: false, error: (e && e.message) || String(e) };
      });
    };
    var jobs = [
      probe(PLATFORMS.netease.apiBase + "/weapi" + PLATFORMS.netease.routes.qrKey),
      probe(PLATFORMS.qq.apiBase + QQ_FCG_URL.replace(PLATFORMS.qq.apiBase, ""))
    ];
    return Promise.all(jobs).then(function (rs) {
      for (var i = 0; i < rs.length; i++) {
        var r = rs[i];
        results.push((r.ok ? "ok" : "FAIL") + " " + r.url + (r.status ? " (" + r.status + ")" : " " + (r.error || "")));
      }
      return results;
    });
  };
}

// ============================ §5 CredentialStore ============================

function CredentialStore(host) {
  var KEY = function (plat) { return "cred:" + plat; };

  this.get = function (platform) {
    return host.storage.get(KEY(platform)).then(function (v) { return v || null; });
  };

  this.save = function (platform, cred) {
    cred.savedAt = Date.now();
    return host.storage.set(KEY(platform), cred);
  };

  this.clear = function (platform) {
    return host.storage.delete(KEY(platform));
  };

  this.fingerprint = function (cred) {
    return utils_fp(cred && (cred.cookie || cred.musickey || ""));
  };

  this.listBound = function () {
    var out = [];
    var jobs = [];
    for (var i = 0; i < PLATFORM_ORDER.length; i++) {
      (function (plat) {
        jobs.push(host.storage.get(KEY(plat)).then(function (v) { if (v) out.push(plat); }));
      })(PLATFORM_ORDER[i]);
    }
    return Promise.all(jobs).then(function () { return out; });
  };
}

// ============================= §5b SessionGuard =============================

function SessionGuard(host, upstream, store) {
  /** 网易云运行时检测:account != null 才算已登录(禁预设 TTL)。 */
  function probeNetease(cred) {
    return upstream.neteasePost(PLATFORMS.netease.routes.authProbe, { csrf_token: "" }, cred.cookie).then(function (r) {
      var account = r.json && ((r.json.account) || (r.json.data && r.json.data.account));
      return { ok: !!(r.json && account != null), account: account || null };
    });
  }

  /** QQ 探针:authProbe 无凭据返回 "Auth info missing"。 */
  function probeQQ(cred) {
    return upstream.qqMusicu(
      { module: "music.UserInfo.UserInfoService", method: "GetUserBaseInfo" },
      {}, cred.cookie, cred.uin
    ).then(function (r) {
      var data = r.json && r.json.req_0 && r.json.req_0.data;
      return { ok: !!(data && !data.err), account: data || null };
    });
  }

  /** QQ 到期前 12h 静默刷新。 */
  function refreshQQ(cred) {
    return upstream.qqMusicu(
      { module: "music.Login.LoginCgiService", method: "LoginRefresh" },
      { refresh_key: cred.refreshKey || "" }, cred.cookie, cred.uin
    ).then(function (r) {
      var data = r.json && r.json.req_0 && r.json.req_0.data;
      if (data && data.musickey && data.refresh_key) {
        cred.cookie = mergeCookie(cred.cookie, r.setCookie);
        cred.musickey = data.musickey;
        cred.refreshKey = data.refresh_key;
        cred.expiresAt = Date.now() + PLATFORMS.qq.credTtlSec * 1000;
        return store.save("qq", cred).then(function () { return { ok: true, refreshed: true, cred: cred }; });
      }
      return { ok: false, refreshed: false, message: "QQ 刷新无有效 musickey 返回" };
    });
  }

  function mergeCookie(oldCookie, setCookie) {
    if (!setCookie) return oldCookie || "";
    // 简单合并:新 set-cookie 键覆盖旧值(解析 name=value 对)。
    var jar = {};
    var parts = String(oldCookie || "").split(/;\s*/);
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (kv[0]) jar[kv[0].trim()] = kv.slice(1).join("=");
    }
    var sc = String(setCookie).match(/[^\s=;,]+=[^;]*/g) || [];
    for (var j = 0; j < sc.length; j++) {
      var kv2 = sc[j].split("=");
      if (kv2[0]) jar[kv2[0].trim()] = kv2.slice(1).join("=");
    }
    var out = [];
    for (var k in jar) if (Object.prototype.hasOwnProperty.call(jar, k)) out.push(k + "=" + jar[k]);
    return out.join("; ");
  }

  this.probe = function (platform, cred) {
    if (!cred) return Promise.resolve({ ok: false, reason: "UNBOUND" });
    return platform === "netease" ? probeNetease(cred) : probeQQ(cred);
  };

  this.ensureValid = function (platform, cred) {
    var self = this;
    if (!cred) return Promise.resolve({ ok: false, code: "AUTH_UNBOUND", message: "未绑定" });
    if (platform === "qq") {
      var exp = Number(cred.expiresAt || 0);
      var ahead = PLATFORMS.qq.refreshAheadSec * 1000;
      var doRefresh = exp > 0 && exp - Date.now() < ahead;
      var attempt = doRefresh ? refreshQQ(cred).then(function (r) { return { cred: r.cred || cred, refreshed: r.refreshed }; })
        : Promise.resolve({ cred: cred, refreshed: false });
      return attempt.then(function (r) {
        return probeQQ(r.cred).then(function (p) {
          if (p.ok) return { ok: true, cred: r.cred, refreshed: r.refreshed };
          // 刷新失败不立即判死:返回 AUTH_EXPIRED 交上层诊断。
          return { ok: false, code: "AUTH_EXPIRED", message: "QQ 凭据已失效(探针+刷新均未恢复)" };
        });
      });
    }
    return probeNetease(cred).then(function (p) {
      if (p.ok) return { ok: true, cred: cred };
      return { ok: false, code: "AUTH_EXPIRED", message: "网易云凭据已失效(运行时检测 account=null)" };
    }, function (e) {
      return { ok: false, code: (e && e.code) || "AUTH_UNKNOWN", message: (e && e.message) || "鉴权未知" };
    });
  };
}

// ============================= §6 QrLoginService =============================

function QrLoginService(host, upstream, store) {
  var SKEY = function (k) { return "qrs:" + k; };

  function gcSessions() {
    return host.storage.keys().then(function (keys) {
      var jobs = [];
      for (var i = 0; i < keys.length; i++) {
        if (String(keys[i]).indexOf("qrs:") !== 0) continue;
        (function (k) {
          host.storage.get(k).then(function (v) {
            if (v && v.createdAt && Date.now() - v.createdAt > 3600000) return host.storage.delete(k);
          });
        })(keys[i]);
      }
      return Promise.all(jobs);
    });
  }

  /** startBind(params):platform = params.platform || config.bindPlatform || netease。 */
  this.startBind = function (params) {
    var cfg = (host.config || {});
    var platform = (params && params.platform) || cfg.bindPlatform || "netease";
    if (!PLATFORMS[platform]) platform = "netease";
    var def = PLATFORMS[platform];
    var self = this;
    return gcSessions().then(function () {
      if (platform === "netease") {
        return upstream.neteasePost(def.routes.qrKey, { type: 1 }, "").then(function (r) {
          var data = (r.json && (r.json.data || r.json)) || {};
          var unikey = data.unikey || data.codekey || "";
          if (!unikey) throw { __err: true, code: "UPSTREAM_ERROR", message: "网易云未返回 unikey" };
          var sessionKey = utils_randToken(24);
          return host.storage.set(SKEY(sessionKey), {
            platform: platform, key: unikey, createdAt: Date.now(),
            expiresAt: Date.now() + def.qrTtlSec * 1000
          }).then(function () {
            return {
              kind: "url", // 由核心归一化成二维码 data URL(§14.1b)
              value: def.qrUrlTpl.replace("{key}", encodeURIComponent(unikey)),
              ttlSec: def.qrTtlSec,
              pollIntervalMs: def.pollIntervalMs,
              sessionKey: sessionKey
            };
          });
        });
      }
      // QQ:直出 PNG dataURL → kind:'image' 透传。
      return upstream.qqMusicu(QQ_QR_KEY_MODULE, {}, "").then(function (r) {
        var data = (r.json && r.json.req_0 && r.json.req_0.data) || {};
        var qrimage = data.qrimage || data.qrUrl || data.qrcode || "";
        if (!qrimage) throw { __err: true, code: "UPSTREAM_ERROR", message: "QQ 未返回二维码图" };
        var sessionKey = utils_randToken(24);
        return host.storage.set(SKEY(sessionKey), {
          platform: platform, key: data.qrkey || data.unikey || data.key || "",
          createdAt: Date.now(), expiresAt: Date.now() + def.qrTtlSec * 1000
        }).then(function () {
          return {
            kind: "image",
            value: String(qrimage).indexOf("data:image") === 0 ? qrimage : "data:image/png;base64," + qrimage,
            ttlSec: def.qrTtlSec,
            pollIntervalMs: def.pollIntervalMs,
            sessionKey: sessionKey
          };
        });
      });
    }).then(function (payload) {
      host.log("startBind[" + platform + "] 出码, session=" + utils_fp(payload.sessionKey));
      return payload;
    }, function (e) {
      throw new Error("startBind 失败: " + ((e && (e.message || e.code)) || e));
    });
  };

  /** pollBind({sessionKey}):code 800=成功 801=待扫 802=过期 803=已扫;state 文本态。 */
  this.pollBind = function (params) {
    var sessionKey = params && (params.sessionKey || params.key);
    if (!sessionKey) return Promise.resolve({ code: 802, state: "expired", message: "缺少 sessionKey" });
    return host.storage.get(SKEY(sessionKey)).then(function (sess) {
      if (!sess) return { code: 802, state: "expired", message: "会话不存在或已清理" };
      if (Date.now() > sess.expiresAt) return { code: 802, state: "expired", message: "二维码已过期,请刷新" };
      var def = PLATFORMS[sess.platform];
      if (sess.platform === "netease") {
        // 用真实 unikey 探测路由(假 key 会拿到 400 参数错误,探不中正确路由)。
        return resolveNeteaseCheckRoute(sess.key).then(function (checkRoute) {
          return upstream.neteasePost(checkRoute, { key: sess.key, type: 1 }, "").then(function (r) {
            var code = r.json && r.json.code;
            var state = NET_QR_STATE[code] || "waiting";
            if (code === 803 || state === "confirmed") {
              return finalizeNetease(sessionKey, sess, r).then(function (out) { return out; });
            }
            return { code: state === "scanned" ? 803 : state === "expired" ? 802 : 801, state: state };
          });
        });
      }
      // QQ
      return upstream.qqMusicu(QQ_QR_CHECK_MODULE, { qrkey: sess.key, key: sess.key }, "").then(function (r) {
        var data = (r.json && r.json.req_0 && r.json.req_0.data) || {};
        var platformCode = data.code !== undefined ? data.code : (r.json && r.json.code);
        var state = QQ_QR_STATE[platformCode] || "waiting";
        if (state === "confirmed") {
          var cookie = mergeQQCookie(r.setCookie, data.musickey, data.uin);
          var cred = {
            cookie: cookie, musickey: data.musickey || "", refreshKey: data.refresh_key || "",
            uin: data.uin || 0, nickname: data.nickname || data.nick || "",
            avatarUrl: data.avatar || "", expiresAt: Date.now() + def.credTtlSec * 1000
          };
          return host.storage.delete(SKEY(sessionKey)).then(function () {
            return store.save("qq", cred).then(function () {
              host.log("pollBind[qq] 绑定成功,凭据指纹=" + store.fingerprint(cred));
              return { code: 800, state: "confirmed", account: { nickname: cred.nickname, avatarUrl: cred.avatarUrl } };
            });
          });
        }
        return { code: state === "scanned" ? 803 : state === "expired" ? 802 : 801, state: state };
      });
    }).then(function (out) { return out; }, function (e) {
      return { code: 801, state: "error", message: "轮询失败: " + ((e && (e.message || e.code)) || e) };
    });
  };

  /** 解析网易云 qrCheck 可用路由+参数形态:缓存命中直接复用;否则逐候选实测,
   *  返回 800/801/802/803 视为命中并写缓存。全不中 → 回退首候选+首形态(报其错误)。
   *  路由候选 × 参数形态(真机联调钉死后收敛,实测值存 storage)。 */
  function resolveNeteaseCheckRoute(probeKey) {
    var shapes = [
      function (k) { return { key: k, type: 1 }; },
      function (k) { return { key: k }; },
      function (k) { return { key: k, type: 1, csrf_token: "" }; }
    ];
    return host.storage.get("routeok:netease:qrCheck").then(function (cached) {
      if (cached) return cached;
      var tryAt = function (i, j) {
        if (i >= NET_QR_CHECK_CANDIDATES.length) return Promise.resolve(NET_QR_CHECK_CANDIDATES[0]);
        var route = NET_QR_CHECK_CANDIDATES[i];
        var shape = shapes[j];
        return upstream.neteasePost(route, shape(probeKey), "").then(function (r) {
          var code = r.json && r.json.code;
          if (NET_QR_STATE[code]) {
            host.log("qrCheck 路由钉死: " + route + " 形态#" + j + " (code " + code + ")");
            return host.storage.set("routeok:netease:qrCheck", route).then(function () { return route; });
          }
          return j + 1 < shapes.length ? tryAt(i, j + 1) : tryAt(i + 1, 0);
        }, function () { return j + 1 < shapes.length ? tryAt(i, j + 1) : tryAt(i + 1, 0); });
      };
      return tryAt(0, 0);
    });
  }

  function finalizeNetease(sessionKey, sess, checkRes) {
    var def = PLATFORMS.netease;
    var cookie = mergeQQCookie(checkRes.setCookie, "", 0);
    return upstream.neteasePost(def.routes.authProbe, { csrf_token: "" }, cookie).then(function (pr) {
      var account = (pr.json && (pr.json.account || (pr.json.data && pr.json.data.account))) || {};
      var profile = (pr.json && (pr.json.profile || (pr.json.data && pr.json.data.profile))) || {};
      var cred = {
        cookie: cookie, uin: account.id || 0, nickname: profile.nickname || "",
        avatarUrl: profile.avatarUrl || "", expiresAt: 0 // 禁预设 TTL,运行时检测
      };
      return host.storage.delete(SKEY(sessionKey)).then(function () {
        return store.save("netease", cred).then(function () {
          host.log("pollBind[netease] 绑定成功,凭据指纹=" + store.fingerprint(cred));
          return { code: 800, state: "confirmed", account: { nickname: cred.nickname, avatarUrl: cred.avatarUrl } };
        });
      });
    }, function () {
      // 探针失败仍按确认处理(cookie 已到手,运行时检测下次 runDailyJob 会定性)
      var cred = { cookie: mergeQQCookie(checkRes.setCookie, "", 0), uin: 0, nickname: "", avatarUrl: "", expiresAt: 0 };
      return host.storage.delete(SKEY(sessionKey)).then(function () {
        return store.save("netease", cred).then(function () {
          return { code: 800, state: "confirmed", account: { nickname: "", avatarUrl: "" }, message: "已确认,账号信息待下次探测" };
        });
      });
    });
  }

  function mergeQQCookie(setCookie, musickey, uin) {
    var jar = {};
    var sc = String(setCookie || "").match(/[^\s=;,]+=[^;]*/g) || [];
    for (var i = 0; i < sc.length; i++) {
      var kv = sc[i].split("=");
      if (kv[0]) jar[kv[0].trim()] = kv.slice(1).join("=");
    }
    if (musickey) { jar["qqmusic_key"] = musickey; jar["uin"] = String(uin || ""); }
    var out = [];
    for (var k in jar) if (Object.prototype.hasOwnProperty.call(jar, k)) out.push(k + "=" + jar[k]);
    return out.join("; ");
  }

  /** cancelBind({sessionKey}):清会话(幂等)。 */
  this.cancelBind = function (params) {
    var sessionKey = params && (params.sessionKey || params.key);
    if (!sessionKey) return Promise.resolve({ ok: true });
    return host.storage.delete(SKEY(sessionKey)).then(function () { return { ok: true }; });
  };
}

// ============================== §7 Normalizer ==============================

function Normalizer(cfg) {
  function platformCandidates(row) {
    var t = utils_norm(row.title || row.name || "");
    var a = utils_splitArtists(row.artist || "");
    var primary = { title: utils_stripSuffix(t), artist: a[0] || "", album: utils_norm(row.album || ""), duration: row.durationSec || 0 };
    var secondary = { title: t, artist: a.join(" "), album: utils_norm(row.album || ""), duration: row.durationSec || 0 };
    return [primary, secondary];
  }

  /** 双候选一次批量传 2N(T03 ②)。 */
  this.buildBatch = function (rows) {
    var batch = [];
    for (var i = 0; i < rows.length; i++) {
      var c = platformCandidates(rows[i]);
      batch.push(c[0]);
      batch.push(c[1]);
    }
    return batch;
  };
}

// ============================ §8 MatchPipeline ============================

function MatchPipeline(host, cfg) {
  var self = this;

  /** 三级管线:① host.songs.match(本地+WebDAV,双候选 2N)→ ②(同①,核心统一匹配器
   *  已含 WebDAV 域)→ ③ l2Enabled 时 host.sources.complete(透传 album+duration)。 */
  this.run = function (rows, opts) {
    var normalizer = new Normalizer(cfg);
    var batch = normalizer.buildBatch(rows);
    var l2 = !!(opts && opts.l2Enabled);
    if (host.songs && typeof host.songs.match === "function") {
      return host.songs.match(batch).then(function (hits) {
        return finish(rows, batch, hits, l2);
      }, function () {
        // 匹配器异常:视为全未命中,走在线/占位(门禁仍在)。
        var nulls = [];
        for (var i = 0; i < batch.length; i++) nulls.push(null);
        return finish(rows, batch, nulls, l2);
      });
    }
    return Promise.resolve().then(function () { return finish(rows, batch, null, l2); });
  };

  function finish(rows, batch, hits, l2) {
    var results = [];
    var chain = Promise.resolve();
    for (var i = 0; i < rows.length; i++) {
      (function (idx) {
        chain = chain.then(function () {
          var row = rows[idx];
          var hit = null;
          if (hits) {
            var a = hits[idx * 2];
            var b = hits[idx * 2 + 1];
            hit = a || b; // §9 双候选择一,本地优先由核心匹配器序保证
          }
          if (hit) {
            results.push({ row: row, level: "local", songId: hit, song: null, sourceType: null, score: 0 });
            return;
          }
          if (!l2) {
            results.push({ row: row, level: "external", songId: null, song: null, sourceType: null, score: 0 });
            return;
          }
          // 第3级:跨插件在线源(强制透传 album+duration,gate-check 硬卡)。
          var cands = new Normalizer(cfg).buildBatch([row])[0];
          return host.sources.complete({
            artist: cands.artist,
            title: cands.title,
            album: cands.album || "",
            duration: row.durationSec > 0 ? Math.round(row.durationSec) : 0
          }).then(function (res) {
            if (res && res.songId) {
              results.push({ row: row, level: "online", songId: res.songId, song: null, sourceType: "plugin", score: 0 });
            } else {
              results.push({ row: row, level: "external", songId: null, song: null, sourceType: null, score: 0 });
            }
          }, function () {
            results.push({ row: row, level: "external", songId: null, song: null, sourceType: null, score: 0 });
          });
        });
      })(i);
    }
    return chain.then(function () { return results; });
  }
}

// ============================ §10 PlaylistWriter ============================

function PlaylistWriter(host) {
  this.todayPlaylistId = function (platform, dateStr) {
    return PLATFORMS[platform].playlistPrefix + dateStr;
  };

  /** entry 构造严格互斥:命中 → {songId};未命中 → external* 全套(wy:/qq: 前缀)。 */
  this.buildEntry = function (result) {
    var row = result.row;
    if (result.songId) {
      return { songId: result.songId };
    }
    var def = PLATFORMS[row.platform] || {};
    var ext = String(row.platformId == null ? "" : row.platformId);
    return {
      externalSongId: (def.extPrefix || row.platform) + ":" + ext,
      externalTitle: row.title || "",
      externalArtist: row.artist || "",
      externalAlbum: row.album || "",
      externalDuration: row.durationSec > 0 ? Math.round(row.durationSec) : 0
    };
  };

  this.writeDaily = function (platform, results, dateStr) {
    var def = PLATFORMS[platform];
    var entries = [];
    var firstHit = null;
    var l1 = 0, l3 = 0, pending = 0;
    for (var i = 0; i < results.length; i++) {
      entries.push(this.buildEntry(results[i]));
      if (results[i].songId) {
        if (firstHit === null) firstHit = results[i].songId;
        if (results[i].level === "local") l1++; else l3++;
      } else pending++;
    }
    var name = def.label + " 每日推荐 " + dateStr.slice(0, 4) + "-" + dateStr.slice(4, 6) + "-" + dateStr.slice(6, 8);
    var self = this;
    return host.playlists.upsert(this.todayPlaylistId(platform, dateStr), {
      name: name,
      description: "由 daily-rec-platform 插件从 " + def.label + "「每日推荐」生成(命中条目已匹配本地库;未命中为外部占位,由后端 auto-match 兜底)。",
      sourcePlatform: platform,
      sourceUrl: def.homeUrl,
      entries: entries
    }).then(function () {
      var jobs = [];
      if (firstHit !== null && typeof host.playlists.updateCover === "function") {
        jobs.push(host.playlists.updateCover(self.todayPlaylistId(platform, dateStr), firstHit).catch(function () {}));
      }
      return Promise.all(jobs).then(function () {
        return { entries: entries.length, l1: l1, l3: l3, pending: pending };
      });
    });
  };
}

// ============================ §10b HistoryRoller ============================

function HistoryRoller(host) {
  function snapKey(platform, dateStr) { return "snap:" + platform + ":" + dateStr; }

  this.saveSnapshot = function (platform, dateStr, entries) {
    return host.storage.set(snapKey(platform, dateStr), entries);
  };

  this.loadSnapshot = function (platform, dateStr) {
    return host.storage.get(snapKey(platform, dateStr)).then(function (v) { return Array.isArray(v) ? v : null; });
  };

  function entryKey(e) {
    return e.songId ? "s:" + e.songId : "e:" + e.externalSongId;
  }

  /** 最近 lastNDays 天快照并集去重(新→旧);不靠猜:只读快照。 */
  this.buildUnion = function (platform, dateStr, lastNDays) {
    var self = this;
    var dates = [];
    for (var d = 0; d < lastNDays; d++) dates.push(utils_dateOffset(-d));
    var jobs = dates.map(function (dt) { return self.loadSnapshot(platform, dt); });
    return Promise.all(jobs).then(function (snaps) {
      var seen = {};
      var out = [];
      for (var i = 0; i < snaps.length; i++) {
        var snap = snaps[i];
        if (!snap) continue;
        for (var j = 0; j < snap.length; j++) {
          var e = snap[j];
          var k = entryKey(e);
          if (!k || seen[k]) continue;
          seen[k] = 1;
          out.push(e);
        }
      }
      return out;
    });
  };

  /** roll:读 prev(昨日今日歌单 id)→ 重建历史(7 天并集)→ 删昨日 → 记 prev=今日。
   *  ⚠️ 删除必须在历史重建成功之后(Q7′,避免丢内容);定位读 storage.prev:<platform>,不靠猜。 */
  this.roll = function (platform, dateStr, lastNDays) {
    var def = PLATFORMS[platform];
    var self = this;
    return host.storage.get("prev:" + platform).then(function (prevId) {
      return self.buildUnion(platform, dateStr, lastNDays).then(function (union) {
        return host.playlists.replaceEntries(def.historyId, union).then(function () {
          var delJob = (prevId && prevId !== def.playlistPrefix + dateStr)
            ? host.playlists.delete(prevId).then(function (ok) { return ok ? prevId : null; }, function () { return null; })
            : Promise.resolve(null);
          return delJob.then(function (deleted) {
            return host.storage.set("prev:" + platform, def.playlistPrefix + dateStr).then(function () {
              return { deleted: deleted };
            });
          });
        });
      });
    });
  };
}

// ============================= §11 Diagnostics =============================

function Diagnostics() {
  this.begin = function (platform) {
    return { platform: platform, startedAt: Date.now(), route: "", total: 0, l1: 0, l3: 0, pending: 0, errorCode: "", groupKeyWarning: false };
  };
  this.finish = function (ctx) {
    ctx.durationMs = Date.now() - ctx.startedAt;
    return ctx;
  };
  this.render = function (s) {
    return s.platform + ": 接口=" + (s.route || "-") + " 曲目=" + s.total +
      " 本地命中=" + s.l1 + " 在线补全=" + s.l3 + " 待补=" + s.pending +
      " 耗时=" + s.durationMs + "ms" + (s.errorCode ? " 错误=" + s.errorCode : "") +
      (s.groupKeyWarning ? " ⚠group_key 命中率异常为 0" : "");
  };
}

// ============================ §12 DailySnapshot ============================

function DailySnapshot(host) {
  function doneKey(platform, dateStr) { return "snapdone:" + platform + ":" + dateStr; }

  this.shouldSkip = function (platform, dateStr, accountKey, force) {
    if (force) return Promise.resolve(false);
    return host.storage.get(doneKey(platform, dateStr)).then(function (v) { return !!v; });
  };

  this.markDone = function (platform, dateStr, accountKey) {
    return host.storage.set(doneKey(platform, dateStr), { at: Date.now() });
  };
}

// ============================== §13 manifest ===============================

var MANIFEST = {
  id: "daily-rec-platform",
  name: "每日推荐（QQ/网易云）",
  version: "1.0.0",
  type: "recommender",
  description: "拉取网易云音乐与 QQ 音乐的「每日推荐」，经库内严格匹配后产出每平台 2 张歌单（今日带日期 + 近 7 天历史滚动并集）。支持扫码登录绑定账号（网易云二维码 URL + QQ 官方二维码图），凭据只存宿主 host.storage、日志仅指纹。选源强制门禁：本地匹配(host.songs.match)未命中才走跨插件在线源补全（透传 album+duration），绝不自行拼接在线播放 URL。",
  capabilities: ["qrLogin", "search", "recommendPlaylist"],
  minAppVersion: "4.3.1",
  longRunning: { runDailyJob: 300000 },
  permissions: ["net", "storage", "crypto", "songs:read", "songs:write", "playlists:read", "playlists:write", "inter-plugin"],
  defaultEnabled: false,
  author: "ray5378",
  homepage: "https://github.com/ray5378/MusicFlow-plugins",
  downloadUrl: "https://github.com/ray5378/MusicFlow-plugins/releases/download/daily-rec-platform-v1.0.0/daily-rec-platform.tar.gz",
  configSchema: [
    {
      key: "bind",
      label: "扫码登录绑定账号",
      type: "action",
      action: "startBind",
      help: "点击后弹出二维码：使用「绑定平台」所选的 App 扫码确认，成功后弹窗自动关闭。两平台各绑定一次即可。"
    },
    {
      key: "bindPlatform",
      label: "绑定平台",
      type: "select",
      required: true,
      options: [
        { value: "netease", label: "网易云音乐" },
        { value: "qq", label: "QQ 音乐" }
      ],
      default: "netease",
      group: "bind",
      help: "「扫码登录」按钮使用的平台。如需两平台都用，先选网易云绑定一次，再切到 QQ 音乐绑定一次。"
    },
    {
      key: "l2Enabled",
      label: "未命中时在线补全",
      type: "switch",
      default: false,
      group: "match",
      help: "本地库未命中的歌曲尝试经跨插件在线源补全（需已启用至少一个音源插件，且按专辑+时长四维门禁核实）。关闭时生成外部占位条目，由后端 auto-match 兜底。"
    }
  ],
  documentation: "### 功能介绍\n拉取网易云音乐与 QQ 音乐的「每日推荐」，匹配本地音乐库后产出歌单：\n- 今日歌单：`网易云音乐/QQ音乐 每日推荐 <日期>`（每天新建带日期 id）\n- 历史日推：最近 7 天并集去重（新→旧），昨日今日歌单并入历史后删除\n\n### 扫码登录\n在插件配置页点「扫码登录绑定账号」弹出二维码：网易云为登录链接（由服务端渲染成二维码）、QQ 音乐为官方二维码图。扫码确认后凭据加密存于 MusicFlow 本机（host.storage），日志只显示指纹（前 6 位+长度），解绑即删。不提供密码登录。\n\n### 选源与门禁\n三级全部强制门禁：① 本地库匹配（host.songs.match，歌名/歌手/时长/专辑四维评分）→ ② WebDAV 同源 → ③（可选，默认关）跨插件在线源补全，调用时透传专辑与时长供宿主四维核实。本插件绝不自行拼接在线播放 URL。\n\n### 隐私与合规\n仅供个人自用；本插件直连平台官方接口，无任何外部中转服务。凭据只保存在你自己的 MusicFlow 实例中。",
  i18n: {
    en: {
      name: "Daily Recommendations (QQ/NetEase)",
      description: "Fetches personal Daily Recommendations from NetEase Cloud Music and QQ Music, matches them strictly against the local library, and produces 2 playlists per platform (dated daily + rolling 7-day history). Supports QR-code login binding; credentials stay in host.storage with fingerprint-only logs. Source selection enforces the library-match gate before optional cross-plugin online completion (album+duration passed through); never builds online stream URLs itself.",
      groups: { bind: "Account Binding", match: "Matching" },
      fields: {
        bind: {
          label: "Bind account via QR code",
          help: "Click to open a QR code: scan with the app selected in 'Bind platform'. The dialog closes automatically after confirmation. Bind each platform once."
        },
        bindPlatform: {
          label: "Bind platform",
          help: "Platform used by the 'Bind account' button. To use both, bind NetEase first, then switch to QQ Music and bind again."
        },
        l2Enabled: {
          label: "Online completion for unmatched",
          help: "Try cross-plugin online sources for unmatched songs (requires at least one enabled source plugin; verified by the album+duration gate). When off, external placeholder entries are written and the backend auto-match takes over."
        }
      },
      documentation: "### Features\nFetches personal Daily Recommendations from NetEase Cloud Music / QQ Music and produces playlists after strict local-library matching:\n- Daily playlist: `<Platform> Daily Recommendations <date>` (new dated id every day)\n- History: union of the last 7 days, deduplicated (newest first); yesterday's daily playlist is merged into history then deleted\n\n### QR Login\nClick 'Bind account' in the plugin config: NetEase shows a login URL rendered as a QR by the server, QQ Music shows the official QR image. Credentials are stored encrypted on your own MusicFlow instance (host.storage); logs show fingerprints only (first 6 chars + length). Password login is not supported.\n\n### Source gating\nAll three tiers enforce gates: ① local library match (host.songs.match, title/artist/duration/album scoring) → ② WebDAV → ③ (optional, off by default) cross-plugin online completion passing album + duration for the host-side four-dimension verification. This plugin never builds online stream URLs itself.\n\n### Privacy\nFor personal use only; connects directly to the official platform APIs with no external relay service. Credentials never leave your MusicFlow instance."
    }
  }
};

// ============================== §14 create(host) ==============================

globalThis.__mfPlugin = {
  manifest: MANIFEST,
  create: function (host) {
    var crypto = new CryptoOrchestrator(host);
    var upstream = new UpstreamClient(host, crypto);
    var store = new CredentialStore(host);
    var guard = new SessionGuard(host, upstream, store);
    var qr = new QrLoginService(host, upstream, store);
    var diag = new Diagnostics();
    var snapshot = new DailySnapshot(host);

    /** 从平台响应里容错抽取曲目数组(两平台字段形态差异/版本漂移兜底)。 */
    function pickSongList(resp, platform) {
      var arrays = [];
      var visit = function (node, depth) {
        if (!node || typeof node !== "object" || depth > 6) return;
        if (Array.isArray(node)) {
          if (node.length && isTrackLike(node[0])) arrays.push(node);
          for (var i = 0; i < node.length && arrays.length < 3; i++) visit(node[i], depth + 1);
          return;
        }
        for (var k in node) {
          if (Object.prototype.hasOwnProperty.call(node, k)) visit(node[k], depth + 1);
        }
      };
      var isTrackLike = function (t) {
        return t && (t.id || t.mid || t.songId || t.songmid) && (t.name || t.title || t.songName);
      };
      visit(resp, 0);
      return arrays.length ? arrays[0] : [];
    }

    function rowsFrom(platform, list) {
      var rows = [];
      for (var i = 0; i < list.length; i++) {
        var t = list[i] || {};
        var id, title, artist, album, durationMs, cover;
        if (platform === "netease") {
          id = t.id;
          title = t.name || t.title || "";
          artist = (t.ar && t.ar.map(function (x) { return x.name; }).join("/")) || t.artists && t.artists.map(function (x) { return x.name; }).join("/") || "";
          album = (t.al && t.al.name) || (t.album && t.album.name) || "";
          durationMs = t.dt || t.duration || 0;
          cover = (t.al && t.al.picUrl) || (t.album && t.album.picUrl) || "";
        } else {
          id = t.mid || t.songmid || t.id;
          title = t.name || t.title || t.songName || "";
          var singers = t.singer || t.singers || [];
          artist = Array.isArray(singers) ? singers.map(function (x) { return x.name; }).join("/") : String(singers);
          album = (t.album && (t.album.name || t.album.title)) || "";
          durationMs = (t.interval ? t.interval * 1000 : 0) || t.duration || 0;
          cover = (t.album && t.album.mid) ? "https://y.gtimg.cn/music/photo_new/T002R300x300M000" + t.album.mid + ".jpg" : "";
        }
        if (!id || !title) continue;
        rows.push({
          platform: platform,
          platformId: String(id),
          title: title,
          artist: artist,
          album: album,
          durationSec: durationMs > 0 ? Math.round(durationMs / 1000) : 0,
          coverUrl: cover
        });
      }
      return rows;
    }

    function fetchDaily(platform, cred) {
      var def = PLATFORMS[platform];
      if (platform === "netease") {
        return upstream.neteasePost(def.routes.daily, { limit: 30, total: true, csrf_token: "" }, cred.cookie)
          .then(function (r) { return rowsFrom(platform, pickSongList(r.json, platform)); });
      }
      // QQ:每日30首卡片 → tid → playlist_detail(§2 design)。卡片接口拿不到 tid 时
      // 直接返回空(空结果不写快照,不误删)。
      return upstream.qqMusicu(QQ_DAILY_MODULE, {}, cred.cookie, cred.uin).then(function (r) {
        var data = (r.json && r.json.req_0 && r.json.req_0.data) || {};
        var tid = data.tid || data.disssimid || (Array.isArray(data.list) && data.list[0] && (data.list[0].tid || data.list[0].id));
        if (!tid) return [];
        return upstream.qqMusicu(QQ_PLAYLIST_DETAIL_MODULE, { tid: tid, onlysonglist: 1 }, cred.cookie, cred.uin).then(function (r2) {
          var d2 = (r2.json && r2.json.req_0 && r2.json.req_0.data) || {};
          return rowsFrom(platform, pickSongList(d2.songlist ? d2 : (d2.song_list ? { songlist: d2.song_list } : d2), platform));
        });
      });
    }

    var impl = {
      // ---- qrLogin 三方法(主仓 CAP_METHODS.qrLogin / QR_ACTION_METHODS 白名单) ----
      startBind: function (params) { return qr.startBind(params || {}); },
      pollBind: function (params) { return qr.pollBind(params || {}); },
      cancelBind: function (params) { return qr.cancelBind(params || {}); },

      // ---- search:平台搜索(第3级在线补全的候选源之一) ----
      search: function (config, params) {
        var query = utils_norm((params && (params.query || params.q)) || "");
        if (!query) return Promise.resolve({ songs: [] });
        var platform = (config && config.searchPlatform) || "netease";
        var jobs = [];
        // 双平台并行搜索,合并去重(按 歌名+歌手)。
        jobs.push(upstream.neteasePost("/cloudsearch/get/web", { s: query, type: 1, limit: 30, csrf_token: "" }, "")
          .then(function (r) {
            var list = (r.json && r.json.result && r.json.result.songs) || [];
            return rowsFrom("netease", list).map(function (row) {
              return { id: row.platformId, source: "netease", name: row.title, artist: row.artist, album: row.album, duration: row.durationSec, cover: row.coverUrl };
            });
          }, function () { return []; }));
        jobs.push(upstream.qqMusicu(QQ_SEARCH_MODULE, { search_type: 0, query: query, page_num: 1, num_per_page: 30 }, "")
          .then(function (r) {
            var body = (r.json && r.json.req_0 && r.json.req_0.data && r.json.req_0.data.body) || {};
            var list = (body.song && body.song.list) || [];
            return rowsFrom("qq", list).map(function (row) {
              return { id: row.platformId, source: "qq", name: row.title, artist: row.artist, album: row.album, duration: row.durationSec, cover: row.coverUrl };
            });
          }, function () { return []; }));
        return Promise.all(jobs).then(function (rs) {
          var seen = {};
          var songs = [];
          for (var i = 0; i < rs.length; i++) {
            for (var j = 0; j < rs[i].length; j++) {
              var s = rs[i][j];
              var k = utils_norm(s.name) + "|" + utils_norm(s.artist);
              if (seen[k]) continue;
              seen[k] = 1;
              songs.push(s);
            }
          }
          return { songs: songs };
        });
      },

      // ---- health:启动 selfCheck 路由探测(404 报进 message,R4) ----
      health: function () {
        return upstream.selfCheck().then(function (lines) {
          var bad = [];
          for (var i = 0; i < lines.length; i++) if (lines[i].indexOf("FAIL") === 0) bad.push(lines[i]);
          return { ok: bad.length === 0, message: lines.join("; ") };
        }, function (e) {
          return { ok: false, message: "selfCheck 异常: " + ((e && e.message) || e) };
        });
      },

      // ---- test(config):兜底文本通道,报告绑定状态 + 可操作 message ----
      test: function (config, params) {
        return store.listBound().then(function (bound) {
          if (!bound.length) {
            return { ok: true, message: "尚未绑定任何平台。请在插件配置页点「扫码登录绑定账号」(平台由「绑定平台」下拉决定);绑定后每日刷新会自动产出歌单。" };
          }
          var jobs = bound.map(function (plat) {
            return store.get(plat).then(function (cred) {
              return guard.probe(plat, cred).then(function (p) {
                return (p.ok ? "✓ " : "✗ ") + PLATFORMS[plat].label + " 凭据" + (p.ok ? "有效" : "已失效,请重新扫码") + " (指纹 " + store.fingerprint(cred) + ")";
              });
            });
          });
          return Promise.all(jobs).then(function (lines) {
            return { ok: true, message: "已绑定: " + bound.join(", ") + "\n" + lines.join("\n") };
          });
        });
      },

      // ---- runDailyJob(opts?):Promise<string|null>(longRunning 300s) ----
      runDailyJob: function (opts) {
        var cfg = host.config || {};
        var force = !!(opts && opts.force);
        var l2Enabled = !!cfg.l2Enabled;
        var dateStr = utils_today();
        var writer = new PlaylistWriter(host);
        var roller = new HistoryRoller(host);
        var lines = [];
        var anyJob = false;
        var anyDone = false;

        var chain = Promise.resolve();
        for (var pi = 0; pi < PLATFORM_ORDER.length; pi++) {
          (function (platform) {
            chain = chain.then(function () {
              var ctx = diag.begin(platform);
              return store.get(platform).then(function (cred) {
                if (!cred) { lines.push(platform + ": 未绑定,跳过"); return; }
                anyJob = true;
                return snapshot.shouldSkip(platform, dateStr, "", force).then(function (skip) {
                  if (skip) { lines.push(platform + ": 当日已完成,跳过"); return; }
                  return guard.ensureValid(platform, cred).then(function (g) {
                    if (!g.ok) {
                      ctx.errorCode = g.code || "AUTH_UNKNOWN";
                      lines.push(diag.render(diag.finish(ctx)) + " — " + (g.message || ""));
                      return;
                    }
                    var useCred = g.cred || cred;
                    return fetchDaily(platform, useCred).then(function (rows) {
                      ctx.route = PLATFORMS[platform].routes.daily;
                      ctx.total = rows.length;
                      if (!rows.length) {
                        // 空结果不写快照、不动歌单(§12 ①)。
                        ctx.errorCode = "UPSTREAM_EMPTY";
                        lines.push(diag.render(diag.finish(ctx)) + " — 空结果,不写快照");
                        return;
                      }
                      var pipeline = new MatchPipeline(host, cfg);
                      return pipeline.run(rows, { l2Enabled: l2Enabled }).then(function (results) {
                        for (var i = 0; i < results.length; i++) {
                          if (results[i].level === "local") ctx.l1++;
                          else if (results[i].level === "online") ctx.l3++;
                          else ctx.pending++;
                        }
                        return writer.writeDaily(platform, results, dateStr).then(function () {
                          var entries = [];
                          for (var j = 0; j < results.length; j++) entries.push(writer.buildEntry(results[j]));
                          return roller.saveSnapshot(platform, dateStr, entries).then(function () {
                            return roller.roll(platform, dateStr, 7).then(function (rolled) {
                              return snapshot.markDone(platform, dateStr, "").then(function () {
                                anyDone = true;
                                lines.push(diag.render(diag.finish(ctx)));
                              });
                            });
                          });
                        });
                      });
                    }, function (e) {
                      ctx.errorCode = (e && e.code) || "UPSTREAM_ERROR";
                      lines.push(diag.render(diag.finish(ctx)) + " — " + ((e && e.message) || e));
                    });
                  });
                });
              }, function () {
                lines.push(platform + ": 读取凭据失败,跳过");
              });
            });
          })(PLATFORM_ORDER[pi]);
        }

        return chain.then(function () {
          if (!anyJob) return null; // 未绑定任何平台:core 层面无事可做
          if (!anyDone && !force) return lines.join("\n") || null;
          return lines.join("\n") || "完成";
        });
      },

      // ---- recommendLocal:首页分区输出 [今日, 历史](getMeta 为 null 则跳过) ----
      recommendLocal: function (config) {
        var out = [];
        var jobs = [];
        for (var i = 0; i < PLATFORM_ORDER.length; i++) {
          (function (platform) {
            var dateStr = utils_today();
            var ids = [PLATFORMS[platform].playlistPrefix + dateStr, PLATFORMS[platform].historyId];
            for (var j = 0; j < ids.length; j++) {
              (function (id) {
                var getMeta = host.playlists.getMeta || host.playlists.get;
                jobs.push(Promise.resolve().then(function () { return getMeta.call(host.playlists, id); }).then(function (meta) {
                  if (meta) out.push({ id: meta.id, name: meta.name, coverArt: meta.cover_art || meta.coverArt || null, songCount: meta.song_count || meta.songCount || 0 });
                }, function () {}));
              })(ids[j]);
            }
          })(PLATFORM_ORDER[i]);
        }
        return Promise.all(jobs).then(function () { return { playlists: out }; });
      }
    };

    host.log("daily-rec-platform v" + MANIFEST.version + " 已装配(能力: " + MANIFEST.capabilities.join("/") + ")");
    return impl;
  }
};
