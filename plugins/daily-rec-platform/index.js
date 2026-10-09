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
      qrKey: "/login/qrcode/unikey", // go:interface 域纯 form POST {type:3}(弃 weapi+type:1,确认后 8821)
      qrCheck: "/login/qrcode/client/login", // go:interface 域纯 form POST {key,type:3} → 800/801/802/803
      daily: "/v3/discovery/recommend/songs", // weapi POST → data.dailySongs[](NeteaseCloudMusicApi 蓝本:真实路径 weapi/v3/discovery/recommend/songs,/recommend/songs 是库对外路由名,直打 404)
      authProbe: "/nuser/account/get", // 运行时有效性检测(go 蓝本 weapi/nuser/account/get;误带 /api/w 前缀 240 真机报 8821)
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
  },
  kugou: {
    label: "酷狗音乐",
    slug: "kugou",
    extPrefix: "kg",
    routes: {
      qrKey: "/v2/qrcode", // web 签名 GET(appid=1001)→ data.qrcode + data.qrcode_img
      qrCheck: "/v2/get_userinfo_qrcode", // web 签名 GET(status 0/1/2/4)
      daily: "/everyday_song_recommend", // android 签名 POST(gateway x-router)
      authProbe: "/v7/get_all_list", // 运行时有效性检测(cloudlist,status===1)
      refresh: null,
      history: null
    },
    apiBase: KG_GATEWAY,
    playlistPrefix: "pl-daily-rec-kugou-",
    historyId: "pl-daily-rec-kugou-history",
    qrUrlTpl: "https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode={key}",
    qrTtlSec: 120, // 官方 h5 页口径;轮询 3s
    pollIntervalMs: 3000,
    credTtlSec: null, // 禁预设 TTL,运行时探测定性
    homeUrl: "https://www.kugou.com/"
  }
};

var PLATFORM_ORDER = ["netease", "qq", "kugou"];

// ============================== §2 ROUTES(常量) ==============================
// QQ musicu.fcg 模块/方法。⚠️ 模块名与码值需真机联调校准;保持集中定义便于一处改。

var QQ_FCG_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";
var QQ_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MusicFlow-Plugin/1.0";
// ===== QQ ptlogin2 扫码通道(go-music-dl login.go 权威蓝本,230 实测可用) =====
// 旧 musicu QrCodeLoginCgiService 通道服务端 403/500001 风控,弃用;musicu 仅
// 保留用于登录后的日推/歌单/搜索接口。
var QQ_PT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
// doQQRequest(go 蓝本):check_sig 逐跳/authorize/QQLogin 统一 Chrome/126 UA + Accept */*。
var QQ_OAUTH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
var QQ_PT_RESTRICTED_MSG = "QQ 音乐登录服务对本服务器网络受限(风控拦截)，无法完成请求。建议：将 MusicFlow 部署于住宅/家宽网络，或在系统设置→网络代理配置可用代理后重试。该错误与二维码过期无关。";
var QQ_OAUTH_LOGIN_JUMP = "https://graph.qq.com/oauth2.0/login_jump";
var QQ_OAUTH_AUTHORIZE_URL = "https://graph.qq.com/oauth2.0/authorize";
var QQ_OAUTH_CLIENT_ID = "100497308";
var QQ_OAUTH_SCOPE = "get_user_info";
var QQ_OAUTH_REDIRECT_URI = "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=" + encodeURIComponent("https://y.qq.com/");
var QQ_XLOGIN_URL = "https://xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=716027609&daid=383&style=33&login_text=%E7%99%BB%E5%BD%95&hide_title_bar=1&hide_border=1&target=self&s_url=" + encodeURIComponent(QQ_OAUTH_LOGIN_JUMP) + "&pt_3rd_aid=" + QQ_OAUTH_CLIENT_ID + "&pt_feedback_link=https%3A%2F%2Fsupport.qq.com%2Fproducts%2F77942%3FcustomInfo%3D.appid" + QQ_OAUTH_CLIENT_ID + "&theme=2&verify_theme=";
var QQ_QRSHOW_URL = "https://xui.ptlogin2.qq.com/ssl/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4&daid=383&pt_3rd_aid=" + QQ_OAUTH_CLIENT_ID + "&u1=" + encodeURIComponent(QQ_OAUTH_LOGIN_JUMP) + "&t=";
var QQ_QRCHECK_URL = "https://xui.ptlogin2.qq.com/ssl/ptqrlogin";
// ===== 酷狗(KuGouMusicApi util 蓝本逐行对齐) =====
var KG_WEB_SALT = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
var KG_ANDROID_SALT = "OIlwieks28dk2k092lksi2UIkp";
var KG_GATEWAY = "https://gateway.kugou.com";
var KG_UA = "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi";
var KG_MID = "334689572176563962868706300678062568191";
var KG_QR_BASE = "https://login-user.kugou.com";
// 旧模块(scheduledDailysong / UserInfoService.GetUserBaseInfo)被模块级鉴权拒
// (req0.code=500003 subcode=860100001,240 真机实证);日推改两步链 + 探针改
// fcg_user_created_diss(均实证 code=0)。UA/端点照抄 lead 实测口径,勿改。
var QQ_FCG_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
var QQ_FCG_CDINFO_URL = "https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";
var QQ_FCG_CREATED_DISS_URL = "https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss";
var NET_ACCOUNT_URL = "https://music.163.com/api/nuser/account/get";
var QQ_SEARCH_MODULE = { module: "music.search.SearchCgiService", method: "DoSearchForQQMusicDesktop" };
var NET_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MusicFlow-Plugin/1.0";

// 网易云轮询码值(实测主流值):800=过期 801=等待扫码 802=已扫码待确认 803=已确认。
// QQ ptqrlogin 码值(ptuiCB 第1参):0=确认 65=过期 66=待扫 67=已扫待确认 68=拒绝。
var NET_QR_STATE = { 800: "expired", 801: "waiting", 802: "scanned", 803: "confirmed" };
var QQ_QR_STATE = { 0: "confirmed", 65: "expired", 66: "waiting", 67: "scanned", 68: "refused" };
// 酷狗 /v2/get_userinfo_qrcode data.status:0=过期 1=待扫 2=待确认 4=成功(返回 token)。
var KG_QR_STATE = { 0: "expired", 1: "waiting", 2: "scanned", 4: "confirmed" };

// 网易云二维码两接口(go netease/login.go 逐参数口径):interface.music.163.com 纯 form POST。
// ⚠️ 弃用 weapi+type:1:该通道与 App 端 client login 不匹配,手机确认后服务端回
// 8821(二维码已被使用)而非 803 —— 240 真机第三轮实锤。form+type:3 与 go-music-dl 生产链一致。
var NET_QR_KEY_URL = "https://interface.music.163.com/api/login/qrcode/unikey";
var NET_QR_CHECK_URL = "https://interface.music.163.com/api/login/qrcode/client/login";
var NET_DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152";

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

// QQ ptqrtoken:hash33(qrsig),起点 0(go 蓝本 hash33 逐行对齐;每迭代 &0x7fffffff)。
function utils_hash33(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) {
    h += (h << 5) + s.charCodeAt(i);
    h &= 0x7fffffff;
  }
  return h;
}

// QQ oauth2.0 g_tk:gtk33(p_skey),起点 5381(go 蓝本 gtk33 逐行对齐)。
function utils_gtk33(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) {
    h += (h << 5) + s.charCodeAt(i);
    h &= 0x7fffffff;
  }
  return h;
}

