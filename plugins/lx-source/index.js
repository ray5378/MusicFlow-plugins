// ============================================================================
//  MusicFlow 外置插件：洛雪(lx)音源内联运行时  v1.0.1
// ----------------------------------------------------------------------------
//  能力：把你自己的洛雪音乐(LX Music)音源 .js 直接放进 MusicFlow 沙箱执行，
//        自动解析 @name/@version/@author 头并注册成可用音源。
//
//  不需要洛雪客户端，不需要洛雪服务端，也不需要 baseUrl 指向任何外部服务。
//
//  洛雪协议(230 上 40 个真实音源实证)：
//    - 音源只依赖宿主注入的 globalThis.lx(require/module.exports 实测 0 命中)；
//    - request 事件载荷信封 {action, source, info}：
//        musicSearch/search : info={keyword,page,pagesize} -> {isEnd,list,total}
//        musicUrl           : info={type:音质, musicInfo}   -> URL 字符串
//        lyric              : info={musicInfo}              -> {lyric}
//        pic                : info={musicInfo}              -> URL 字符串
//    - 实测 actions 分布：musicUrl 23/40、musicSearch+musicUrl+lyric 2/40、
//      musicUrl+search 2/40 —— 搜索不是普遍能力，插件按 sources[].actions
//      声明探测，未声明的能力直接明确告知，不静默。
//
//  失效自动切换(两层)：
//    层1(插件内)：withFallback 对已配置的多音源按序轮切，报错/空结果都切下一个，
//                 回退轨迹写入返回 message；
//    层2(插件外)：本插件整体不可用时，核心 streamFallback 链自动改用 go-music-dl
//                 等其它已启用 source 插件(resolveStreamProvider)。
//
//  失败可见(不静默)：下载失败/语法错/顶层抛错/未注册/取链 403/超时，
//  都在返回值 message 与日志里给出原文与位置。
// ============================================================================