/** 相对 Location → 绝对 URL(go resolveQQURL 简化版)。 */
function utils_absUrl(base, loc) {
  var l = String(loc || "").trim();
  if (!l) return "";
  if (/^https?:\/\//i.test(l)) return l;
  if (l.indexOf("//") === 0) return "https:" + l;
  var m = String(base || "").match(/^https?:\/\/[^\/]+/);
  return (m ? m[0] : "") + (l.charAt(0) === "/" ? l : "/" + l);
}

/** host.http 响应的 Set-Cookie(核心合并串)解析进 jar(name→value,丢弃属性段)。 */
/** set-cookie 串/数组 → 逐条条目。核心 4.3.2 起 host.http 响应带 setCookieList 数组
 *  (undici getSetCookie(),主仓 discovery.ts 注入)时直接透传;否则对合串做 RFC 感知
 *  拆分:仅当逗号后随「token=」形态才是分隔符 —— Expires=Wed, 09 Oct… 日期自带逗号,
 *  朴素 split 会把日期片段炸成假 cookie(240 真机:QQ jar 出现 EXPIRES/PATH/DOMAIN 假键)。
 *  例:"A=1; Expires=Wed, 09 Oct 2026 07:00:00 GMT, B=2" → ["A=1; Expires=…GMT", " B=2"]。 */
function utils_splitSetCookie(sc) {
  if (sc && typeof sc.join === "function") return sc; // 数组直传(getSetCookie 通道)
  var s = String(sc || "");
  if (!s) return [];
  var segs = s.split(",");
  var parts = [];
  var buf = "";
  for (var i = 0; i < segs.length; i++) {
    buf = buf ? buf + "," + segs[i] : segs[i];
    var nxt = segs[i + 1];
    if (nxt !== undefined && /^\s*[^\s=;,]+=/.test(nxt)) { parts.push(buf); buf = ""; }
  }
  parts.push(buf);
  return parts;
}

var COOKIE_ATTRS = { path: 1, domain: 1, expires: 1, "max-age": 1, samesite: 1, secure: 1, httponly: 1, version: 1, comment: 1 };

/** 单条 cookie 条目("k=v; attrs")并入 jar:值截断于首个 ";"(属性段),
 *  属性名/空值跳过 —— 删除型空值不得冲掉有效值(T04c),EXPIRES/PATH 等假键不得进 jar(T05)。 */
function utils_mergeCookieEntry(entry, jar) {
  var eq = String(entry || "").indexOf("=");
  if (eq <= 0) return jar;
  var name = entry.slice(0, eq).trim();
  var val = entry.slice(eq + 1).trim();
  var semi = val.indexOf(";");
  if (semi !== -1) val = val.slice(0, semi).trim();
  if (!name || COOKIE_ATTRS[name.toLowerCase()] || val === "") return jar;
  jar[name] = val;
  return jar;
}

function utils_parseCookies(res, jar) {
  jar = jar || {};
  var h = (res && res.headers) || {};
  var sc = h["set-cookie"] || h["Set-Cookie"] || "";
  var entries = utils_splitSetCookie(sc);
  for (var i = 0; i < entries.length; i++) utils_mergeCookieEntry(entries[i], jar);
  return jar;
}

/** QQ 出站随机国内 IP 头(蓝本 utils.WithRandomIPHeader 同款意图):
 *  X-Forwarded-For / X-Real-IP 同值。沙箱内 Math.random 可用(randSecretKey 已用)。 */
function rndChinaIP() {
  var prefixes = [[116, 255], [116, 228], [218, 192], [124, 0], [14, 132], [183, 14], [58, 14], [113, 116], [120, 230]];
  var p = prefixes[Math.floor(Math.random() * prefixes.length)];
  return p[0] + "." + p[1] + "." + (1 + Math.floor(Math.random() * 254)) + "." + (1 + Math.floor(Math.random() * 254));
}

/** cookie jar → Cookie 头串(空值跳过)。 */
function utils_jarHeader(jar) {
  var out = [];
  for (var k in jar) if (Object.prototype.hasOwnProperty.call(jar, k) && jar[k] !== "") out.push(k + "=" + jar[k]);
  return out.join("; ");
}

/** UUID v4(Math.random 版,go qqUUID 简化;oauth authorize ui 参数用)。 */
function utils_uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    var v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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

  // ===== 酷狗签名(KuGouMusicApi util/helper.js 逐行对齐:
  // web=先 map 后 sort;android=先 sort 后 map,data 为 JSON body) =====
  this.kgSignWeb = function (params) {
    var parts = Object.keys(params).map(function (k) { return k + "=" + params[k]; }).sort().join("");
    return prim(host.crypto.md5(KG_WEB_SALT + parts + KG_WEB_SALT), "kgSignWeb.md5");
  };

  this.kgSignAndroid = function (params, dataText) {
    var parts = Object.keys(params).sort().map(function (k) {
      return k + "=" + (params[k] && typeof params[k] === "object" ? JSON.stringify(params[k]) : params[k]);
    }).join("");
    return prim(host.crypto.md5(KG_ANDROID_SALT + parts + (dataText || "") + KG_ANDROID_SALT), "kgSignAndroid.md5");
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
    // 8821(240 真机):二维码已被使用/失效——按过期收口给刷新按钮,不当业务错误循环报。
    if (code === 8821) return errOf("QR_EXPIRED", "二维码已失效或已被使用，请刷新后重新扫码");
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

  /** 网易云二维码专用:纯 form POST(go 蓝本口径,无加密无 cookie,interface.music.163.com)。
   *  返回 {json, setCookie, status} 或抛 {__err}。 */
  this.neteaseFormPost = function (url, params) {
    var p = params || {};
    var parts = [];
    for (var k in p) parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(p[k])));
    return host.http(url, {
      method: "POST", redirect: "manual", timeout: 15000,
      headers: {
        "User-Agent": NET_DESKTOP_UA,
        "Referer": "http://music.163.com/",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: parts.join("&")
    }).then(function (res) {
      var text = String(res.body || "");
      var json = null;
      try { json = JSON.parse(text); } catch (e2) { json = null; }
      if (res.status !== 200 || !json) {
        throw { __err: true, code: "UPSTREAM_ERROR", message: "网易云二维码接口异常(" + res.status + "): " + text.slice(0, 120) };
      }
      return { json: json, setCookie: collectCookies(res), status: res.status };
    }, function (e2) {
      if (e2 && e2.__err) throw e2;
      throw errOf("NETWORK", "网易云二维码请求失败: " + ((e2 && e2.message) || e2));
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
    var qip = rndChinaIP();
    return host.http(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "User-Agent": QQ_UA,
        Referer: "https://y.qq.com/",
        Cookie: cookie || "",
        "X-Forwarded-For": qip,
        "X-Real-IP": qip
      },
      body: encBody,
      timeout: 15000
    }).then(function (res) {
      // 风控/受限网络:403(ptlogin2/网关层拦截)与明文 500001(musicu 网关拒收)
      // 单独归类,给部署建议文案,绝不误报为「二维码过期」。
      if (res.status === 403) throw errOf("NETWORK_RESTRICTED", "QQ 音乐登录服务对本服务器网络受限(风控拦截)，无法完成请求。建议：将 MusicFlow 部署于住宅/家宽网络，或在系统设置→网络代理配置可用代理后重试。该错误与二维码过期无关。");
      var bodyText = typeof res.body === "string" ? res.body : "";
      if (bodyText.indexOf('"code":500001') !== -1 || bodyText.indexOf('"code": 500001') !== -1) {
        throw errOf("NETWORK_RESTRICTED", "QQ 音乐登录服务对本服务器网络受限(风控拦截)，无法完成请求。建议：将 MusicFlow 部署于住宅/家宽网络，或在系统设置→网络代理配置可用代理后重试。该错误与二维码过期无关。");
      }
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

  /** 酷狗 web 签名 GET(login-user.kugou.com 直连,明文 JSON)。
   *  extraParams 与默认参数合并后整体参与签名(蓝本 request.js/defaultParams)。 */
  this.kugouWebGet = function (path, extraParams, appid) {
    var p = {
      dfid: "-", mid: KG_MID, uuid: "-",
      appid: appid || 1005, clientver: 20489,
      clienttime: Math.floor(Date.now() / 1000)
    };
    var k;
    for (k in (extraParams || {})) p[k] = extraParams[k];
    var flat = {};
    for (k in p) flat[k] = String(p[k]);
    var sig;
    try { sig = crypto.kgSignWeb(flat); } catch (e) {
      return Promise.reject(errOf("NETWORK", "酷狗签名失败: " + ((e && e.message) || e)));
    }
    p.signature = sig;
    var qs = [];
    for (k in p) qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(p[k]));
    var url = KG_QR_BASE + path + "?" + qs.join("&");
    return host.http(url, {
      method: "GET", timeout: 15000,
      headers: {
        "User-Agent": KG_UA, dfid: "-", clienttime: String(p.clienttime), mid: KG_MID,
        "kg-rc": "1", "kg-thash": "5d816a0", "kg-rec": "1",
        "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F"
      }
    }).then(function (res) {
      var json = null;
      try { json = JSON.parse(res.body); } catch (e) { json = null; }
      if (res.status !== 200 || !json) {
        throw errOf("UPSTREAM_ERROR", "酷狗响应异常(" + res.status + "): " + String(res.body || "").slice(0, 120));
      }
      return { json: json, status: res.status };
    }, function (e) {
      if (e && e.__err) throw e;
      throw errOf("NETWORK", "酷狗请求失败: " + ((e && e.message) || e));
    });
  };

  /** 酷狗 android 签名 POST(gateway.kugou.com + x-router,明文 JSON)。
   *  opts:{path, router, params?, data?(对象→JSON body), cred?(token/userid 注入默认参数) }。 */
  this.kugouPost = function (opts) {
    var cred = (opts && opts.cred) || {};
    var ct = Math.floor(Date.now() / 1000);
    var p = {
      dfid: "-", mid: KG_MID, uuid: "-", appid: 1005,
      clientver: 20489, clienttime: ct
    };
    if (cred.token) p.token = cred.token;
    if (cred.userid && String(cred.userid) !== "0") p.userid = String(cred.userid);
    var k;
    for (k in ((opts && opts.params) || {})) p[k] = opts.params[k];
    var dataText = (opts && opts.data && typeof opts.data === "object") ? JSON.stringify(opts.data) : String((opts && opts.data) || "");
    var flat = {};
    for (k in p) flat[k] = String(p[k]);
    var sig;
    try { sig = crypto.kgSignAndroid(flat, dataText); } catch (e) {
      return Promise.reject(errOf("NETWORK", "酷狗签名失败: " + ((e && e.message) || e)));
    }
    p.signature = sig;
    var qs = [];
    for (k in p) qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(p[k]));
    var url = KG_GATEWAY + ((opts && opts.path) || "") + "?" + qs.join("&");
    var headers = {
      "User-Agent": KG_UA, dfid: "-", clienttime: String(ct), mid: KG_MID,
      "kg-rc": "1", "kg-thash": "5d816a0", "kg-rec": "1",
      "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F"
    };
    if (opts && opts.router) headers["x-router"] = opts.router;
    if (dataText) headers["Content-Type"] = "application/json";
    return host.http(url, {
      method: "POST", timeout: 20000, headers: headers,
      body: dataText || ""
    }).then(function (res) {
      if (res.status === 403) throw errOf("NETWORK_RESTRICTED", "酷狗网关拒绝(403),当前网络可能受限");
      var json = null;
      try { json = JSON.parse(res.body); } catch (e) { json = null; }
      if (!json) {
        throw errOf("UPSTREAM_ERROR", "酷狗响应非 JSON(" + res.status + "): " + String(res.body || "").slice(0, 120));
      }
      var st = Number(json.status);
      var ec = json.error_code === undefined ? 0 : Number(json.error_code);
      if (st !== 1 || ec !== 0) {
        throw errOf("UPSTREAM_ERROR", "酷狗业务错误(status=" + json.status + ", error_code=" + json.error_code + "): " + String(json.error || json.errmsg || "").slice(0, 120));
      }
      return { json: json, status: res.status };
    }, function (e) {
      if (e && e.__err) throw e;
      throw errOf("NETWORK", "酷狗请求失败: " + ((e && e.message) || e));
    });
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
      probe(PLATFORMS.qq.apiBase + QQ_FCG_URL.replace(PLATFORMS.qq.apiBase, "")),
      probe(KG_QR_BASE + "/v2/qrcode")
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
    return utils_fp(cred && (cred.cookie || cred.musickey || cred.token || ""));
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
  /** 网易探针:明文端点(240 真机实证)。code:200 + account/profile 齐全=有效;
   *  code:200 + account:null 或缺 profile=明确未登录(旧凭据实证形态)→ AUTH_EXPIRED;
   *  网络/其他业务码 → 非 AUTH_EXPIRED 抛出(上层 status 判 valid=null)。 */
  function probeNetease(cred) {
    return host.http(NET_ACCOUNT_URL + "?csrf_token=", {
      method: "GET", timeout: 15000,
      headers: { "User-Agent": NET_UA, "Referer": "https://music.163.com", "Cookie": cred.cookie || "" }
    }).then(function (res) {
      var json = null;
      try { json = JSON.parse(res.body); } catch (e0) { json = null; }
      if (!json) throw { __err: true, code: "UPSTREAM_ERROR", message: "网易云探针异常(" + res.status + "): " + String(res.body || "").slice(0, 100) };
      var account = json.account || (json.data && json.data.account) || null;
      var profile = json.profile || (json.data && json.data.profile) || null;
      if (Number(json.code) === 200 && account && profile) {
        return { ok: true, account: { id: account.id || 0, nickname: String(profile.nickname || ""), avatarUrl: String(profile.avatarUrl || "") } };
      }
      if (Number(json.code) === 200) throw { __err: true, code: "AUTH_EXPIRED", message: "网易云凭据已失效，请在插件配置页重新扫码绑定" };
      throw { __err: true, code: "UPSTREAM_ERROR", message: "网易云探针业务错误(code " + json.code + ")" };
    }, function (e1) {
      if (e1 && e1.__err) throw e1;
      throw { __err: true, code: "NETWORK", message: "网易云探针网络失败: " + ((e1 && e1.message) || e1) };
    });
  }

  /** QQ 探针:fcg_user_created_diss(240 真机实证 code=0,昵称 data.hostname="Ray";
   *  旧 UserInfoService.GetUserBaseInfo 被模块级鉴权拒 500003)。
   *  code=0 → 有效;code!=0 → 明确失效(AUTH_EXPIRED);网络异常 → 非 AUTH_EXPIRED
   *  抛出(上层 status 判 valid=null 状态未知)。头像该端点无,保留存量不覆盖。 */
  function probeQQ(cred) {
    var numUin = String(cred.uin || cred.musicid || "").replace(/\D/g, "");
    var ip = rndChinaIP();
    return host.http(QQ_FCG_CREATED_DISS_URL + "?hostuin=" + encodeURIComponent(numUin) + "&sin=0&size=5&format=json&inCharset=utf8&outCharset=utf-8", {
      method: "GET", timeout: 15000,
      headers: {
        "User-Agent": QQ_FCG_UA, "Referer": "https://y.qq.com/", "Cookie": cred.cookie || "",
        "X-Forwarded-For": ip, "X-Real-IP": ip
      }
    }).then(function (res) {
      var json = null;
      try { json = JSON.parse(res.body); } catch (e0) { json = null; }
      if (json && Number(json.code) === 0) {
        var d = json.data || {};
        return { ok: true, account: { nickname: String(d.hostname || ""), avatarUrl: "" } };
      }
      throw { __err: true, code: "AUTH_EXPIRED", message: "QQ 凭据已失效，请在插件配置页重新扫码绑定" };
    }, function (e1) {
      if (e1 && e1.__err) throw e1;
      throw { __err: true, code: "NETWORK", message: "QQ 探针网络失败: " + ((e1 && e1.message) || e1) };
    });
  }

  /** 酷狗探针:cloudlist /v7/get_all_list(status===1 且无错误码才算有效)。 */
  function probeKugou(cred) {
    return upstream.kugouPost({
      path: "/v7/get_all_list",
      router: "cloudlist.service.kugou.com",
      params: { plat: 1 },
      data: {
        userid: Number(cred.userid) || 0,
        token: cred.token || "",
        total_ver: 979, type: 2, page: 1, pagesize: 30
      },
      cred: cred
    }).then(function (r) {
      var j = r.json || {};
      var ok = j.status === 1 && (j.error_code === undefined || Number(j.error_code) === 0);
      return { ok: !!ok, account: (j.data && j.data.info) || null };
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
    if (platform === "netease") return probeNetease(cred);
    if (platform === "kugou") return probeKugou(cred);
    return probeQQ(cred);
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
          return { ok: false, code: "AUTH_EXPIRED", message: "QQ 凭据已失效，请在插件配置页重新扫码绑定" };
        }, function (e) {
          return { ok: false, code: (e && e.code) || "AUTH_UNKNOWN", message: (e && e.message) || "鉴权未知" };
        });
      });
    }
    if (platform === "kugou") {
      return probeKugou(cred).then(function (p) {
        if (p.ok) return { ok: true, cred: cred };
        return { ok: false, code: "AUTH_EXPIRED", message: "酷狗凭据已失效，请在插件配置页重新扫码绑定" };
      }, function (e) {
        return { ok: false, code: (e && e.code) || "AUTH_UNKNOWN", message: (e && e.message) || "鉴权未知" };
      });
    }
    return probeNetease(cred).then(function (p) {
      // ⚠️ 成功回调必须返回 {ok,…}(eval.js:1884「cannot read property 'ok' of
      // undefined」根因:此回调曾为空体 → probe 成功即返回 undefined → runDailyJob 崩)。
      if (p && p.ok) return { ok: true, cred: cred };
      return { ok: false, code: (p && p.code) || "AUTH_EXPIRED", message: (p && p.message) || "网易云凭据已失效，请在插件配置页重新扫码绑定" };
    }, function (e) {
      return { ok: false, code: (e && e.code) || "AUTH_UNKNOWN", message: (e && e.message) || "鉴权未知" };
    });
  };
}

// ================ §6a QQ ptlogin2 / 酷狗 扫码协议(go/KuGouMusicApi 蓝本) ================

/** 手动逐跳跟随重定向(≤maxHops),沿途合并 Set-Cookie 进 jar。
 *  核心宿主 undici:redirect:"manual" 返回真实 302(实测),插件侧自行收链。
 *  返回 res 并附 res.url=最终请求地址(取 code 用)。 */
function httpFollow(host, url, init, jar, maxHops) {
  var remaining = maxHops || 10;
  function step(current, referer) {
    var headers = {};
    var src = (init && init.headers) || {};
    for (var k in src) headers[k] = src[k];
    var ck = utils_jarHeader(jar);
    if (ck) headers["Cookie"] = ck;
    if (referer) headers["Referer"] = referer;
    var i2 = {};
    for (var k2 in (init || {})) if (k2 !== "headers") i2[k2] = init[k2];
    i2.headers = headers;
    i2.redirect = "manual";
    return host.http(current, i2).then(function (res) {
      utils_parseCookies(res, jar);
      var loc = res.headers && (res.headers.location || res.headers.Location);
      if (loc && res.status >= 300 && res.status < 400 && remaining > 0) {
        remaining--;
        return step(utils_absUrl(current, loc), current);
      }
      res.url = current;
      return res;
    });
  }
  return step(url, "");
}