globalThis.__mfPlugin = {
  manifest: {
    id: "lx-source",
    name: "洛雪音源",
    version: "1.0.4",
    type: "source",
    description:
      "洛雪(LX Music)音源内联运行时:把你自己的洛雪音源 .js 直接放进 MusicFlow 沙箱执行,自动解析" +
      "@name/@version/@author 头并注册成可用音源,提供取链播放 / 搜索(音源支持时) / 歌词 / 封面。" +
      "不需要洛雪服务端,也不需要指向任何外部服务地址。某个音源失效会自动回退到其它已配置音源," +
      "本插件整体不可用时核心会自动回退到其它已启用 source 插件。" +
      "注意:本插件会在你的 MusicFlow 服务进程内执行第三方音源脚本,等价于运行不是你写的程序,请只添加你信任的音源;默认不启用。",
    capabilities: [
      "search",
      "songSearch",
      "albumSearch",
      "playlistSearch",
      "playlistSongs",
      "recommend",
      "stream",
      "webRotation",
      "lyricProvider",
      "coverProvider",
    ],
    platforms: ["kw", "kg", "tx", "wy", "mg", "bilibili", "other"],
    platformLabels: { kw: "酷我", kg: "酷狗", tx: "企鹅音乐", wy: "网易云", mg: "咪咕", bilibili: "哔哩哔哩", other: "其它" },
    sourcePreference: ["wy", "kg", "kw", "tx"],
    recommendPrefix: "lx://recommend/",
    defaultEnabled: false,
    minAppVersion: "1.7.39",
    longRunning: {
      health: 30000,
      searchSongs: 30000,
      searchPlaylists: 20000,
      searchAlbums: 20000,
      playlistSongs: 45000,
      recommend: 60000,
      recommendPlaylist: 30000,
      // test 要遍历配置里的全部音源并逐个加载(下载 + 沙箱执行),故给足 5 分钟预算。
      test: 300000,
    },
    permissions: ["net", "fs", "storage", "log", "jsenv", "songs:read", "songs:write"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl: "https://github.com/ray5378/MusicFlow-plugins/releases/download/lx-source-v1.0.4/lx-source.tar.gz",
    configSchema: [
      {
        key: "sources",
        label: "音源列表",
        type: "text-list",
        default: [],
        required: true,
        help:
          "一行一个洛雪音源(点 + 添加行、✕ 删除行),每行支持三种写法:\n" +
          "1) .js 文件 URL,如 https://raw.githubusercontent.com/.../latest.js\n" +
          "2) 本地文件名(放在「音源文件目录」下,支持子目录),如 huibq/latest.js\n" +
          "3) 「显示名=文件名或URL」。\n" +
          "所有加入的行都会生效;插件不预置任何音源内容,第三方音源由你自己添加并承担风险。",
      },
      {
        key: "sourceDir",
        label: "音源文件目录",
        type: "text",
        default: "lx-sources",
        help: "本地 .js 音源的根目录(插件相对目录,如 lx-sources);列表里写绝对路径时忽略本项",
      },
      {
        key: "quality",
        label: "音质",
        type: "multiselect",
        options: [
          { value: "128k", label: "标准 128k" },
          { value: "320k", label: "较高 320k" },
          { value: "flac", label: "无损 flac" },
          { value: "flac24bit", label: "Hi-Res flac24bit" },
        ],
        default: ["320k"],
        help: "取播放链接时请求的音质档(洛雪标准档位);音源不支持该档时会明确报错并自动回退下一音源",
      },
      {
        key: "timeoutMs",
        label: "单次网络超时(毫秒)",
        type: "number",
        default: 15000,
        help: "音源请求超时;超时视为该音源本次失败并自动回退下一音源",
      },
      {
        key: "maxSources",
        label: "最多加载音源数",
        type: "number",
        default: 0,
        help: "0=不限制,音源列表里所有行都会加载;>0 时只加载前 N 个(防止脚本过多吃满沙箱内存)",
      },
      {
        key: "prefetchStreams",
        label: "搜索时预取播放链接",
        type: "switch",
        default: true,
        help: "搜索/歌单返回后立即为前若干首调音源 musicUrl 预取直链并缓存;关掉可减少对音源 API 的请求频率",
      },
      {
        key: "prefetchMax",
        label: "单次预取歌曲数上限",
        type: "number",
        default: 10,
        help: "每次搜索/歌单最多预取多少首的直链(1~50)",
      },
      {
        key: "fallbackOnError",
        label: "音源报错自动回退",
        type: "switch",
        default: true,
        help: "某音源执行报错(403/风控/脚本异常)时自动改用下一个可用音源,并把回退轨迹记进返回 message",
      },
      {
        key: "fallbackOnEmpty",
        label: "音源空结果自动回退",
        type: "switch",
        default: true,
        help: "某音源返回空结果时自动改用下一个可用音源(对冷门曲目很有用)",
      },
      {
        key: "sortOrder",
        label: "首页显示顺序",
        type: "number",
        default: 40,
        help: "数值越小越靠前(1~100)",
      },
    ],
    documentation:
      "### 功能\n把洛雪音乐音源 .js 直接跑在 MusicFlow 沙箱里,解析出源(酷我/酷狗/网易/…)并提供\n" +
      "取链播放、搜索(仅当音源声明 musicSearch/search)、歌词、封面。不需要洛雪客户端,也不需要额外服务端。\n\n" +
      "### 能力边界(按真实音源协议)\n洛雪标准协议的 request actions 只有 musicSearch/musicUrl/lyric/pic,\n" +
      "不含专辑/歌单搜索与每日推荐 —— 本插件对齐声明以便服务端无缝接入,但对音源不支持的能力会返回\n" +
      "明确的空结果+原因,首页推荐/歌单由 go-music-dl 等插件提供。\n\n" +
      "### 风险提示\n本插件会在你的 MusicFlow 服务进程内执行第三方音源脚本,等同于运行不是你写的程序;\n" +
      "插件不预置任何音源内容。请只添加你信任的音源,并建议在家庭局域网内自用。\n\n" +
      "### 配置\n- 音源列表:`;` 分隔的 URL 或本地文件名(可带「显示名=...」);\n" +
      "- 音质档、超时、最大音源数、搜索预取直链开关与上限;\n" +
      "- 回退:音源报错 / 空结果自动回退到下一个可用音源(可分别开关)。\n\n" +
      "### 失败可见\n下载失败、语法错、顶层抛错(如要求去官网下载新版)、未注册任何源、取链 403/超时,\n" +
      "都会给出原文与脚本位置,并记录回退轨迹,绝不静默返回空结果。\n\n" +
      "### 音源 URL 与「已加载但未注册任何源」\n" +
      "音源 URL 一律用 https://raw.githubusercontent.com/<owner>/<repo>/<分支>/<路径> 直链:" +
      "实测部分内网环境可达 raw.githubusercontent.com 但不可达 cdn.jsdelivr.net,用 jsdelivr 会直接「音源下载失败」。\n" +
      "「已加载但未注册任何源」= 文件下载成功且脚本已在沙箱里执行,但没有完成 sources 注册," +
      "常见于该音源依赖浏览器环境(window/document/localStorage),或需要宿主下发运行期配置才能初始化。\n" +
      "排查看「测试」结果明细里的诊断后缀 (state=…,handlers=N,net=M):handlers=0 且 net=0 说明脚本没挂上任何 lx 监听;" +
      "handlers>0 说明脚本执行了、注册卡在网络或宿主能力;net>0 说明沙箱网络桥已通。\n\n" +
      "### 与 go-music-dl 的分工\ngo-music-dl 覆盖 12 个主流版权平台与首页推荐;本插件走洛雪音源生态\n" +
      "(冷门/下架/长尾聚合 + 音源可自行热替换,不必改代码发版)。两者可并存,核心按\n" +
      "sourcePreference 排序取源;本插件整体不可用时,核心会自动使用 go-music-dl 等其它已启用插件。",
    i18n: {
      en: {
        name: "LX Music Sources",
        description:
          "Inlines LX Music source scripts into the MusicFlow sandbox: parses the @name/@version header and registers " +
          "the sources with stream URL resolving, search (when the source declares it), lyrics and covers. No LX server, " +
          "no external service address. If a source fails, the next configured source is used automatically; if the whole " +
          "plugin is unusable, the core falls back to other enabled source plugins. " +
          "Warning: this plugin executes third-party source scripts inside your MusicFlow server process; " +
          "add only sources you trust and keep it LAN-only. Disabled by default.",
        fields: {
          sources: { label: "Sources (one per row)", help: "LX source .js URLs or local file names, one per row; use 'Name=...' to rename." },
          sourceDir: { label: "Source directory", help: "Root dir for local .js sources (default lx-sources); absolute paths ignore this." },
          quality: { label: "Quality", help: "Preferred quality tier when fetching a playable URL." },
          timeoutMs: { label: "Network timeout (ms)", help: "Timeout for a single fetch; on failure the next source is tried." },
          maxSources: { label: "Max sources", help: "0 = load every row; >0 caps how many scripts load at once." },
          prefetchStreams: { label: "Prefetch stream URLs on search", help: "Resolve playable URLs right after a search and cache them." },
          prefetchMax: { label: "Prefetch cap per search", help: "Max songs to prefetch per search/playlist (1~50)." },
          fallbackOnError: { label: "Auto fallback on error", help: "Try the next source when one errors (403 / anti-bot / script exception)." },
          fallbackOnEmpty: { label: "Auto fallback on empty", help: "Try the next source when one returns no results." },
          sortOrder: { label: "Home sort order", help: "Lower value sorts first (1~100)." },
        },
        documentation:
          "### Features\nRuns LX Music source scripts inside the MusicFlow QuickJS sandbox and exposes stream URL " +
          "resolving, search (sources that declare musicSearch/search), lyrics and covers. No LX client and no extra service.\n\n" +
          "### Capability boundary\nThe LX request protocol only defines musicSearch/musicUrl/lyric/pic actions; album/playlist " +
          "search and daily recommendations are not part of it, so those methods return an explicit empty result with the reason.\n\n" +
          "### Warning\nExecutes third-party scripts in your MusicFlow process; add only sources you trust.\n\n" +
          "### Config\n- Sources: semicolon-separated URLs or file names;\n- Quality / timeout / max sources / prefetch;\n" +
          "- Fallback on error and on empty (auto-switch to the next working source).\n\n" +
          "### Source URLs and 'loaded but no sources registered'\n" +
          "Always use raw.githubusercontent.com direct links (https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>): " +
          "on some LAN setups raw.githubusercontent.com is reachable while cdn.jsdelivr.net is not, so jsdelivr URLs fail with 'download failed'.\n" +
          "'Loaded but no sources registered' means the file downloaded and the script ran inside the sandbox, yet it never registered its sources — " +
          "usually because the source needs a browser environment (window/document/localStorage) or runtime config pushed by the host.\n" +
          "Read the (state=…,handlers=N,net=M) diagnostic suffix in the Test result: handlers=0 with net=0 means no lx listener was attached at all; " +
          "handlers>0 means the script ran but registration is blocked on network or host capabilities; net>0 means the sandbox network bridge works.\n\n" +
          "### Failure visibility\nDownload errors, syntax errors, top-level throws, sources registering nothing, " +
          "403/timeouts are all reported with the original message; silent empty results never happen.",
      },
    },
  },

  create(host) {
    const manifest = (globalThis && globalThis.__mfPlugin && globalThis.__mfPlugin.manifest) || {};
    const log = (m) => { try { host.log && host.log("[" + manifest.id + "] " + m); } catch (e) {} };
    const cfg = () => (host.config || {});
    const cfgNum = (k, d) => { const v = Number(cfg()[k]); return Number.isFinite(v) && v > 0 ? v : d; };
    const cfgStr = (k, d) => { const v = cfg()[k]; return (v === undefined || v === null || v === "") ? d : String(v); };
    const cfgArr = (k) => { const v = cfg()[k]; if (!v) return []; return Array.isArray(v) ? v : String(v).split(";").map((s) => s.trim()).filter(Boolean); };
    const cfgOn = (k, d) => (cfg()[k] === undefined ? d : !!cfg()[k]);
    const clamp = (v, lo, hi, d) => { const n = Number(v); if (!Number.isFinite(n)) return d; return Math.min(hi, Math.max(lo, Math.round(n))); };

    // ---------------- lx 宿主 shim ----------------
    // 设计要点:① 同步执行所有「等一下」原语,把异步链压平,解决 guest 不能泵微任务;
    // ② lx.request 优先走宿主注入的单出口 __mfJsenvHttp(可审计/可超时),没注入时
    //    退回同步桩并记痕(仅加载期可用,取链会明确报错而不是伪造 URL);
    // ③ 宿主响应统一 _lxNorm 成洛雪形状 {statusCode,headers,cookies,body},body 为
    //    JSON 字符串时自动 parse(洛雪源按对象取 body.data)。
    function buildShim() {
      return [
        "globalThis.__lxState={sources:null,handlers:{},net:[],result:null};",
        "globalThis.__lxSTUB={statusCode:200,headers:{'content-type':'application/json'},cookies:[],",
        " body:{code:200,status:1,err_code:0,data:{url:'',play_backup_url:''},result:{data:{url:''}}} };",
        "window = globalThis;",
        "document = { getElementsByTagName: function(){ return { innerText: '' }; } };",
        "function _lxU8(s){var a=[];for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if(c<0x80)a.push(c);else if(c<0x800)a.push((c>>6)|192,(c&63)|128);else a.push((c>>12)|224,((c>>6)&63)|128,(c&63)|128);}return a;}",
        "function _lxStr(b){var s='';for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);try{return decodeURIComponent(escape(s));}catch(e){return s;}}",
        "function _lxHex(b){return Array.prototype.map.call(b,function(x){return x.toString(16).padStart(2,'0');}).join('');}",
        "function _lxNorm(r){ if(!r) return {statusCode:0,headers:{},cookies:[],body:null};",
        "  var b=r.body!==undefined?r.body:r;",
        "  if(typeof b==='string'){ try{ b=JSON.parse(b); }catch(e){} }",
        "  if(typeof r.statusCode==='number') return {statusCode:r.statusCode,headers:r.headers||{},cookies:r.cookies||[],body:b};",
        "  return { statusCode:(r.status==null?0:r.status), headers:(r.headers||{}), cookies:(r.cookies||[]), body:b }; }",
        "globalThis.lx = {",
        "  version:'3.0.0',",
        "  EVENT_NAMES:{inited:'inited',request:'request',updateAlert:'updateAlert'},",
        "  on:function(n,h){(globalThis.__lxState.handlers[n]=globalThis.__lxState.handlers[n]||[]).push(h);return {cancel:function(){}};},",
        "  send:function(n,d){ if(n==='inited'){ globalThis.__lxState.sources=(d&&d.sources)||null; } return {cancel:function(){}}; },",
        "  request:function(url,opt,cb){",
        "    var u=String(url), o=opt||{}; globalThis.__lxState.net.push(u);",
        "    var done=function(r){ if(typeof cb==='function'){ try{cb(null,_lxNorm(r));}catch(e){ try{cb(String(e&&e.message||e));}catch(_){} } } };",
        "    var bad=function(e){ if(typeof cb==='function'){ try{cb(String(e&&e.message||e));}catch(_){} } };",
        "    if(typeof globalThis.__mfJsenvHttp==='function'){",
        "      try{ var p=globalThis.__mfJsenvHttp(u,o);",
        "        if(p&&typeof p.then==='function'){ p.then(done,bad); return {cancel:function(){}}; }",
        "      }catch(e){ bad(e); return {cancel:function(){}}; }",
        "    }",
        "    done(globalThis.__lxSTUB);",
        "    return {cancel:function(){}};",
        "  },",
        "  utils:{",
        "    buffer:{",
        "      from:function(x){ if(typeof x==='string'){var b=_lxU8(x);return {__buf:1,bytes:b,toString:function(f){return f==='hex'?_lxHex(b):_lxStr(b);}};}",
        "        if(Array.isArray(x)){return {__buf:1,bytes:x.slice(),toString:function(f){return f==='hex'?_lxHex(x):_lxStr(x);}};}",
        "        return {__buf:1,bytes:[],toString:function(){return '';}}; },",
        "      bufToString:function(b,f){ return b&&b.toString?b.toString(f):''; } },",
        "    crypto:{ md5:function(){return 'd41d8cd98f00b204e9800998ecf8427e';},",
        "      aesEncrypt:function(t,k){return {__err:'aesEncrypt MISSING'};},",
        "      rsaEncrypt:function(t,k){return {__err:'rsaEncrypt MISSING'};},",
        "      randomBytes:function(n){var a=[];for(var i=0;i<(n||8);i++)a.push(Math.floor(Math.random()*256));return a;} },",
        "    zlib:{ gzipSync:function(){return [1,2,3];}, gunzipSync:function(b){return b;} }",
        "  },",
        "  env:{'User-Agent':'MusicFlow-lx/1.0'}, currentScriptInfo:{rawScript:''}",
        "};",
        "globalThis.console={log:function(){},error:function(){},warn:function(){},info:function(){},debug:function(){},group:function(){},groupEnd:function(){},groupCollapsed:function(){},table:function(){},time:function(){},timeEnd:function(){}};",
        "globalThis.setTimeout=function(fn){ if(typeof fn==='function'){ try{fn();}catch(e){} } return 1; };",
        "globalThis.clearTimeout=function(){};",
        "globalThis.setInterval=function(){return 1;}; globalThis.clearInterval=function(){};",
        "globalThis.queueMicrotask=function(fn){ try{fn();}catch(e){} };",
        "globalThis.requestAnimationFrame=function(){return 1;};",
        "globalThis.atob=function(s){return '';}; globalThis.btoa=function(s){return '';};",
        "globalThis.alert=function(){};",
        "globalThis.localStorage={getItem:function(){return null;},setItem:function(){},removeItem:function(){}};",
        "globalThis.navigator={userAgent:'MusicFlow-lx/1.0'};",
        "globalThis.location={href:'http://localhost/',protocol:'http:'};",
      ].join("\n");
    }
    const SHIM = buildShim();

    // ---------------- 工具 ----------------
    function parseLxHeader(code) {
      const m = {};
      const re = /@(\w+)\s+([^\s*]+)/g;
      let hit;
      while ((hit = re.exec(code)) !== null) {
        const k = hit[1];
        if (["name", "version", "author", "description", "update_url", "type"].indexOf(k) >= 0) m[k] = hit[2];
      }
      return { name: m.name || "", version: m.version || "0.0.0", author: m.author || "", description: m.description || "", updateUrl: m.update_url || "" };
    }

    function parseList(v) {
      // 新配置是 text-list 字符串数组(一行一个);兼容旧版分号/换行分隔的字符串配置
      const rows = Array.isArray(v) ? v.map((s) => String(s == null ? "" : s)) : String(v || "").split(/[\n;]+/);
      const out = [];
      rows
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((item) => {
          let name = "", target = item;
          if (item.indexOf("=") > 0 && !/^https?:\/\//i.test(item)) {
            name = item.slice(0, item.indexOf("=")).trim();
            target = item.slice(item.indexOf("=") + 1).trim();
          }
          if (!target) return;
          out.push({ name: name, target: target, isUrl: /^https?:\/\//i.test(target) });
        });
      return out;
    }

    async function httpText(url, timeoutMs) {
      const r = await host.http(url, { method: "GET", timeout: timeoutMs });
      if (!r.ok) {
        const detail = r.error ? " (" + (r.error.message || r.error) + ")" : "";
        throw new Error("HTTP " + (r.status == null ? "?" : r.status) + ": " + url + detail);
      }
      return String(r.body);
    }

    function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
    function isHttpUrl(u) { return typeof u === "string" && /^https?:\/\//i.test(u.trim()); }

    // 洛雪 songInfo -> OnlineSongResult(保留原始 musicInfo 供取链/歌词复用)
    function normalizeSongItem(it, rec) {
      if (!it || typeof it !== "object") return null;
      const id = String(it.songmid || it.hash || it.id || it.rid || it.copyrightId || it.songId || "").trim();
      const name = String(it.name || it.songName || it.title || "").trim();
      if (!id || !name) return null;
      let artist = it.singer !== undefined ? it.singer : (it.artist !== undefined ? it.artist : (it.artists || it.artistName || ""));
      if (Array.isArray(artist)) artist = artist.map((a) => (typeof a === "string" ? a : (a && (a.name || a.singer)) || "")).filter(Boolean).join("、");
      let interval = it.interval !== undefined ? it.interval : it.duration;
      let duration = 0;
      if (typeof interval === "number" && Number.isFinite(interval)) duration = Math.round(interval);
      else if (typeof interval === "string" && /^\d+:\d{1,2}(:\d{1,2})?$/.test(interval.trim())) {
        const p = interval.split(":").map(Number); duration = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
      }
      const source = String(it.source || (rec.sources && rec.sources[0]) || "other");
      return {
        id: id, source: source, name: name,
        artist: String(artist || "").trim(),
        album: String(it.albumName || it.album || it.albumTitle || "").trim(),
        duration: duration,
        cover: String(it.img || it.pic || it.cover || it.albumpic || "").trim(),
        extra: { lx: JSON.stringify(it) },
      };
    }

    // 兼容 {list}/{data.list}/数组/{songs} 各种返回形状
    function normalizeSongs(v, rec) {
      let list = null;
      if (Array.isArray(v)) list = v;
      else if (v && Array.isArray(v.list)) list = v.list;
      else if (v && v.data && Array.isArray(v.data.list)) list = v.data.list;
      else if (v && v.data && Array.isArray(v.data.lists)) list = v.data.lists;
      else if (v && Array.isArray(v.songs)) list = v.songs;
      if (!list) return [];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const s = normalizeSongItem(list[i], rec);
        if (s) out.push(s);
      }
      return out;
    }

    function pick(obj, keys, fallback) {
      if (!obj || typeof obj !== "object") return fallback;
      for (let i = 0; i < keys.length; i++) {
        const v = obj[keys[i]];
        if (v !== undefined && v !== null && v !== "") return v;
      }
      return fallback;
    }

    // ---------------- 音源加载(每源一个 jsenv 子环境) ----------------
    const cache = {};
    let cacheFp = "";
    // 音源列表(顺序+内容)变化即清空缓存:否则改完列表后的第一次调用会命中旧结果。
    function syncCache() {
      const items = parseList(cfg().sources);
      let h = 5381;
      const t = JSON.stringify(items.map(function (i) { return i.target + "=" + i.name; }));
      for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
      const fp = String(items.length) + "_" + (h >>> 0).toString(36);
      if (fp !== cacheFp) { cacheFp = fp; for (const k of Object.keys(cache)) delete cache[k]; }
    }

    async function loadOne(item, idx) {
      const dir = cfgStr("sourceDir", "lx-sources");
      const timeoutMs = cfgNum("timeoutMs", 15000);
      const envName = "lx-source:" + idx;
      // P1-1:环境名必须带内容指纹。宿主 jsenv.create 对同名环境是直接返回(不重跑
      // initCode),只按下标命名时「改完音源列表再测」会拿到上一次的加载结果(假阳性)。
      const lxFp = (code) => {
        try { if (host.crypto && typeof host.crypto.md5 === "function") return String(host.crypto.md5(String(code))); } catch (_) { /* fallthrough */ }
        let h = 5381; const t = String(code);
        for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
        return String(t.length) + "_" + (h >>> 0).toString(36);
      };
      let code = null;
      let origin = item.target;

      if (item.isUrl) {
        try { code = await httpText(item.target, timeoutMs); }
        catch (e) {
          const err = "音源下载失败: " + item.target + " -> " + ((e && e.message) || e);
          log(err);
          return { idx: idx, envName: envName, name: item.name || "", state: "error", error: err, origin: origin };
        }
      } else {
        const p = /^\/|^[A-Za-z]:[\\/]/.test(item.target) ? item.target : dir + "/" + item.target;
        try { code = String(await host.fs.readFile(p, "utf8")); }
        catch (e) {
          const err = "音源文件读取失败: " + p + " -> " + ((e && e.message) || e);
          log(err);
          return { idx: idx, envName: envName, name: item.name || "", state: "error", error: err, origin: origin };
        }
        origin = p;
      }

      const head = parseLxHeader(code);
      const envKey = envName + ":" + lxFp(code);
      const ck = item.target + "|" + lxFp(code);
      const rec = {
        idx: idx, envName: envKey, ckey: ck, name: item.name || head.name || ("src" + idx),
        version: head.version, author: head.author, description: head.description,
        updateUrl: head.updateUrl, origin: origin, state: "loading", error: null,
        sources: [], srcInfo: {}, actions: [], handlers: [], netHits: 0,
      };

      try {
        // 先销毁同名旧环境(P1-1 双保险),再按指纹名创建
        try { await host.jsenv.destroy(envKey); } catch (_) {}
        await host.jsenv.create(envKey, SHIM + "\n" + code);
      } catch (e) {
        const msg = String((e && e.message) || e);
        rec.state = "error";
        // 顶层抛错(如要求去官网下载新版)必须原样透出,不许注册成空音源
        rec.error = "音源脚本加载失败(执行阶段): " + origin + " -> " + msg;
        log(rec.error);
        try { await host.jsenv.destroy(envKey); } catch (_) {}
        return rec;
      }

      try {
        const probe = "(function(){try{return JSON.stringify({s:globalThis.__lxState.sources?Object.keys(globalThis.__lxState.sources):null," +
          "info:globalThis.__lxState.sources?Object.fromEntries(Object.entries(globalThis.__lxState.sources).map(function(kv){return [kv[0],{actions:(kv[1]&&kv[1].actions)||[],qualitys:(kv[1]&&kv[1].qualitys)||[]}]})):{}," +
          "h:Object.keys(globalThis.__lxState.handlers),n:(globalThis.__lxState.net||[]).length});}catch(e){return JSON.stringify({s:null,error:String(e)})}})()";
        const r = await host.jsenv.execute(envKey, probe);
        let info = null;
        try { info = JSON.parse(r && r.result ? r.result : "null"); } catch (_) { info = null; }
        if (info && info.s && info.s.length) {
          rec.state = "ready";
          rec.sources = info.s;
          rec.srcInfo = info.info || {};
          rec.handlers = info.h || [];
          rec.netHits = info.n || 0;
          const acts = {};
          info.s.forEach(function (sid) { ((rec.srcInfo[sid] || {}).actions || []).forEach(function (a) { acts[a] = 1; }); });
          rec.actions = Object.keys(acts);
          log("音源注册成功: " + rec.name + " v" + rec.version + " 源=" + info.s.join(",") + " actions=" + (rec.actions.join(",") || "-"));
        } else {
          rec.state = "ready_no_sources";
          // 诊断需要:即使没注册上源,也要把探针带回的 handlers / net 计数留下来
          // (handlers>0 说明脚本确实执行并挂上了 lx.on;net>0 说明沙箱网络桥已通)。
          if (info) {
            rec.handlers = info.h || [];
            rec.netHits = info.n || 0;
          }
          // 探针内部错误(__lxState 缺失等)最有排错价值,放最前面,免得被 80 字符摘要截断
          const base = "音源已加载但未注册任何源(" + origin + ");常见原因:该源等待宿主下发运行期配置,或依赖浏览器环境";
          rec.error = info && info.error ? "探针内部错误:" + String(info.error) + ";" + base : base;
          log(rec.error + " handlers=" + ((rec.handlers && rec.handlers.length) || 0) + " net=" + (rec.netHits || 0));
        }
      } catch (e) {
        rec.state = "error";
        rec.error = "音源脚本加载失败(读取注册结果): " + origin + " -> " + String((e && e.message) || e);
        log(rec.error);
      }
      cache[item.target] = rec;
      return rec;
    }

    async function readySources() {
      syncCache();
      const max = clamp(cfgNum("maxSources", 0), 0, 200, 0);
      const all = parseList(cfg().sources);
      const items = max > 0 ? all.slice(0, max) : all;
      const out = [];
      for (let i = 0; i < items.length; i++) {
        const rec = cache[items[i].target] || await loadOne(items[i], i);
        if (rec.state === "ready") out.push(rec);
      }
      const pref = cfgArr("sourcePreference");
      if (pref.length) out.sort((a, b) => pref.indexOf(a.sources[0]) - pref.indexOf(b.sources[0]));
      return out;
    }

    // 在子环境里调用 request handler;宿主 jsenv 桥负责推进微任务并代发网络。
    // 洛雪信封:{action, source, info};返回值经 __lxState.result 序列化带回。
    async function callAction(rec, action, info, sourceId) {
      const payload = JSON.stringify({ action: action, source: String(sourceId || ""), info: info === undefined ? {} : info });
      const boot = "(function(){try{globalThis.__lxState.result=null;}catch(e){}})();" +
        "(async function(){var hs=(globalThis.__lxState.handlers||{}).request||[];" +
        "if(!hs.length){globalThis.__lxState.result={ok:false,error:'no request handler'};return;}" +
        "try{var v=await hs[0](" + payload + ");globalThis.__lxState.result={ok:true,value:v===undefined?null:v};}" +
        "catch(e){globalThis.__lxState.result={ok:false,error:String((e&&e.message)||e)};}})();";
      const r1 = await host.jsenv.execute(rec.envName, boot);
      if (r1 && r1.ok === false) throw new Error("沙箱执行失败: " + (r1.error || "unknown"));
      const r = await host.jsenv.execute(rec.envName, "JSON.stringify(globalThis.__lxState.result)");
      let parsed = null;
      try { parsed = JSON.parse(r && r.result ? r.result : "null"); } catch (_) { parsed = null; }
      if (!parsed) throw new Error("音源无返回(沙箱交互失败): " + rec.name);
      if (parsed.ok === false) throw new Error(String(parsed.error || "音源执行失败"));
      return parsed.value;
    }

    // 找出声明了 action 的源 id 列表(按 rec.srcInfo 声明,不发试探请求)
    function sourceIdsWithAction(rec, actionNames) {
      const ids = [];
      (rec.sources || []).forEach(function (sid) {
        const acts = ((rec.srcInfo[sid] || {}).actions) || [];
        for (let i = 0; i < actionNames.length; i++) if (acts.indexOf(actionNames[i]) >= 0) { ids.push({ id: sid, action: actionNames[i] }); break; }
      });
      return ids;
    }

    // ---------------- 直链缓存(同步 streamUrl 读取) ----------------
    const urlCache = {};
    const urlOrder = [];
    const URL_CACHE_MAX = 600;

    function cacheUrl(keys, url) {
      if (!url) return;
      for (let i = 0; i < keys.length; i++) {
        const k = String(keys[i]);
        if (!k) continue;
        if (!(k in urlCache)) { urlOrder.push(k); if (urlOrder.length > URL_CACHE_MAX) { const old = urlOrder.shift(); delete urlCache[old]; } }
        urlCache[k] = url;
      }
    }
    function songKey(song) {
      return String((song && song.source) || "") + "|" + String((song && song.id) || "");
    }
    function songTitleKey(song) {
      return "t|" + String((song && (song.name || song.title)) || "") + "|" + String((song && song.artist) || "");
    }

    // 用洛雪 musicUrl action 取直链;song.extra.lx 里保存了搜索时的原始 musicInfo
    async function resolveStreamUrl(rec, song) {
      const ids = sourceIdsWithAction(rec, ["musicUrl"]);
      if (!ids.length) throw new Error("该音源未声明 musicUrl 能力");
      let musicInfo = null;
      if (song && song.extra && song.extra.lx) musicInfo = safeParse(song.extra.lx);
      if (!musicInfo || typeof musicInfo !== "object") {
        musicInfo = { songmid: song && song.id, hash: song && song.id, id: song && song.id, name: song && (song.name || song.title), singer: song && song.artist, albumName: song && song.album };
      }
      const q = cfgArr("quality");
      const quality = q.length ? q[0] : "320k";
      let lastErr = null;
      for (let i = 0; i < ids.length; i++) {
        try {
          const v = await callAction(rec, ids[i].action, { type: quality, musicInfo: musicInfo }, ids[i].id);
          const url = typeof v === "string" ? v : (v && typeof v === "object" ? (v.url || v.playUrl || "") : "");
          if (!isHttpUrl(url)) throw new Error("返回的不是有效直链: " + String(url).slice(0, 80));
          return url;
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("musicUrl 全部候选源失败");
    }

    // 搜索后预取直链:失败逐首记日志(可见),不中断整体结果
    async function prefetchStreams(rec, songs) {
      if (!cfgOn("prefetchStreams", true)) return;
      const cap = clamp(cfgNum("prefetchMax", 10), 1, 50, 10);
      const n = Math.min(cap, songs.length);
      for (let i = 0; i < n; i++) {
        const s = songs[i];
        try {
          const url = await resolveStreamUrl(rec, s);
          s.url = url;
          cacheUrl([songKey(s), songTitleKey(s)], url);
        } catch (e) {
          log("预取直链失败(" + s.name + " @" + rec.name + "): " + String((e && e.message) || e));
        }
      }
    }

    // 音源级自动回退:报错 / 空结果都按配置切下一个可用音源,轨迹回传调用方
    async function withFallback(kind, fn) {
      const fbErr = cfgOn("fallbackOnError", true);
      const fbEmpty = cfgOn("fallbackOnEmpty", true);
      const list = await readySources();
      if (!list.length) {
        return {
          empty: true,
          message: "没有可用的洛雪音源:请在插件配置「音源列表」里添加至少一个 .js URL 或本地文件名(音源加载失败会在插件页与日志显示原因)。",
        };
      }
      const trace = [];
      for (let i = 0; i < list.length; i++) {
        const rec = list[i];
        try {
          const val = await fn(rec);
          const usable = kind === "url"
            ? (isHttpUrl(val) || !!(val && (isHttpUrl(val.url) || isHttpUrl(val.playUrl))))
            : !!(val && (val.songs ? val.songs.length : Array.isArray(val) ? val.length : 1));
          if (usable) {
            return val && val.trace ? val : Object.assign({}, val || {}, { trace: trace, fallbackFrom: trace.length ? trace.join(">") : "" });
          }
          if (!fbEmpty) throw new Error("空结果");
          trace.push(rec.name + "(空结果)");
          log(kind + " 空结果,回退下一音源: " + rec.name);
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (!fbErr) throw e;
          trace.push(rec.name + "(" + msg.slice(0, 80) + ")");
          log(kind + " 失败 " + rec.name + " -> " + msg + ",回退下一音源");
        }
      }
      return {
        empty: true,
        message: "全部洛雪音源均无结果(" + trace.length + " 次回退): " + trace.join(" | "),
        trace: trace,
      };
    }

    // ---------------- 方法(与 go-music-dl 方法面对齐) ----------------
    return {
      async health() {
        syncCache();
        // P3-6:与 test 口径一致,全量加载。按 maxSources 截断会让 status 误报 down
        //(例如 maxSources=1 时只看第一个坏源就判 down,实际后面还有可用源)。
        const items = parseList(cfg().sources);
        const list = [];
        for (let i = 0; i < items.length; i++) list.push(await loadOne(items[i], i));
        const readyCount = list.filter((r) => r.state === "ready").length;
        // 核心 plugins/health.ts pingPlugin() 只认 {status: ok|degraded|down},缺字段会被判「未监控」:
        // 无音源=degraded(配置缺失),全就绪=ok,部分就绪=degraded,全部失败=down。
        // 原 ok/items/message 字段保持不变,向后兼容已有调用方。
        const status = list.length === 0 ? "degraded" : readyCount === 0 ? "down" : readyCount === list.length ? "ok" : "degraded";
        return {
          status: status,
          ok: list.length > 0 && list.every((r) => r.state === "ready"),
          items: list.map((r) => ({ name: r.name, version: r.version, author: r.author, origin: r.origin, state: r.state, error: r.error, sources: r.sources, actions: r.actions, handlers: r.handlers, netHits: r.netHits })),
          message:
            list.length === 0
              ? "未配置任何音源:请在「音源列表」里添加至少一个 .js URL 或本地文件名。"
              : list.length + " 个音源,就绪 " + readyCount + " 个,失败 " + (list.length - readyCount) + " 个。",
        };
      },

      // 核心「测试连接」入口(POST /v1/online/:providerId/test):
      // 遍历配置里的全部音源(不设数量上限,与 maxSources 无关),逐个 loadOne,
      // 统计可用 / 不可用并把逐源明细拼成人类可读文本回传(前端对话框按文本展示)。
      // 该路由不包 try/catch,故这里整体兜底:任何异常都转成 success:false + 原文摘要。
      async test(config) {
        try {
          const conf = config && typeof config === "object" ? config : {};
          const raw = Object.prototype.hasOwnProperty.call(conf, "sources") ? conf.sources : cfg().sources;
          syncCache();
          const items = parseList(raw);
          if (!items.length) {
            return { success: false, message: "未配置任何音源:请在「音源列表」里添加至少一个 .js URL 或本地文件名,再点测试。" };
          }

          // 单行压缩:去掉换行与连续空白,超长截断(保留前 n-1 字符 + 省略号)
          const brief = (s, n) => {
            const t = String(s === undefined || s === null ? "" : s).replace(/\s+/g, " ").trim();
            return t.length > n ? t.slice(0, n - 1) + "…" : t;
          };
          // P2-3:错误摘要截断要保留首尾(错误类型在头、出错 URL/行号在尾),只看开头会丢根因
          const briefErr = (s, n) => {
            const t = String(s === undefined || s === null ? "" : s).replace(/\s+/g, " ").trim();
            if (t.length <= n) return t;
            return t.slice(0, Math.max(10, n - 21)) + "…" + t.slice(-20);
          };

          const okList = [];
          const badList = [];
          for (let i = 0; i < items.length; i++) {
            let rec = null;
            try {
              rec = await loadOne(items[i], i);
            } catch (e) {
              rec = { name: items[i].name || "", version: "", origin: items[i].target, state: "error", error: "测试时抛出异常: " + String((e && e.message) || e), sources: [], actions: [] };
            }
            if (!rec) rec = { name: items[i].name || "", version: "", origin: items[i].target, state: "error", error: "音源测试无返回", sources: [], actions: [] };
            if (rec.state === "ready") okList.push({ no: i + 1, rec: rec });
            else badList.push({ no: i + 1, rec: rec, target: items[i].target });
          }

          const okFull = okList
            .map(function (o) {
              const r = o.rec;
              const plat = r.sources && r.sources.length ? r.sources.join(",") : "未注册源";
              const acts = r.actions && r.actions.length ? r.actions.join(",") : "-";
              const vr = String(r.version || "?");
              return o.no + ". " + brief(r.name || r.origin, 24) + "[" + (/^[vV]/.test(vr) ? vr : "v" + vr) + "](" + plat + ",actions=" + acts + ")";
            })
            .join(" | ");
          const okBrief = okList
            .map(function (o) { return o.no + "." + brief(o.rec.name || o.rec.origin, 16); })
            .join(" | ");
          // 不可用明细带诊断后缀:state / handlers / net 三者组合可立刻区分根因
          // handlers=0 且 net=0 -> 脚本没执行或没挂 lx 监听;handlers>0 -> 脚本执行了,
          // 注册卡在网络或宿主能力;net>0 -> 沙箱网络桥已通。
          // 完整未截断的明细同时写日志(对话框里 80 字符摘要可能被截断)。
          badList.forEach(function (b) {
            const r = b.rec;
            log(
              "test 不可用 #" + b.no + " " + (r.name || r.origin || b.target) +
                " state=" + r.state +
                " handlers=" + ((r.handlers && r.handlers.length) || 0) +
                " net=" + (r.netHits || 0) +
                " err=" + String(r.error || "")
            );
          });
          const badText = badList
            .map(function (b) {
              const r = b.rec;
              const diag = "(state=" + r.state + ",handlers=" + ((r.handlers && r.handlers.length) || 0) + ",net=" + (r.netHits || 0) + ")";
              return b.no + ". " + brief(r.name || r.origin || b.target, 24) + " → " + briefErr(r.error || "未注册任何源(原因未知)", 80) + " " + diag;
            })
            .join(" | ");

          const head = "共 " + items.length + " 个音源:可用 " + okList.length + " 个,不可用 " + badList.length + " 个。";
          // P2-5:各最多列 15 条,超出的用「另有 N 个未显示」明确交代(纯字符截断会
          // 让可用清单整段消失、不可用后半无声丢弃,与「可用和不可用都有哪些」不符)。
          const MAX_ROWS = 15;
          const badRows = badList.slice(0, MAX_ROWS);
          const okRows = okList.slice(0, MAX_ROWS);
          const badText2 = badRows
            .map(function (b) {
              const r = b.rec;
              const diag = "(state=" + r.state + ",handlers=" + ((r.handlers && r.handlers.length) || 0) + ",net=" + (r.netHits || 0) + ")";
              return b.no + ". " + brief(r.name || r.origin || b.target, 24) + " → " + briefErr(r.error || "未注册任何源(原因未知)", 80) + " " + diag;
            })
            .join(" | ");
          const okFull2 = okRows
            .map(function (o) {
              const r = o.rec;
              const plat = r.sources && r.sources.length ? r.sources.join(",") : "未注册源";
              const acts = r.actions && r.actions.length ? r.actions.join(",") : "-";
              const vr = String(r.version || "?");
              return o.no + ". " + brief(r.name || r.origin, 24) + "[" + (/^[vV]/.test(vr) ? vr : "v" + vr) + "](" + plat + ",actions=" + acts + ")";
            })
            .join(" | ");
          const okBrief2 = okRows
            .map(function (o) { return o.no + "." + brief(o.rec.name || o.rec.origin, 16); })
            .join(" | ");
          const more = [];
          if (badList.length > badRows.length) more.push("另有 " + (badList.length - badRows.length) + " 个不可用未显示");
          if (okList.length > okRows.length) more.push("另有 " + (okList.length - okRows.length) + " 个可用未显示");
          const moreLine = more.length ? "(明细条数上限 " + MAX_ROWS + " 条/类:" + more.join(";") + ",完整清单见服务端日志)" : "";
          const badLine = badRows.length ? "不可用 " + badList.length + " 个:" + badText2 : "";
          const okLine = okRows.length ? "可用 " + okList.length + " 个:" + okFull2 : "";
          const okLineShort = okRows.length ? "可用 " + okList.length + " 个(摘要):" + okBrief2 : "";

          // 超长时先保住不可用明细(排错要紧),再压缩可用明细,最后整体截断兜底
          let message = head + (moreLine ? "\n" + moreLine : "") + (badLine ? "\n" + badLine : "") + (okLine ? "\n" + okLine : "");
          if (message.length > 1200 && okRows.length) {
            message = head + (moreLine ? "\n" + moreLine : "") + (badLine ? "\n" + badLine : "") + (okLineShort ? "\n" + okLineShort : "");
          }
          if (message.length > 1200) message = message.slice(0, 1199) + "…";

          log("test 完成: " + head);
          return { success: okList.length > 0, message: message };
        } catch (e) {
          const msg = String((e && e.message) || e);
          log("test 异常: " + msg);
          return { success: false, message: "音源测试异常: " + msg.slice(0, 200) };
        }
      },

      async listSources() {
        const list = await readySources();
        return { sources: list.map((r) => ({ name: r.name, version: r.version, author: r.author, sources: r.sources, actions: r.actions, origin: r.origin, state: r.state })) };
      },

      // 核心搜索入口(search 能力):与 searchSongs 同一实现
      async search(config, params) {
        return this.searchSongs(config, params);
      },

      async searchSongs(config, params) {
        const q = String((params && (params.query !== undefined ? params.query : params.keyword)) || "");
        if (!q) return { songs: [], message: "搜索词为空" };
        return withFallback("search", async (rec) => {
          const ids = sourceIdsWithAction(rec, ["musicSearch", "search"]);
          if (!ids.length) throw new Error("该音源未声明 musicSearch 能力(actions=" + (rec.actions.join(",") || "-") + ")");
          const page = (params && params.page) || 1;
          const limit = clamp((params && params.limit) || 20, 1, 100, 20);
          let lastErr = null;
          for (let i = 0; i < ids.length; i++) {
            try {
              const info = ids[i].action === "search" ? { keyword: q, page: page } : { keyword: q, page: page, pagesize: limit };
              const v = await callAction(rec, ids[i].action, info, ids[i].id);
              const songs = normalizeSongs(v, rec);
              if (songs.length) { await prefetchStreams(rec, songs); return { songs: songs, source: rec.name }; }
            } catch (e) { lastErr = e; }
          }
          throw lastErr || new Error("musicSearch 未返回可用结果");
        });
      },

      // 洛雪标准协议无专辑搜索:直接给明确空结果(不发试探请求,失败可见)
      async searchAlbums() {
        return { albums: [], message: "洛雪标准协议(request actions 仅 musicSearch/musicUrl/lyric/pic)不含专辑搜索;专辑能力由 go-music-dl 等插件提供。" };
      },

      async searchPlaylists() {
        return { playlists: [], message: "洛雪标准协议不含歌单搜索;歌单能力由 go-music-dl 等插件提供。" };
      },

      async playlistSongs() {
        return { songs: [], message: "洛雪标准协议不含歌单详情(sheet);远程歌单由 go-music-dl 等插件提供。" };
      },

      async recommend() {
        return { songs: [], message: "洛雪标准协议不含每日推荐;首页推荐由 go-music-dl 等插件提供。" };
      },

      /** 同步方法(契约:纯同步,返回 string)。直链来自搜索期预取缓存;未命中返回 ""(空直链 web 行,播放时走核心兜底)。 */
      streamUrl(config, song) {
        const direct = pick(song || {}, ["url", "playUrl", "playUrl", "downloadUrl"], null);
        if (typeof direct === "string" && isHttpUrl(direct)) return direct;
        const exUrl = song && song.extra && (song.extra.playUrl || song.extra.url);
        if (typeof exUrl === "string" && isHttpUrl(exUrl)) return exUrl;
        const hit = urlCache[songKey(song)] || urlCache[songTitleKey(song)] || "";
        if (hit) return hit;
        log("streamUrl 未命中缓存: " + songKey(song) + " (直链需搜索预取;未命中时播放走核心换源兜底)");
        return "";
      },

      /** 异步取链(能力补强):搜索未预取到的歌曲可由此现取;返回 {url} 或 {empty,message}。 */
      async resolveStream(config, song) {
        return withFallback("url", async (rec) => {
          const url = await resolveStreamUrl(rec, song);
          cacheUrl([songKey(song), songTitleKey(song)], url);
          return { url: url, source: rec.name };
        });
      },

      async searchLyrics(song) {
        return withFallback("lyrics", async (rec) => {
          const ids = sourceIdsWithAction(rec, ["lyric"]);
          if (!ids.length) throw new Error("该音源未声明 lyric 能力(actions=" + (rec.actions.join(",") || "-") + ")");
          let musicInfo = null;
          if (song && song.extra && song.extra.lx) musicInfo = safeParse(song.extra.lx);
          if (!musicInfo || typeof musicInfo !== "object") musicInfo = { songmid: song && song.id, id: song && song.id, name: song && (song.name || song.title), singer: song && song.artist };
          let lastErr = null;
          for (let i = 0; i < ids.length; i++) {
            try {
              const v = await callAction(rec, ids[i].action, { musicInfo: musicInfo }, ids[i].id);
              const lrc = typeof v === "string" ? v : (v && (v.lyric || v.lrc || ""));
              if (lrc && String(lrc).trim()) return { lrc: String(lrc), source: rec.name };
            } catch (e) { lastErr = e; }
          }
          throw lastErr || new Error("该音源未返回歌词");
        });
      },

      async searchCover(song) {
        return withFallback("cover", async (rec) => {
          const ids = sourceIdsWithAction(rec, ["pic", "cover"]);
          if (!ids.length) throw new Error("该音源未声明 pic 能力(actions=" + (rec.actions.join(",") || "-") + ")");
          let musicInfo = null;
          if (song && song.extra && song.extra.lx) musicInfo = safeParse(song.extra.lx);
          if (!musicInfo || typeof musicInfo !== "object") musicInfo = { songmid: song && song.id, id: song && song.id, name: song && (song.name || song.title), singer: song && song.artist };
          let lastErr = null;
          for (let i = 0; i < ids.length; i++) {
            try {
              const v = await callAction(rec, ids[i].action, { musicInfo: musicInfo }, ids[i].id);
              const url = typeof v === "string" ? v : (v && (v.url || v.pic || v.cover || ""));
              if (isHttpUrl(url)) return { url: String(url), source: rec.name };
            } catch (e) { lastErr = e; }
          }
          throw lastErr || new Error("该音源未返回封面");
        });
      },

      canHandle() { return false; },
    };
  },
};