/** QQ ptlogin2 出码(go CreateQRLogin 逐参数对齐):
 *  xlogin 预热(容错) → ssl/ptqrshow PNG(latin1 通道→base64) + qrsig。
 *  返回 {imageDataUrl, qrsig, jar}。 */
function qqPtCreate(host) {
  var jar = {};
  return host.http(QQ_XLOGIN_URL, {
    method: "GET", redirect: "manual", timeout: 10000,
    headers: { "User-Agent": QQ_PT_UA }
  }).then(function (res) {
    utils_parseCookies(res, jar);
    return null;
  }, function () {
    return null; // 预热失败容错:无 pt_login_sig 多数场景仍可出码
  }).then(function () {
    var showUrl = QQ_QRSHOW_URL + (Date.now() / 1000).toFixed(6);
    // base64 通道:latin1 字节串含 NUL 会被沙箱桥截断(PNG 头即含 0x00)。
    return host.http(showUrl, {
      method: "GET", redirect: "manual", timeout: 15000, encoding: "base64",
      headers: { "User-Agent": QQ_PT_UA, Referer: "https://xui.ptlogin2.qq.com/", Cookie: utils_jarHeader(jar) }
    });
  }).then(function (res) {
    if (res.status === 403) throw { __err: true, code: "NETWORK_RESTRICTED", message: QQ_PT_RESTRICTED_MSG };
    utils_parseCookies(res, jar);
    var png = String(res.body || "");
    if (res.status !== 200 || png.length < 100) {
      throw { __err: true, code: "UPSTREAM_ERROR", message: "QQ ptqrshow 异常(" + res.status + "),base64长度=" + png.length };
    }
    var qrsig = jar["qrsig"] || "";
    if (!qrsig) throw { __err: true, code: "UPSTREAM_ERROR", message: "QQ ptqrshow 未返回 qrsig" };
    if (png.length < 100) throw { __err: true, code: "UPSTREAM_ERROR", message: "QQ ptqrshow 响应过短(" + png.length + ")" };
    return { imageDataUrl: "data:image/png;base64," + png, qrsig: qrsig, jar: jar };
  });
}

/** QQ 轮询(go CheckQRLogin 逐参数对齐):ptqrlogin → ptuiCB('code',…) 解析。
 *  0=确认(交 qqPtFinish 置链) / 65=过期 / 66=待扫 / 67=已扫待确认 / 68=拒绝。 */
function qqPtCheck(host, sess) {
  var jar = {};
  var sessJar = sess.jar || {};
  for (var jk in sessJar) jar[jk] = sessJar[jk];
  var p = {
    u1: QQ_OAUTH_LOGIN_JUMP,
    ptqrtoken: String(utils_hash33(sess.qrsig || "")),
    ptredirect: "0", h: "1", t: "1", g: "1", from_ui: "1", ptlang: "2052",
    action: "0-0-" + Date.now(),
    js_ver: "26071711", js_type: "1",
    login_sig: jar["pt_login_sig"] || "",
    pt_uistyle: "40", aid: "716027609", daid: "383",
    pt_3rd_aid: QQ_OAUTH_CLIENT_ID, pt_js_version: "c1987b96"
  };
  var qs = [];
  for (var k in p) qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(p[k]));
  // go 蓝本由 cookiejar 自动附带 pt_login_sig 等会话 cookie;缺 Cookie 头会 403 风控。
  return host.http(QQ_QRCHECK_URL + "?" + qs.join("&"), {
    method: "GET", redirect: "manual", timeout: 15000,
    headers: {
      "User-Agent": QQ_PT_UA, Referer: "https://xui.ptlogin2.qq.com/",
      Cookie: utils_jarHeader(jar)
    }
  }).then(function (res) {
    if (res.status === 403) throw { __err: true, code: "NETWORK_RESTRICTED", message: QQ_PT_RESTRICTED_MSG };
    utils_parseCookies(res, jar);
    var text = String(res.body || "");
    var m = text.match(/ptuiCB\('([^']*)','([^']*)','([^']*)','([^']*)','([^']*)'/);
    if (!m) throw { __err: true, code: "UPSTREAM_ERROR", message: "QQ ptqrlogin 响应无法解析: " + text.slice(0, 120) };
    var state = QQ_QR_STATE[Number(m[1])] || "waiting";
    var message = m[5];
    if (state === "confirmed") {
      if (!m[3]) throw { __err: true, code: "UPSTREAM_ERROR", message: "QQ 确认成功但未返回置链 URL" };
      return qqPtFinish(host, m[3], jar).then(function (cred) {
        return { code: 800, state: "confirmed", cred: cred };
      });
    }
    return {
      code: state === "scanned" ? 803 : (state === "expired" || state === "refused") ? 802 : 801,
      state: state === "refused" ? "expired" : state,
      message: message || ""
    };
  });
}

/** QQ 置链(go completeQQMusicLogin 逐参数对齐):
 *  ① check_sig 手动逐跳收 cookie 取 p_skey → ② oauth2.0/authorize POST
 *  (form:g_tk=gtk33(p_skey)/auth_time=ms/ui=uuid/openapi=1010_1030) →
 *  Location 取 code → ③ musicu.fcg QQLogin(明文 JSON)。 */
function qqPtFinish(host, redirectUrl, jar0) {
  var jar = {};
  for (var k0 in jar0) jar[k0] = jar0[k0];
  return httpFollow(host, redirectUrl, {
    method: "GET", timeout: 15000,
    headers: { "User-Agent": QQ_OAUTH_UA, Referer: "https://xui.ptlogin2.qq.com/" } // go 蓝本首跳 Referer;doQQRequest 口径 Chrome/126
  }, jar, 10).then(function (res) {
    if (res.status >= 400) throw { __err: true, code: "UPSTREAM_ERROR", message: "QQ check_sig 异常(" + res.status + ")" };
    var pskey = jar["p_skey"] || "";
    if (!pskey) throw { __err: true, code: "UPSTREAM_ERROR", message: "QQ 置链未取得 p_skey(jar keys: " + Object.keys(jar).join(",") + ")" };
    host.log("qqPtFinish: check_sig 完成, p_skey 已取得(" + pskey.length + " 字符)");
    var form = {
      response_type: "code",
      client_id: QQ_OAUTH_CLIENT_ID,
      redirect_uri: QQ_OAUTH_REDIRECT_URI,
      scope: QQ_OAUTH_SCOPE,
      state: "state",
      switch: "",
      from_ptlogin: "1",
      src: "1",
      update_auth: "1",
      openapi: "1010_1030",
      g_tk: String(utils_gtk33(pskey)),
      auth_time: String(Date.now()),
      ui: utils_uuid()
    };
    var parts = [];
    for (var f in form) parts.push(encodeURIComponent(f) + "=" + encodeURIComponent(form[f]));
    return host.http(QQ_OAUTH_AUTHORIZE_URL, {
      method: "POST", redirect: "manual", timeout: 15000,
      headers: {
        "User-Agent": QQ_OAUTH_UA, // doQQRequest 口径 Chrome/126
        "Accept": "*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://graph.qq.com",
        "Referer": QQ_OAUTH_LOGIN_JUMP,
        "Cookie": utils_jarHeader(jar) // go cookiejar 语义:全程携带(缺 p_skey 服务端拒)
      },
      body: parts.join("&")
    }).then(function (res2) {
      utils_parseCookies(res2, jar);
      var loc2 = res2.headers && (res2.headers.location || res2.headers.Location);
      if (!loc2) {
        throw { __err: true, code: "UPSTREAM_ERROR", message: "QQ authorize 未返回跳转(status=" + res2.status + "): " + String(res2.body || "").slice(0, 100) };
      }
      var finalUrl = utils_absUrl(QQ_OAUTH_AUTHORIZE_URL, loc2);
      var cm = String(finalUrl).match(/[?&]code=([^&#]+)/);
      if (!cm) throw { __err: true, code: "UPSTREAM_ERROR", message: "QQ authorize 跳转无 code: " + String(finalUrl).slice(0, 120) };
      host.log("qqPtFinish: authorize 完成, code 已取得");
      return qqPtLogin(host, jar, decodeURIComponent(cm[1]));
    });
  });
}

/** QQLogin musicu 明文 POST(go 蓝本) → 归一化凭据(缺 qm_keyst 即失败)。 */
function qqPtLogin(host, jar, code) {
  var body = JSON.stringify({
    comm: { g_tk: 5381, platform: "yqq", ct: 24, cv: 0 },
    req: { module: "QQConnectLogin.LoginServer", method: "QQLogin", param: { code: code } }
  });
  host.log("qqPtLogin: 请求 QQLogin code=" + code.slice(0, 6) + "... jar keys=[" + Object.keys(jar).join(",") + "]");
  return host.http(QQ_FCG_URL, {
    method: "POST", redirect: "manual", timeout: 20000,
    headers: {
      "User-Agent": QQ_OAUTH_UA, // doQQRequest 口径 Chrome/126
      "Accept": "*/*",
      "Content-Type": "application/json",
      "Referer": "https://y.qq.com/",
      "Origin": "https://y.qq.com",
      "Cookie": utils_jarHeader(jar)
    },
    body: body
  }).then(function (res) {
    utils_parseCookies(res, jar);
    var text = String(res.body || "");
    // 原始响应留痕(真机联调期必留:req.code/req.message 是唯一排查线索)。
    host.log("qqPtLogin: QQLogin 原始响应(" + res.status + "): " + text.slice(0, 600));
    var json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    if (res.status !== 200 || !json) {
      throw { __err: true, code: "UPSTREAM_ERROR", message: "QQLogin 异常(" + res.status + "): " + text.slice(0, 120) };
    }
    if (json.code !== 0 || (json.req && json.req.code !== 0)) {
      throw { __err: true, code: "UPSTREAM_ERROR", message: "QQLogin 业务错误(code " + json.code + "/req " + ((json.req && json.req.code) || "?") + "): " + ((json.req && (json.req.message || json.req.msg)) || json.message || json.msg || text.slice(0, 160)) };
    }
    var data = (json.req && json.req.data) || {};
    // go normalizeQQMusicCookies 口径:别名回填先行 —— data 可能只回 musickey/qqmusic_key
    // (music-lib 亦接受 p_skey/skey 兜底),全部为空才判失败。
    var qmKey = String(data.qm_keyst || data.qqmusic_key || data.musickey || data.music_key || jar["qm_keyst"] || jar["qqmusic_key"] || jar["musickey"] || jar["p_skey"] || jar["skey"] || "");
    if (!qmKey) throw { __err: true, code: "UPSTREAM_ERROR", message: "QQLogin 未返回 qm_keyst(登录失败,data keys=[" + Object.keys(data).join(",") + "])" };
    data.qm_keyst = data.qm_keyst || qmKey;
    // 归一化(go normalizeQQMusicCookies + qqWXLoginDataCookies):uin 回退链 +
    // qm_keyst/qqmusic_key 互通 + 登录响应数据回填 cookie(后续 musicu 请求要带)。
    var uin = String(data.musicid || data.musicId || data.userid || data.uin || jar["uin"] || jar["ptui_loginuin"] || jar["luin"] || "");
    if (!jar["uin"]) jar["uin"] = uin;
    if (!jar["musicid"]) jar["musicid"] = uin;
    if (!jar["qm_keyst"]) jar["qm_keyst"] = qmKey;
    if (!jar["musickey"] && (data.musickey || data.music_key)) jar["musickey"] = data.musickey || data.music_key;
    if (!jar["qqmusic_key"]) jar["qqmusic_key"] = qmKey;
    // 昵称/头像:QQLogin data.nick/logo 实测恒空(240 真机原始响应 nick:""/logo:"")。
    // 昵称从 ptlogin ptnick_<uin> cookie 解码(hex 编码 UTF-8,如 526179→Ray);
    // 头像用 qlogo QQ 号兜底(状态块直显 URL,无需服务端拉取)。都拿不到留空。
    var nick = String(data.nickname || data.nick || "").trim();
    if (!nick) {
      var ptnickHex = jar["ptnick_" + uin] || "";
      if (ptnickHex && /^[0-9a-fA-F]{2,}$/.test(ptnickHex) && ptnickHex.length % 2 === 0) {
        try {
          var hexBytes = "";
          for (var hx = 0; hx < ptnickHex.length; hx += 2) hexBytes += String.fromCharCode(parseInt(ptnickHex.substr(hx, 2), 16));
          nick = String(host.crypto.utf8Decode(hexBytes) || "").trim();
        } catch (e2) { nick = ""; }
      }
    }
    var avatar = String(data.avatar || data.logo || "").trim();
    if (!avatar && uin) avatar = "https://q1.qlogo.cn/g?b=qq&nk=" + uin + "&s=100";
    host.log("qqPtLogin: QQLogin 成功, qm_keyst 已取得(指纹 " + utils_fp(qmKey) + ", uin=" + utils_fp(uin) + ", nick=" + (nick ? "已取得" : "空") + ")");
    return {
      cookie: utils_jarHeader(jar),
      musickey: data.musickey || data.music_key || qmKey,
      refreshKey: data.refresh_token || "", // QQLogin 实际字段是 refresh_token(旧 refresh_key 恒空)
      uin: uin,
      nickname: nick,
      avatarUrl: avatar,
      expiresAt: Date.now() + PLATFORMS.qq.credTtlSec * 1000
    };
  });
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
        // go CreateQRLogin:form type:3(unikey 在顶层;weapi+type:1 通道已弃,见 §2 说明)。
        return upstream.neteaseFormPost(NET_QR_KEY_URL, { type: 3 }).then(function (r) {
          var data = (r.json && (r.json.unikey ? r.json : (r.json.data || r.json))) || {};
          var unikey = data.unikey || data.codekey || "";
          if (!unikey) throw { __err: true, code: "UPSTREAM_ERROR", message: "网易云未返回 unikey" };
          var sessionKey = utils_randToken(24);
          return host.storage.set(SKEY(sessionKey), {
            platform: platform, key: unikey, createdAt: Date.now(),
            expiresAt: Date.now() + def.qrTtlSec * 1000
          }).then(function () {
            return {
              kind: "url", // 由核心归一化成二维码 data URL(§14.1b)
              platform: platform,
              value: def.qrUrlTpl.replace("{key}", encodeURIComponent(unikey)),
              ttlSec: def.qrTtlSec,
              pollIntervalMs: def.pollIntervalMs,
              sessionKey: sessionKey
            };
          });
        });
      }
      // QQ:ptlogin2 通道(§6a,go-music-dl 蓝本)——直出 PNG dataURL → kind:'image'。
      if (platform === "qq") {
        return qqPtCreate(host).then(function (out) {
          var sessionKey = utils_randToken(24);
          return host.storage.set(SKEY(sessionKey), {
            platform: "qq", qrsig: out.qrsig, jar: out.jar,
            createdAt: Date.now(), expiresAt: Date.now() + def.qrTtlSec * 1000
          }).then(function () {
            return {
              platform: platform,
              kind: "image",
              value: out.imageDataUrl,
              ttlSec: def.qrTtlSec,
              pollIntervalMs: def.pollIntervalMs,
              sessionKey: sessionKey
            };
          });
        });
      }
      // 酷狗:web 签名出码(data.qrcode key + data.qrcode_img 官方 PNG dataURL)。
      return upstream.kugouWebGet("/v2/qrcode", {
        type: 1, plat: 4,
        qrcode_txt: "https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&",
        srcappid: 2919
      }, 1001).then(function (r) {
        var data = (r.json && r.json.data) || {};
        var key = data.qrcode || "";
        if (!key) throw { __err: true, code: "UPSTREAM_ERROR", message: "酷狗未返回 qrcode key: " + JSON.stringify(r.json).slice(0, 120) };
        var sessionKey = utils_randToken(24);
        return host.storage.set(SKEY(sessionKey), {
          platform: platform, key: key,
          createdAt: Date.now(), expiresAt: Date.now() + def.qrTtlSec * 1000
        }).then(function () {
          var img = data.qrcode_img || "";
          if (img) {
            return {
              platform: platform,
              kind: "image",
              value: String(img).indexOf("data:image") === 0 ? img : "data:image/png;base64," + img,
              ttlSec: def.qrTtlSec,
              pollIntervalMs: def.pollIntervalMs,
              sessionKey: sessionKey
            };
          }
          return {
            platform: platform,
            kind: "url",
            value: def.qrUrlTpl.replace("{key}", encodeURIComponent(key)),
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
    var polledPlatform = "?"; // 外层错误日志用(sess 在内层闭包)
    if (!sessionKey) return Promise.resolve({ code: 802, state: "expired", message: "缺少 sessionKey" });
    return host.storage.get(SKEY(sessionKey)).then(function (sess) {
      if (!sess) return { code: 802, state: "expired", message: "会话不存在或已清理" };
      polledPlatform = sess.platform;
      if (Date.now() > sess.expiresAt) return { code: 802, state: "expired", message: "二维码已过期,请刷新" };
      var def = PLATFORMS[sess.platform];
      if (sess.platform === "netease") {
        // go CheckQRLogin:form {key,type:3} 直连 client/login(不再探测 weapi 路由)。
        return upstream.neteaseFormPost(NET_QR_CHECK_URL, { key: sess.key, type: 3 }).then(function (r) {
          var code = r.json && r.json.code;
          // 8821=二维码已被使用/失效(真过期语义):与 800 同收口,停轮询出刷新按钮,
          // 不静默 801 循环(T04c 决议保留;确认后误报 8821 的根因 weapi 通道已随 form+type:3 消除)。
          if (code === 8821) {
            return { code: 802, state: "expired", message: "二维码已失效或已被使用，请刷新后重新扫码" };
          }
          var state = NET_QR_STATE[code] || "waiting";
          if (code === 803 || state === "confirmed") {
            return finalizeNetease(sessionKey, sess, r);
          }
          return { code: state === "scanned" ? 803 : state === "expired" ? 802 : 801, state: state };
        });
      }
      // QQ:ptlogin2 通道轮询(§6a)
      if (sess.platform === "qq") {
        return qqPtCheck(host, sess).then(function (out) {
          if (out.state !== "confirmed") return out;
          return host.storage.delete(SKEY(sessionKey)).then(function () {
            return store.save("qq", out.cred).then(function () {
              host.log("pollBind[qq] 绑定成功,凭据指纹=" + store.fingerprint(out.cred));
              return { code: 800, state: "confirmed", account: { nickname: out.cred.nickname, avatarUrl: out.cred.avatarUrl } };
            });
          });
        });
      }
      // 酷狗:web 签名轮询(data.status:0 过期/1 待扫/2 待确认/4 成功带 token)
      return upstream.kugouWebGet("/v2/get_userinfo_qrcode", { plat: 4, srcappid: 2919, qrcode: sess.key }, 1005).then(function (r) {
        var data = (r.json && r.json.data) || {};
        var state = KG_QR_STATE[Number(data.status)] || "waiting";
        if (state !== "confirmed") {
          return { code: state === "scanned" ? 803 : state === "expired" ? 802 : 801, state: state };
        }
        if (!data.token) throw { __err: true, code: "UPSTREAM_ERROR", message: "酷狗确认成功但未返回 token" };
        var cred = {
          token: String(data.token), userid: String(data.userid || ""),
          nickname: data.nickname || data.nickname2 || "", avatarUrl: data.avatar || data.imgpath || "",
          expiresAt: 0 // 运行时探测定性(禁预设 TTL)
        };
        return host.storage.delete(SKEY(sessionKey)).then(function () {
          return store.save("kugou", cred).then(function () {
            host.log("pollBind[kugou] 绑定成功,凭据指纹=" + store.fingerprint(cred));
            return { code: 800, state: "confirmed", account: { nickname: cred.nickname, avatarUrl: cred.avatarUrl } };
          });
        });
      });
    }).then(function (out) { return out; }, function (e) {
      // 二维码失效类错误(QR_EXPIRED/8821):按过期收口,弹窗停轮询出刷新按钮,
      // 避免静默 801 循环 + 错误红字一直转圈(240 真机:确认后 8821 不收敛)。
      if (e && e.code === "QR_EXPIRED") {
        host.log("pollBind[" + polledPlatform + "] 二维码失效: " + (e.message || ""));
        return { code: 802, state: "expired", message: e.message || "" };
      }
      var msg = "轮询失败: " + ((e && (e.message || e.code)) || e);
      // 诊断日志:真机联调期 pollBind 失败必须留痕(此前静默,240 三 bug 无从排查)。
      host.log("pollBind[" + polledPlatform + "] 失败: " + msg);
      return { code: 801, state: "error", message: msg };
    });
  };

  function finalizeNetease(sessionKey, sess, checkRes) {
    var def = PLATFORMS.netease;
    // go 口径 body cookie 优先 —— 但 240 真机实测:body cookie 只有 MUSIC_A_T(反馈路径
    // cookie),真会话 MUSIC_U 在 Set-Cookie 头。改取并集:全部 Set-Cookie 条目(核心
    // setCookieList 数组优先)打底,body cookie 叠加(同名以 body 为准)。
    var jar = {};
    var entries = utils_splitSetCookie(checkRes.setCookieList || checkRes.setCookie || "");
    for (var ei = 0; ei < entries.length; ei++) utils_mergeCookieEntry(entries[ei], jar);
    var bodyCk = String((checkRes.json && checkRes.json.cookie) || "");
    var bodySegs = bodyCk ? bodyCk.split(";") : [];
    for (var bi = 0; bi < bodySegs.length; bi++) utils_mergeCookieEntry(bodySegs[bi], jar);
    var cparts = [];
    for (var jk in jar) if (Object.prototype.hasOwnProperty.call(jar, jk)) cparts.push(jk + "=" + jar[jk]);
    var cookie = cparts.join("; ");
    if (!jar["MUSIC_U"]) {
      host.log("finalizeNetease: 警告 — Set-Cookie/body 均未取得 MUSIC_U(jar keys: " + Object.keys(jar).join(",") + ")");
    } else {
      host.log("finalizeNetease: MUSIC_U 已取得(指纹 " + utils_fp(jar["MUSIC_U"]) + ")");
    }
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
      // 探针失败仍按确认处理(并集 cookie 已到手,运行时检测下次 runDailyJob 会定性)
      var cred = { cookie: cookie, uin: 0, nickname: "", avatarUrl: "", expiresAt: 0 };
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
        // upsert(带 name/平台徽标)而非 replaceEntries:后者对不存在歌单落宿主
        // 中性缺省名 —— 首跑三个历史歌单被建成「ListenBrainz 推荐」的根因;
        // upsert 每次刷新都带名字,存量错误名也会被自动纠正。
        return host.playlists.upsert(def.historyId, {
          name: def.label + " 历史日推",
          description: "由 daily-rec-platform 插件维护:" + def.label + "最近 " + lastNDays + " 天每日推荐并集去重(新→旧滚动更新)。",
          sourcePlatform: platform,
          sourceUrl: def.homeUrl,
          entries: union
        }).then(function () {
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
  name: "QQ音乐，网易云音乐账号每日推荐",
  version: "1.1.0",
  type: "recommender",
  description: "拉取网易云音乐、QQ 音乐与酷狗音乐的「每日推荐」，经库内严格匹配后产出每平台 2 张歌单（今日带日期 + 近 7 天历史滚动并集）。支持扫码登录绑定账号（网易云二维码 URL + QQ/酷狗官方二维码图），凭据只存宿主 host.storage、日志仅指纹。选源强制门禁：本地匹配(host.songs.match)未命中才走跨插件在线源补全（透传 album+duration），绝不自行拼接在线播放 URL。",
  capabilities: ["qrLogin", "search", "recommendPlaylist"],
  minAppVersion: "4.3.2",
  longRunning: { runDailyJob: 300000 },
  permissions: ["net", "storage", "crypto", "songs:read", "songs:write", "playlists:read", "playlists:write", "inter-plugin"],
  defaultEnabled: false,
  author: "ray5378",
  homepage: "https://github.com/ray5378/MusicFlow-plugins",
  downloadUrl: "https://github.com/ray5378/MusicFlow-plugins/releases/download/daily-rec-platform-v1.1.0/daily-rec-platform.tar.gz",
  configSchema: [
    {
      "key": "bindNetease",
      "label": "绑定网易云音乐账号",
      "type": "action",
      "action": "startBind",
      "args": { "platform": "netease" },
      "group": "bind",
      "help": "点击后弹出网易云登录二维码，手机扫码确认后自动绑定；弹窗会显示当前绑定状态。"
    },
    {
      "key": "bindQQ",
      "label": "绑定QQ音乐账号",
      "type": "action",
      "action": "startBind",
      "args": { "platform": "qq" },
      "group": "bind",
      "help": "点击后弹出 QQ 音乐登录二维码，手机扫码确认后自动绑定；弹窗会显示当前绑定状态。"
    },
    {
      "key": "bindKugou",
      "label": "绑定酷狗音乐账号",
      "type": "action",
      "action": "startBind",
      "args": { "platform": "kugou" },
      "group": "bind",
      "help": "点击后弹出酷狗登录二维码，手机扫码确认后自动绑定；弹窗会显示当前绑定状态。"
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
  documentation: "### 功能介绍\n拉取网易云音乐与 QQ 音乐的「每日推荐」，匹配本地音乐库后产出歌单：\n- 今日歌单：`网易云音乐/QQ音乐 每日推荐 <日期>`（每天新建带日期 id）\n- 历史日推：最近 7 天并集去重（新→旧），昨日今日歌单并入历史后删除\n\n### 扫码登录\n在插件配置页点「绑定网易云音乐账号」「绑定QQ音乐账号」「绑定酷狗音乐账号」分别弹出对应平台的二维码（网易云为登录链接由服务端渲染成二维码，QQ/酷狗为官方二维码图）。扫码确认后凭据加密存于 MusicFlow 本机（host.storage），日志只显示指纹（前 6 位+长度），解绑即删。不提供密码登录。\n\n### 选源与门禁\n三级全部强制门禁：① 本地库匹配（host.songs.match，歌名/歌手/时长/专辑四维评分）→ ② WebDAV 同源 → ③（可选，默认关）跨插件在线源补全，调用时透传专辑与时长供宿主四维核实。本插件绝不自行拼接在线播放 URL。\n\n### 隐私与合规\n仅供个人自用；本插件直连平台官方接口，无任何外部中转服务。凭据只保存在你自己的 MusicFlow 实例中。",
  i18n: {
    en: {
      name: "Daily Recommendations (QQ/NetEase/KuGou)",
      description: "Fetches personal Daily Recommendations from NetEase Cloud Music, QQ Music and KuGou Music, matches them strictly against the local library, and produces 2 playlists per platform (dated daily + rolling 7-day history). Supports QR-code login binding; credentials stay in host.storage with fingerprint-only logs. Source selection enforces the library-match gate before optional cross-plugin online completion (album+duration passed through); never builds online stream URLs itself.",
      groups: { bind: "Account Binding", match: "Matching" },
      fields: {
        bindNetease: {
          label: "Bind NetEase Cloud Music account",
          help: "Click to open the NetEase login QR code; scan and confirm to bind. The dialog shows the current binding status."
        },
        bindQQ: {
          label: "Bind QQ Music account",
          help: "Click to open the QQ Music login QR code; scan and confirm to bind. The dialog shows the current binding status."
        },
        bindKugou: {
          label: "Bind KuGou Music account",
          help: "Click to open the KuGou login QR code; scan and confirm to bind. The dialog shows the current binding status."
        },
        l2Enabled: {
          label: "Online completion for unmatched",
          help: "Try cross-plugin online sources for unmatched songs (requires at least one enabled source plugin; verified by the album+duration gate). When off, external placeholder entries are written and the backend auto-match takes over."
        }
      },
      documentation: "### Features\nFetches personal Daily Recommendations from NetEase Cloud Music / QQ Music / KuGou Music and produces playlists after strict local-library matching:\n- Daily playlist: `<Platform> Daily Recommendations <date>` (new dated id every day)\n- History: union of the last 7 days, deduplicated (newest first); yesterday's daily playlist is merged into history then deleted\n\n### QR Login\nClick 'Bind account' in the plugin config: NetEase shows a login URL rendered as a QR by the server; QQ Music and KuGou Music show the official QR image. Credentials are stored encrypted on your own MusicFlow instance (host.storage); logs show fingerprints only (first 6 chars + length). Password login is not supported.\n\n### Source gating\nAll three tiers enforce gates: ① local library match (host.songs.match, title/artist/duration/album scoring) → ② WebDAV → ③ (optional, off by default) cross-plugin online completion passing album + duration for the host-side four-dimension verification. This plugin never builds online stream URLs itself.\n\n### Privacy\nFor personal use only; connects directly to the official platform APIs with no external relay service. Credentials never leave your MusicFlow instance."
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
        return t && (t.id || t.mid || t.songId || t.songmid || t.mixsongid || t.songid) && (t.name || t.title || t.songName || t.songname || t.ori_audio_name);
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
        } else if (platform === "kugou") {
          // 酷狗 everyday_song_recommend 字段形态(蓝本实测)。
          id = t.mixsongid || t.songid || t.id;
          title = t.songname || t.ori_audio_name || t.name || "";
          var kSingers = t.singerinfo || [];
          artist = Array.isArray(kSingers) && kSingers.length
            ? kSingers.map(function (x) { return x.name; }).join("/")
            : String(t.author_name || "");
          album = t.album_name || (t.albuminfo && t.albuminfo.name) || "";
          durationMs = t.climax_timelength || t.duration || 0;
          cover = t.cover || t.sizable_cover || (t.trans_param && t.trans_param.cover) || "";
        } else {
          id = t.mid || t.songmid || t.id;
          title = t.name || t.title || t.songName || t.songname || "";
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
      if (platform === "kugou") {
        // 酷狗日推:everyday_song_recommend(android 签名,gateway + x-router)。
        return upstream.kugouPost({
          path: "/everyday_song_recommend", router: "everydayrec.service.kugou.com",
          params: { platform: "ios" }, cred: cred
        }).then(function (r) { return rowsFrom(platform, pickSongList(r.json, platform)); });
      }
      // QQ:两步链(240 真机实证,lead 2026-10-09):
      // ① RecommendFeed.get_recommend_feed 明文 musicu → v_shelf[].v_niche[].v_card[]
      //    找 card.title 含「每日30首」→ tid = card.id(实证字段就是 id,字符串);
      // ② fcg_ucc_getcdinfo_byids_cp.fcg → cdlist[0].songlist → 既有选源入库不变。
      var numUin = Number(String(cred.uin || cred.musicid || "").replace(/\D/g, "")) || 0;
      var fip = rndChinaIP();
      return host.http(QQ_FCG_URL, {
        method: "POST", timeout: 15000,
        headers: {
          "Content-Type": "application/json", "User-Agent": QQ_FCG_UA,
          "Referer": "https://y.qq.com/", "Cookie": cred.cookie || "",
          "X-Forwarded-For": fip, "X-Real-IP": fip
        },
        body: JSON.stringify({
          comm: { ct: 24, cv: 0, uin: numUin },
          req_0: { module: "music.recommend.RecommendFeed", method: "get_recommend_feed", param: {} }
        })
      }).then(function (res) {
        var json = null;
        try { json = JSON.parse(res.body); } catch (e0) { json = null; }
        var data = (json && json.req_0 && json.req_0.data) || {};
        var shelves = data.v_shelf || [];
        var tid = "";
        for (var si = 0; si < shelves.length && !tid; si++) {
          var niches = (shelves[si] && shelves[si].v_niche) || [];
          for (var ni = 0; ni < niches.length && !tid; ni++) {
            var cards = (niches[ni] && niches[ni].v_card) || [];
            for (var ci = 0; ci < cards.length; ci++) {
              var card = cards[ci] || {};
              if (String(card.title || "").indexOf("每日30首") !== -1 && card.id) { tid = String(card.id); break; }
            }
          }
        }
        if (!tid) throw { __err: true, code: "UPSTREAM_ERROR", message: "QQ 日推 feed 未找到每日30首卡片" };
        var qs = [];
        var qp = { type: 1, json: 1, utf8: 1, onlysong: 0, disstid: tid, format: "json", g_tk: 5381, loginUin: 0, hostUin: 0, inCharset: "utf8", outCharset: "utf-8", notice: 0, platform: "yqq", needNewCode: 0 };
        for (var pk in qp) qs.push(encodeURIComponent(pk) + "=" + encodeURIComponent(qp[pk]));
        var bip = rndChinaIP();
        return host.http(QQ_FCG_CDINFO_URL + "?" + qs.join("&"), {
          method: "GET", timeout: 15000,
          headers: {
            "User-Agent": QQ_FCG_UA, "Referer": "https://y.qq.com/", "Cookie": cred.cookie || "",
            "X-Forwarded-For": bip, "X-Real-IP": bip
          }
        }).then(function (res2) {
          var text = String(res2.body || "").trim();
          // jsonp 剥壳只对「非 { 开头」的响应生效:纯 JSON 歌名含括号(如「(Live)」)会骗过
          // 「首个 ( 到末个 )」切割 —— 240 真机实锤(subcode=?/songlist=0)。蓝本守卫=以 ) 结尾。
          var json2 = null;
          try {
            if (text.charAt(0) === "{") json2 = JSON.parse(text);
            else {
              var lp = text.indexOf("("), rp = text.lastIndexOf(")");
              if (lp !== -1 && rp > lp) json2 = JSON.parse(text.slice(lp + 1, rp));
            }
          } catch (e1) { json2 = null; }
          var cd = (json2 && json2.cdlist && json2.cdlist[0]) || null;
          var badSub = json2 && json2.subcode !== undefined && Number(json2.subcode) !== 0;
          if (!json2 || badSub || !cd || !cd.songlist || !cd.songlist.length) {
            throw { __err: true, code: "UPSTREAM_ERROR", message: "QQ 日推歌单详情异常(subcode=" + ((json2 && json2.subcode) || "?") + ", songlist=" + ((cd && cd.songlist && cd.songlist.length) || 0) + ")" };
          }
          return rowsFrom(platform, cd.songlist);
        });
      });
    }

    var impl = {
      // ---- qrLogin 三方法(主仓 CAP_METHODS.qrLogin / QR_ACTION_METHODS 白名单) ----
      // startBind:出码后附加绑定状态回显(boundAccount/authValid)。
      //   - 未绑定 → boundAccount=null(前端不渲染状态行);
      //   - 探测通过 → authValid=true(昵称优先取探针新值,回落存量凭据);
      //   - 探测判定失效 → authValid=false(明确提示重新绑定);
      //   - 探测网络失败 ≠ 凭据失效 → authValid=null(前端只显示名字不给判定)。
      //   探测不阻塞出码语义:任何探测异常都吞掉,二维码照常返回。
      startBind: function (params) {
        return qr.startBind(params || {}).then(function (payload) {
          var plat = payload.platform || (params && params.platform) || (host.config && host.config.bindPlatform) || "netease";
          return store.get(plat).then(function (cred) {
            if (!cred) { payload.boundAccount = null; payload.authValid = null; return payload; }
            var base = { nickname: cred.nickname || "", avatarUrl: cred.avatarUrl || "" };
            return guard.probe(plat, cred).then(function (p) {
              if (p && p.ok) {
                var acc = p.account || {};
                var nick = acc.nickname || (acc.profile && acc.profile.nickname) || acc.nick || base.nickname;
                payload.boundAccount = { nickname: nick || "", avatarUrl: base.avatarUrl || "" };
                payload.authValid = true;
              } else {
                // 非明确失效码一律「状态未知」(与 status() 同口径,探测 ok=false 不判死)。
                payload.boundAccount = base;
                payload.authValid = null;
              }
              return payload;
            }, function () {
              payload.boundAccount = base;
              payload.authValid = null;
              return payload;
            });
          });
        });
      },
      pollBind: function (params) { return qr.pollBind(params || {}); },
      cancelBind: function (params) { return qr.cancelBind(params || {}); },

      // ---- status:配置页常驻绑定状态块(v4.3.2) ----
      // 逐平台探测存量凭据(复用 SessionGuard 探针,并行);绝不抛错;
      // 探测网络失败 ≠ 凭据失效 → valid:null(前端显示「状态未知」)。
      status: function () {
        var platforms = {};
        var jobs = [];
        for (var i = 0; i < PLATFORM_ORDER.length; i++) {
          (function (plat) {
            jobs.push(store.get(plat).then(function (cred) {
              if (!cred) {
                platforms[plat] = { bound: false, label: PLATFORMS[plat].label, nickname: "", avatarUrl: "", valid: null };
                return;
              }
              var base = { bound: true, label: PLATFORMS[plat].label, nickname: cred.nickname || "", avatarUrl: cred.avatarUrl || "", valid: null };
              return guard.probe(plat, cred).then(function (p) {
                if (p && p.ok) {
                  base.valid = true;
                  var acc = p.account || {};
                  base.nickname = acc.nickname || (acc.profile && acc.profile.nickname) || acc.nick || base.nickname;
                } else {
                  // 探测未确认(非明确失效码):valid=null 状态未知,不误报失效(T05 收紧)。
                  base.valid = null;
                  host.log("status[" + plat + "] 探测未确认: " + String((p && (p.reason || p.code)) || "ok=false").slice(0, 120));
                }
                platforms[plat] = base;
              }, function (e) {
                // 只有平台业务码明确「未登录/过期」才判失效;网络/风控错误=状态未知。
                base.valid = (e && e.code === "AUTH_EXPIRED") ? false : null;
                host.log("status[" + plat + "] 探测失败(" + ((e && e.code) || "?") + "): " + String((e && e.message) || e).slice(0, 160));
                platforms[plat] = base;
              });
            }, function () {
              platforms[plat] = { bound: false, label: PLATFORMS[plat].label, nickname: "", avatarUrl: "", valid: null };
            }));
          })(PLATFORM_ORDER[i]);
        }
        return Promise.all(jobs).then(function () { return { platforms: platforms }; }, function () { return { platforms: platforms }; });
      },

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
            return { ok: true, message: "尚未绑定任何平台。请在插件配置页点「绑定网易云音乐账号」「绑定QQ音乐账号」「绑定酷狗音乐账号」分别扫码绑定;绑定后每日刷新会自动产出歌单。" };
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
        var attempted = 0;   // 进入凭据校验的平台数(已绑定且当日未完成)
        var authFailed = 0;  // 其中凭据失效数

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
                  attempted++;
                  return guard.ensureValid(platform, cred).then(function (g) {
                    if (!g || !g.ok) {
                      authFailed++;
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
              }).then(null, function (e) {
                // 平台级隔离:单平台任何未捕获失败(探测网络错/管线异常/host.http 异常)
                // 只记日志,不中断其余平台(240 真机:一平台失败拖垮整个 job,仅酷狗出歌单)。
                host.log("runDailyJob[" + platform + "] 失败: " + ((e && (e.message || e.code)) || e));
                lines.push(platform + ": 失败 — " + ((e && (e.message || e.code)) || e));
              });
            });
          })(PLATFORM_ORDER[pi]);
        }

        return chain.then(function () {
          if (!anyJob) return null; // 未绑定任何平台:core 层面无事可做
          // 全部已尝试平台都因凭据失效告终 → 抛错(job.status=error,手动刷新路径
          // 管理员直接看到重绑提示);部分成功仍走 summary 汇报逐平台明细。
          if (attempted > 0 && authFailed === attempted) {
            throw new Error("账号凭据已失效，请在插件配置页重新扫码绑定。详情:\n" + lines.join("\n"));
          }
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
