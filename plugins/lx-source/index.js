// ============================================================================
//  MusicFlow 外置插件：洛雪(lx)音源内联运行时(纯取链)  v1.1.4(manifest 同步)
// ----------------------------------------------------------------------------
//  能力：把你自己的洛雪音乐(LX Music)音源 .js 直接放进 MusicFlow 沙箱执行，
//        按歌曲平台 ID 直查洛雪 musicUrl 换播放直链(多音源自动轮切)。
//
//  不需要洛雪客户端，不需要洛雪服务端，也不需要 baseUrl 指向任何外部服务。
//
//  洛雪协议(230 上 40 个真实音源实证)：
//    - 音源只依赖宿主注入的 globalThis.lx(require/module.exports 实测 0 命中)；
//    - request 事件载荷信封 {action, source, info}：
//        musicUrl           : info={type:音质, musicInfo}   -> URL 字符串
//        lyric              : info={musicInfo}              -> {lyric}(本插件不用)
//        pic                : info={musicInfo}              -> URL(本插件不用)
//    - **官方协议没有 musicSearch**(桌面/移动端文档均明写非 local 源 actions
//      固定 ['musicUrl'])；搜索从来不是洛雪生态的能力，实测 12 音源搜索自答
//      0/12 —— v1.1.1 起本插件收窄为纯取链，找歌由 go-music-dl 等插件负责。
//    - musicInfo 必须带 source 平台键(wy/kg/kw/tx/mg)，聚合型源读它分流。
//
//  失效自动切换(两层)：
//    层1(插件内)：withFallback 对已配置的多音源按序轮切，报错/无链都切下一个，
//                 回退轨迹写入返回 message；
//    层2(插件外):核心取链兜底(findFallbackStream)在本尊重搜+全平台失败后,
//                 对「纯 stream 插件」(capabilities 含 stream 不含 search,即本插件)
//                 逐个调 resolveStream(config, song) —— 按歌 sourceData 里的
//                 平台原生 ID 直查;probe 通过才换链。
//
//  失败可见(不静默)：下载失败/语法错/顶层抛错/未注册/取链 403/超时，
//  都在返回值 message 与日志里给出原文与位置。
// ============================================================================

globalThis.__mfPlugin = {
  manifest: {
    id: "lx-source",
    name: "洛雪音源",
    version: "1.1.4",
    type: "source",
    description:
      "洛雪(LX Music)音源内联运行时(纯取链):把你自己的洛雪音源 .js 直接放进 MusicFlow 沙箱执行," +
      "按歌曲平台 ID 直查洛雪 musicUrl 换播放直链(多音源自动轮切),供核心取链兜底跨插件调用。" +
      "不提供搜索/歌单/推荐/歌词/封面 —— 洛雪官方协议(request actions 只有 musicUrl/lyric/pic)根本不支持搜索," +
      "实测音源搜索自答 0/12,这些能力全部移除;找歌由 go-music-dl 等插件负责。" +
      "注意:本插件会在你的 MusicFlow 服务进程内执行第三方音源脚本,等价于运行不是你写的程序,请只添加你信任的音源;默认不启用。",
    capabilities: [
      "stream",
    ],
    platforms: ["kw", "kg", "tx", "wy", "mg"],
    platformLabels: { kw: "酷我", kg: "酷狗", tx: "企鹅音乐", wy: "网易云", mg: "咪咕" },
    defaultEnabled: false,
    minAppVersion: "4.0.84",
    // test/health/resolveStream 都要全量加载所有音源:12 个源串行远超默认 20s 墙钟预算。
    // 但不能只写 longRunning —— 那会把方法路由到 worker 线程,而 worker 下
    // host.jsenv 一律 UNSUPPORTED。longRunningInMain(后端 >= 4.0.76)让这两个方法
    // 拿到长预算 + 软看门狗(await 网络不计时),同时强制留在主线程。
    // resolveStream(纯取链兜底入口)同理:首次冷启动要把 12 个音源脚本下载+在 jsenv
    // 里执行完才有链可换,20s 默认预算实测必超时(240 真机实测
    // 「沙箱限制:单次调用超时(配额 20000ms)」),故与 test 同级给 300s。
    longRunning: { test: 300000, health: 300000, resolveStream: 300000 },
    longRunningInMain: ["test", "health", "resolveStream"],
    permissions: ["net", "fs", "log", "jsenv", "crypto"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl: "https://github.com/ray5378/MusicFlow-plugins/releases/download/lx-source-v1.1.4/lx-source.tar.gz",
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
        key: "sourcePreference",
        label: "音源优先顺序",
        type: "text-list",
        default: ["wy", "kg", "kw", "tx"],
        help: "一行一个洛雪平台 key(wy/kg/kw/tx/mg)，越靠前越先尝试；未列出的平台排在最后。留空=按音源列表顺序。",
      },
      {
        key: "concurrency",
        label: "并发加载音源数",
        type: "number",
        default: 6,
        help: "取链/自检时并发加载几个音源(1~8)。插件必须主线程执行(jsenv 子环境不能在 worker 里用),受默认 20 秒预算约束,音源多时需要并发才跑得完",
      },
      {
        key: "cacheTtlHours",
        label: "音源脚本缓存有效期(小时)",
        type: "number",
        default: 24,
        help: "URL 音源的脚本缓存到插件目录后的有效期(小时,0=永不过期)。缓存命中时不再联网下载,出网不稳定的环境靠它把音源固化下来",
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
        help: "某音源返回空结果时自动改用下一个可用音源(有些音源对部分曲目没有直链)",
      },
    ],
    documentation:
      "### 功能(纯取链)\n把洛雪音乐音源 .js 直接跑在 MusicFlow 沙箱里,按歌曲的平台 ID 直查洛雪 musicUrl 换播放直链,\n" +
      "多音源自动轮切(报错/无链自动切下一个)。供核心取链兜底跨插件调用:go-music-dl 等本尊插件\n" +
      "重搜+全平台都取不到可播直链时,核心对本插件调 resolveStream —— 按歌曲 sourceData 里的\n" +
      "平台原生 ID(网易云 ID/酷我 ID…)直接换链,不需要搜索。实测可用:kuwo(全豆要)、netease(统一/星海,支持 flac 无损)。\n\n" +
      "### 能力边界(为什么不提供搜索)\n洛雪官方协议的 request actions 只有 musicUrl(在线源)/musicUrl+lyric+pic(本地源),\n" +
      "根本没有 musicSearch —— 搜索从来不是洛雪生态的能力,实测 12 音源搜索自答 0/12。\n" +
      "因此本插件 capabilities 只声明 stream,搜索/歌单/推荐/歌词/封面一律由 go-music-dl 等插件提供。\n\n" +
      "### 风险提示\n本插件会在你的 MusicFlow 服务进程内执行第三方音源脚本,等同于运行不是你写的程序;\n" +
      "插件不预置任何音源内容。请只添加你信任的音源,并建议在家庭局域网内自用。\n\n" +
      "### 配置\n- 音源列表:一行一个(点 + 添加行、✕ 删除行),每行是 URL 或本地文件名(可带「显示名=...」);旧版分号分隔格式仍兼容;\n" +
      "- 音质档、超时、最大音源数;\n" +
      "- 回退:音源报错 / 无链自动回退到下一个可用音源(可分别开关)。\n\n" +
      "### 失败可见\n下载失败、语法错、顶层抛错(如要求去官网下载新版)、未注册任何源、取链 403/超时,\n" +
      "都会给出原文与脚本位置,并记录回退轨迹,绝不静默返回空结果。\n\n" +
      "### 音源 URL 与「已加载但未注册任何源」\n" +
      "音源 URL 一律用 https://raw.githubusercontent.com/<owner>/<repo>/<分支>/<路径> 直链:" +
      "实测部分内网环境可达 raw.githubusercontent.com 但不可达 cdn.jsdelivr.net,用 jsdelivr 会直接「音源下载失败」。\n" +
      "「已加载但未注册任何源」= 文件下载成功且脚本已在沙箱里执行,但没有完成 sources 注册," +
      "常见于该音源依赖浏览器环境(window/document/localStorage),或需要宿主下发运行期配置才能初始化。\n" +
      "排查看「测试」结果明细里的诊断后缀 (state=…,handlers=N,net=M):handlers=0 且 net=0 说明脚本没挂上任何 lx 监听;" +
      "handlers>0 说明脚本执行了、注册卡在网络或宿主能力;net>0 说明沙箱网络桥已通。",
    i18n: {
      en: {
        name: "LX Music Sources",
        description:
          "Inlines LX Music source scripts into the MusicFlow sandbox as a pure stream-URL resolver: resolves playable " +
          "URLs by the song's platform ID via the LX musicUrl action with automatic multi-source rotation, consumed by " +
          "the core stream-fallback across plugins. No search/playlist/recommend/lyrics/covers — the LX official protocol " +
          "has no search action at all and measured search coverage is 0/12; finding songs is go-music-dl's job. " +
          "Warning: this plugin executes third-party source scripts inside your MusicFlow server process; " +
          "add only sources you trust and keep it LAN-only. Disabled by default.",
        fields: {
          sources: { label: "Sources (one per row)", help: "LX source .js URLs or local file names, one per row; use 'Name=...' to rename." },
          sourceDir: { label: "Source directory", help: "Root dir for local .js sources (default lx-sources); absolute paths ignore this." },
          quality: { label: "Quality", help: "Preferred quality tier when fetching a playable URL." },
          sourcePreference: { label: "Source preference order", help: "One LX platform key per row (wy/kg/kw/tx/mg); earlier rows are tried first. Empty = source list order. Unlisted platforms are tried last." },
          timeoutMs: { label: "Network timeout (ms)", help: "Timeout for a single fetch; on failure the next source is tried." },
          maxSources: { label: "Max sources", help: "0 = load every row; >0 caps how many scripts load at once." },
          fallbackOnError: { label: "Auto fallback on error", help: "Try the next source when one errors (403 / anti-bot / script exception)." },
          fallbackOnEmpty: { label: "Auto fallback on empty", help: "Try the next source when one returns no URL (some sources have no direct link for certain tracks)." },
          concurrency: { label: "Concurrent source loads", help: "How many sources load in parallel during resolve/self-check (1-8). The plugin must run on the main thread (jsenv is unavailable in worker threads) and is bound by the default 20s budget." },
          cacheTtlHours: { label: "Source script cache TTL (hours)", help: "How long a downloaded source script stays cached on disk (0 = never expire). Cache hits skip the network entirely." },
        },
        documentation:
          "### Features (pure stream resolving)\nRuns LX Music source scripts inside the MusicFlow QuickJS sandbox and resolves playable URLs by the song's " +
          "platform ID via the LX musicUrl action, with automatic multi-source rotation. Consumed by the core stream-fallback: " +
          "when the owning provider (go-music-dl etc.) fails on every platform, the core calls resolveStream with the song's " +
          "sourceData (native platform IDs) — no search involved. Verified live: kuwo (qdy) and netease (tongyi/xinghai, flac capable).\n\n" +
          "### Capability boundary (why no search)\nThe LX official protocol defines only musicUrl (online sources) / musicUrl+lyric+pic (local). " +
          "There is no musicSearch action — search was never part of the LX ecosystem; measured search self-answer rate is 0/12. " +
          "Hence this plugin declares only the stream capability; search/playlists/recommend/lyrics/covers belong to go-music-dl and friends.\n\n" +
          "### Warning\nExecutes third-party scripts in your MusicFlow process; add only sources you trust.\n\n" +
          "### Config\n- Sources: one per row (use + to add, ✕ to remove), each a URL or local file name (support 'Name=...' rename); the legacy semicolon-separated format is still accepted;\n- Quality / timeout / max sources;\n" +
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

    // 内容护栏:宿主合法地返回了 200,但 body 是空/网页时会「静默注册不上」——
    // 这类情况必须变成明确的 error,而不是含糊的「已加载但未注册任何源」。
    function badContentReason(code) {
      const t = String(code === undefined || code === null ? "" : code).replace(/^\s+/, "");
      if (!t.length) return "内容为空(宿主返回了空 body)";
      if (t.charAt(0) === "<") return "内容不是 JS 而是 HTML/网页(前 80 字符:" + t.slice(0, 80) + ")";
      return null;
    }

    async function httpText(url, timeoutMs) {
      const r = await host.http(url, { method: "GET", timeout: timeoutMs });
      if (!r.ok) {
        const detail = r.error ? " (" + (r.error.message || r.error) + ")" : "";
        throw new Error("HTTP " + (r.status == null ? "?" : r.status) + ": " + url + detail);
      }
      const body = String(r.body);
      const why = badContentReason(body);
      if (why) throw new Error("HTTP 200 但 " + why + ",原始地址:" + url);
      return body;
    }

    function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
    function isHttpUrl(u) { return typeof u === "string" && /^https?:\/\//i.test(u.trim()); }

    // ---------------- 指纹:隔离每个音源的 jsenv 子环境与加载结果缓存 ----------------
    // 目标:同一个下标换了脚本时,绝不能再命中上一次的子环境/缓存(否则改完音源列表
    // 再点测试拿到的是旧结果 —— 假阳性)。md5 优先(需 crypto 权限);权限缺失或宿主
    // 没提供时退化到内置字符串哈希,不引入任何依赖。
    function hashStr(s) {
      let h = 5381;
      const str = String(s === undefined || s === null ? "" : s);
      for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) & 0x7fffffff;
      return h.toString(36);
    }
    function fingerprint(parts) {
      const raw = parts.join("|");
      try {
        if (host.crypto && typeof host.crypto.md5 === "function") {
          const v = host.crypto.md5(raw);
          if (typeof v === "string" && v.length) return v.slice(0, 16);
        }
      } catch (_) {}
      return "h" + hashStr(raw);
    }
    // 缓存 key 只依赖「下标 + 目标串」:下载前就能算出来,命中就不必重复下载/重建环境
    function cacheKey(item, idx) { return idx + ":" + fingerprint([item.target]); }

    // 洛雪 songInfo -> OnlineSongResult(保留原始 musicInfo 供取链/歌词复用)
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

    // ---- URL 音源的磁盘缓存:出网不稳时,下载成功的脚本固化下来,之后直接读盘 ----
    function cacheFileFor(target, dir) {
      const fp = fingerprint([target]).slice(0, 12);
      let base = "";
      try {
        const u = String(target).split("?")[0];
        base = decodeURIComponent(u.substring(u.lastIndexOf("/") + 1));
      } catch (_) { base = ""; }
      base = String(base).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
      if (!base || !/\.js$/i.test(base)) base = (base || "src") + ".js";
      return String(dir) + "/" + fp + "-" + base;
    }

    async function readDiskCache(relPath) {
      const ttlH = clamp(cfgNum("cacheTtlHours", 24), 0, 720, 24);
      let st = null;
      try { st = await host.fs.stat(relPath); } catch (_) { return null; }
      if (!st || !st.size) return null;
      if (ttlH > 0) {
        const age = Date.now() - Date.parse(String(st.mtime || ""));
        if (Number.isFinite(age) && age > ttlH * 3600 * 1000) return null;
      }
      try {
        const raw = String(await host.fs.readFile(relPath, "utf8"));
        if (badContentReason(raw)) return null;
        return raw;
      } catch (_) { return null; }
    }

    async function writeDiskCache(relPath, code) {
      try {
        const i = relPath.lastIndexOf("/");
        if (i > 0) { try { await host.fs.mkdir(relPath.slice(0, i), { recursive: true }); } catch (_) {} }
        await host.fs.writeFile(relPath, code, "utf8");
      } catch (_) { /* 缓存失败不影响主流程 */ }
    }

    async function loadOne(item, idx, timeoutOverride) {
      const dir = cfgStr("sourceDir", "lx-sources");
      const timeoutMs = (typeof timeoutOverride === "number" && timeoutOverride > 0)
        ? timeoutOverride
        : cfgNum("timeoutMs", 15000);
      const ck = cacheKey(item, idx);
      // 先用「目标串」兜个名字(下载失败时也要有 envName 字段),拿到脚本后再换成完整指纹
      let envName = "lx-source:" + idx + ":" + fingerprint([item.target]);
      let code = null;
      let origin = item.target;

      if (item.isUrl) {
        const cf = cacheFileFor(item.target, dir);
        code = await readDiskCache(cf);
        if (code) {
          origin = item.target + " [本地缓存]";
        } else {
          try { code = await httpText(item.target, timeoutMs); }
          catch (e) {
            const err = "音源下载失败: " + item.target + " -> " + ((e && e.message) || e);
            log(err);
            return { idx: idx, envName: envName, name: item.name || "", state: "error", error: err, origin: origin };
          }
          await writeDiskCache(cf, code);
        }
      } else {
        const p = /^\/|^[A-Za-z]:[\\/]/.test(item.target) ? item.target : dir + "/" + item.target;
        try {
          const raw = String(await host.fs.readFile(p, "utf8"));
          const why = badContentReason(raw);
          if (why) throw new Error(why);
          code = raw;
        }
        catch (e) {
          const err = "音源文件读取失败: " + p + " -> " + ((e && e.message) || e);
          log(err);
          return { idx: idx, envName: envName, name: item.name || "", state: "error", error: err, origin: origin };
        }
        origin = p;
      }

      const head = parseLxHeader(code);
      // 完整指纹 = 目标 + 脚本内容长度 + 音源头版本:同一 idx 换了脚本(或同一 URL 内容变了)
      // 必然得到新的 envName,从而落到全新的子环境上。
      envName = "lx-source:" + idx + ":" + fingerprint([item.target, code.length, head.version]);
      const rec = {
        idx: idx, envName: envName, cacheKey: ck, name: item.name || head.name || ("src" + idx),
        version: head.version, author: head.author, description: head.description,
        updateUrl: head.updateUrl, origin: origin, state: "loading", error: null,
        len: String(code).length,
        sources: [], srcInfo: {}, actions: [], handlers: [], netHits: 0,
      };

      try {
        // 无条件先销毁同名环境:宿主 jsenv.create 对已存在的同名环境是【直接返回、
        // 不重跑 initCode】,不清掉的话改了音源列表还会复用旧子环境 —— 测试结果
        // 就是上一次的(假阳性)。指纹 + 销毁双保险。destroy 对不存在的名字是空操作。
        try { await host.jsenv.destroy(envName); } catch (_) {}
        await host.jsenv.create(envName, SHIM + "\n" + code);
      } catch (e) {
        const msg = String((e && e.message) || e);
        rec.state = "error";
        // 顶层抛错(如要求去官网下载新版)必须原样透出,不许注册成空音源
        rec.error = "音源脚本加载失败(执行阶段): " + origin + " -> " + msg;
        log(rec.error);
        try { await host.jsenv.destroy(envName); } catch (_) {}
        return rec;
      }

      try {
        // ⚠️ 时序关键:宿主 jsenv.create 里 evalCode 之后【不推进 jobs】,而 execute 是
        //「先 drainNet → evalCode → 再 pump」。探针是 sync 取快照,单轮读到的是「泵之前」
        // 的状态 —— 异步注册(await 之后才 lx.on/lx.send)的音源会被误判成
        // 「已加载但未注册任何源」。
        // 补救:连续最多 4 轮 execute。每轮 execute 都会 drain 一次网络 + pump 一轮 jobs,
        // 第 N 轮的探针读到的是第 N-1 轮泵之后的状态,足以覆盖「注册要等网络回来」的脚本。
        // 注意:探针必须保持【同步】返回字符串 —— 返回 Promise 时宿主 execute 的
        // resolvePromise+pumpJobs 取值链路实测不稳(QA harness 里直接取不到值)。
        const probe = "(function(){try{return JSON.stringify({s:globalThis.__lxState.sources?Object.keys(globalThis.__lxState.sources):null," +
          "info:globalThis.__lxState.sources?Object.fromEntries(Object.entries(globalThis.__lxState.sources).map(function(kv){return [kv[0],{actions:(kv[1]&&kv[1].actions)||[],qualitys:(kv[1]&&kv[1].qualitys)||[]}]})):{}," +
          "h:Object.keys(globalThis.__lxState.handlers),n:(globalThis.__lxState.net||[]).length});}catch(e){return JSON.stringify({s:null,error:String(e)})}})()";
        let info = null;
        const pT0 = Date.now();
        for (let round = 0; round < 4; round++) {
          // 这一轮只有副作用:让宿主 drain 网络 + pump jobs,下一轮再取值
          // 单源已耗过 6s 就不再多轮:宿主 invoke 预算只有 20s,不能让一个源吃光
          if (round > 0) {
            if (Date.now() - pT0 > 6000) break;
            try { await host.jsenv.execute(envName, "void 0;"); } catch (_) {}
          }
          const r = await host.jsenv.execute(envName, probe);
          try { info = JSON.parse(r && r.result ? r.result : "null"); } catch (_) { info = null; }
          if (info && info.s && info.s.length) break;
        }
        if (info && info.s && info.s.length) {
          rec.state = "ready";
          rec.sources = info.s;
          rec.srcInfo = info.info || {};
          rec.handlers = info.h || [];
          rec.netHits = info.n || 0;
          const acts = {};
          info.s.forEach(function (sid) { ((rec.srcInfo[sid] || {}).actions || []).forEach(function (a) { acts[a] = 1; }); });
          rec.actions = Object.keys(acts);
          // 音源头 @version 常写成 "v1.2.0",无条件补 v 会显示成 vv1.2.0
          const hver = String(rec.version || "");
          log("音源注册成功: " + rec.name + " " + (/^v/i.test(hver) ? hver : "v" + (hver || "?")) + " 源=" + info.s.join(",") + " actions=" + (rec.actions.join(",") || "-"));
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
      // 同一 idx 换了脚本后旧 key 必须失效,否则 search/stream 会命中上一份 rec
      Object.keys(cache).forEach(function (k) {
        if (k !== ck && k.indexOf(idx + ":") === 0) delete cache[k];
      });
      cache[ck] = rec;
      return rec;
    }

    // 分批并发加载:不声明 longRunning 是因为 longRunning 会把方法路由到 worker 线程,
    // 而 worker 下 host.jsenv 一律 UNSUPPORTED。代价是只能跑主线程,受宿主默认 20s 预算约束,
    // 串行加载 12 个音源必然超时,故按 concurrency 分批并发。
    // 总预算:宿主主线程 invoke 预算 20s(sandbox.ts INVOKE_TIMEOUT_MS),留 5s 余量做汇总与返回。
    const LOAD_BUDGET_MS = 15000;

    async function loadAll(items) {
      function mkErr(i, msg) {
        const it = items[i] || {};
        return { idx: i, name: it.name || "", version: "", origin: it.target || "",
          state: "error", error: msg, sources: [], actions: [], handlers: [], netHits: 0 };
      }
      const conc = clamp(cfgNum("concurrency", 6), 1, 12, 6);
      // 测试期单源超时压低:默认 15000 会让一批就吃掉整个预算
      const perMs = Math.min(clamp(cfgNum("timeoutMs", 15000), 1000, 15000, 15000), 6000);
      const t0 = Date.now();
      const out = new Array(items.length);
      let cut = false;
      for (let base = 0; base < items.length; base += conc) {
        const left = LOAD_BUDGET_MS - (Date.now() - t0);
        if (left <= 0) { cut = true; break; }
        const end = Math.min(base + conc, items.length);
        const jobs = [];
        for (let i = base; i < end; i++) {
          jobs.push(
            loadOne(items[i], i, perMs).then(
              function (rec) { out[i] = rec || mkErr(i, "加载无返回"); },
              function (e) { out[i] = mkErr(i, "加载抛出异常: " + String((e && e.message) || e)); }
            )
          );
        }
        await Promise.all(jobs);
      }
      for (let i = 0; i < out.length; i++) {
        if (!out[i]) {
          out[i] = cut
            ? mkErr(i, "本次时间预算内未加载(已加载的会进缓存,再次点击测试可继续)")
            : mkErr(i, "加载无返回");
        }
      }
      return out;
    }
    async function readySources() {
      const max = clamp(cfgNum("maxSources", 0), 0, 200, 0);
      const all = parseList(cfg().sources);
      const items = max > 0 ? all.slice(0, max) : all;
      const out = [];
      for (let i = 0; i < items.length; i++) {
        const key = cacheKey(items[i], i);
        const rec = cache[key] && cache[key].state !== "loading" ? cache[key] : await loadOne(items[i], i);
        if (rec.state === "ready") out.push(rec);
      }
      const pref = cfgArr("sourcePreference");
      if (pref.length) {
        const rank = (x) => { const i = pref.indexOf(x); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
        out.sort((a, b) => rank(a.sources[0]) - rank(b.sources[0]));
      }
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
      // handler 的网络请求可能超过单次 execute 的 pump 预算(宿主 8s):预算耗尽时
      // __lxState.result 还没写回。每多 execute 一次宿主就 drain 一次网络 + 泵一轮
      // jobs,所以取到 null 就继续泵,最多 3 轮(累计约 24s 等待上限)。
      let parsed = null;
      for (let wait = 0; wait < 3 && !parsed; wait++) {
        if (wait > 0) { try { await host.jsenv.execute(rec.envName, "void 0;"); } catch (_) {} }
        const r = await host.jsenv.execute(rec.envName, "JSON.stringify(globalThis.__lxState.result)");
        try { parsed = JSON.parse(r && r.result ? r.result : "null"); } catch (_) { parsed = null; }
      }
      if (!parsed) throw new Error("音源无返回(沙箱交互失败,已泵 3 轮): " + rec.name);
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

    // gmd/核心渠道平台名 → 洛雪源 key(wy/kg/kw/tx/mg);qianqian/soda 洛雪无对应,
    // 返回原值让源脚本自行判断(它会明确报「不支持」而不是伪造成功)。
    const GMD_TO_LX = { netease: "wy", kugou: "kg", kuwo: "kw", qq: "tx", migu: "mg", wy: "wy", kg: "kg", kw: "kw", tx: "tx", mg: "mg" };
    function lxSourceKeyOf(song) {
      let src = String((song && song.source) || "");
      if (!src && song && song.sourceData) {
        try { src = String((safeParse(song.sourceData) || {}).source || ""); } catch (e) { src = ""; }
      }
      return GMD_TO_LX[src] || src || "";
    }

    /**
     * 取「平台原生歌曲 ID」。核心取链兜底(findFallbackStream)传进来的是**库内歌曲**:
     * 平台原生 ID 在 sourceData.remoteId(网易云 1323099451 这类),而 song.id 是
     * MusicFlow 自己的 UUID。UUID 当平台 ID 发给音源必然取不到有效直链
     * (2026-10-04 240 实测:酷狗型音源把 UUID 当 id,回了一个 301 跳 HTML 的代理链,
     * 核心 probe 判不可播 → 整条兜底白跑)。故:sourceData 优先,缺失才回退 song.id。
     */
    function nativeSongIdOf(song) {
      if (song && song.sourceData) {
        try {
          const sd = typeof song.sourceData === "string" ? safeParse(song.sourceData) : song.sourceData;
          const ex = (sd && sd.extra) || {};
          const id = (sd && (sd.remoteId || sd.songId || sd.id)) || ex.song_id || ex.songId || ex.id;
          if (id !== undefined && id !== null && String(id) !== "") return String(id);
        } catch (e) { /* 解析失败则回退 */ }
      }
      return String((song && song.id) || "");
    }

    // 用洛雪 musicUrl action 取直链;song.extra.lx 里保存了搜索时的原始 musicInfo
    async function resolveStreamUrl(rec, song) {
      const ids = sourceIdsWithAction(rec, ["musicUrl"]);
      if (!ids.length) throw new Error("该音源未声明 musicUrl 能力");
      let musicInfo = null;
      if (song && song.extra && song.extra.lx) musicInfo = safeParse(song.extra.lx);
      if (!musicInfo || typeof musicInfo !== "object") {
        // 2026-10-03 真机 mock 实测:musicInfo 必须携带 source 平台键(洛雪规范字段),
        // 聚合型源(统一/星海等)读它分流上游 —— 不带会直接报「暂不支持此音源」。
        // 按平台 ID 直查时 ID 就写在 songmid/hash/id 三个键上(洛雪各端兼容读法)。
        // 平台原生 ID(见 nativeSongIdOf 说明):绝不能把 MusicFlow 的 UUID 当平台 ID 发出去。
        const sid = nativeSongIdOf(song);
        musicInfo = { songmid: sid, hash: sid, id: sid, name: song && (song.name || song.title), singer: song && song.artist, albumName: song && song.album, source: lxSourceKeyOf(song) };
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

    // 「软失败空结果」契约:优先用核心注入的 host.fallback.makeEmptyResult(新版核心),
    // 拿到的是与核心兜底层同构的形状 {empty,message,trace,songs:[]};
    // 拿不到(老核心 / 非沙箱环境)就退回手写同形状对象 —— 契约本身向后兼容。
    function softEmpty(message, trace) {
      try {
        if (host && host.fallback && typeof host.fallback.makeEmptyResult === "function") {
          return host.fallback.makeEmptyResult(message, trace || []);
        }
      } catch (e) {
        log("makeEmptyResult 不可用,回退手写空结果: " + String((e && e.message) || e));
      }
      return { empty: true, message: String(message || ""), trace: trace || [] };
    }

    // 音源级自动回退:报错 / 空结果都按配置切下一个可用音源,轨迹回传调用方
    async function withFallback(kind, fn) {
      const fbErr = cfgOn("fallbackOnError", true);
      const fbEmpty = cfgOn("fallbackOnEmpty", true);
      const list = await readySources();
      if (!list.length) {
        return softEmpty("没有可用的洛雪音源:请在插件配置「音源列表」里添加至少一个 .js URL 或本地文件名(音源加载失败会在插件页与日志显示原因)。");
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
      // 插件内全部音源都用尽 = 本插件自身软失败:回这个空结果,核心(core-search-fallback)
      // 会据此再改用其它已启用源插件试一次(插件内的轮切与核心的跨插件兜底是两层,各管一段)。
      return softEmpty("全部洛雪音源均无结果(" + trace.length + " 次回退): " + trace.join(" | "), trace);
    }

    // ---------------- 方法(与 go-music-dl 方法面对齐) ----------------
    return {
      async health() {
        // 口径与 test() 对齐:全量加载,不受 maxSources 限制。只扫前 N 个会把后面
        // 其实可用的音源漏掉,导致 status 被误判成 down(这是 status 约定里的错报)。
        const items = parseList(cfg().sources);
        const list = await loadAll(items);
        const readyCount = list.filter((r) => r.state === "ready").length;
        // 核心 plugins/health.ts pingPlugin() 只认 {status: ok|degraded|down},缺字段会被判「未监控」:
        // 无音源=degraded(配置缺失),全就绪=ok,部分就绪=degraded,全部失败=down。
        // 原 ok/items/message 字段保持不变,向后兼容已有调用方。
        const noSrcCount = list.filter((r) => r.state === "ready_no_sources").length;
        const errCount = list.filter((r) => r.state === "error").length;
        const status = list.length === 0 ? "degraded" : readyCount === 0 ? "down" : readyCount === list.length ? "ok" : "degraded";
        return {
          status: status,
          ok: list.length > 0 && list.every((r) => r.state === "ready"),
          items: list.map((r) => ({ name: r.name, version: r.version, author: r.author, origin: r.origin, state: r.state, error: r.error, len: r.len, sources: r.sources, actions: r.actions, handlers: r.handlers, netHits: r.netHits })),
          message:
            list.length === 0
              ? "未配置任何音源:请在「音源列表」里添加至少一个 .js URL 或本地文件名。"
              // 失败 = 总数 - 就绪(含 ready_no_sources);只数 state==="error" 会出现
              // 「14 个音源,就绪 7 个,失败 5 个」这种 7+5≠14 的自相矛盾文案。
              // 括号里把两类失败拆开,三项相加恒等于总数。
              : list.length + " 个音源,就绪 " + readyCount + " 个,失败 " + (list.length - readyCount) +
                " 个(注册无源 " + noSrcCount + " 个 / 加载出错 " + errCount + " 个)。",
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
          const items = parseList(raw);
          if (!items.length) {
            return { success: false, message: "未配置任何音源:请在「音源列表」里添加至少一个 .js URL 或本地文件名,再点测试。" };
          }

          // 单行压缩:去掉换行与连续空白,超长截断(保留前 n-1 字符 + 省略号)
          const brief = (s, n) => {
            const t = String(s === undefined || s === null ? "" : s).replace(/\s+/g, " ").trim();
            return t.length > n ? t.slice(0, n - 1) + "…" : t;
          };
          // 错误摘要:超限时保留【首尾】(前 60 + … + 后 20)。只截尾巴会把根因丢掉
          // —— HTTP 状态码、异常类型、URL 域名/路径尾部往往就在末段。
          const briefErr = (s, n, tail) => {
            const t = String(s === undefined || s === null ? "" : s).replace(/\s+/g, " ").trim();
            if (t.length <= n) return t;
            const headN = n - tail;
            return t.slice(0, headN > 0 ? headN : n - 1) + "…" + t.slice(-tail);
          };

          const okList = [];
          const badList = [];
          const all = await loadAll(items);
          for (let i = 0; i < all.length; i++) {
            const rec = all[i];
            if (rec.state === "ready") okList.push({ no: i + 1, rec: rec });
            else badList.push({ no: i + 1, rec: rec, target: items[i].target });
          }

          const okItems = okList
            .map(function (o) {
              const r = o.rec;
              const plat = r.sources && r.sources.length ? r.sources.join(",") : "未注册源";
              const acts = r.actions && r.actions.length ? r.actions.join(",") : "-";
              // 音源头 @version 常写成 "v1.2.0",无条件补 v 会显示成 [vv1.2.0]
              const ver = String(r.version || "");
              const vtag = /^v/i.test(ver) ? ver : "v" + (ver || "?");
              return o.no + ". " + brief(r.name || r.origin, 24) + "[" + vtag + "](" + plat + ",actions=" + acts + ")";
            });
          const okBriefItems = okList
            .map(function (o) { return o.no + "." + brief(o.rec.name || o.rec.origin, 16); });
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
          const badItems = badList
            .map(function (b) {
              const r = b.rec;
              const diag = "(state=" + r.state + ",handlers=" + ((r.handlers && r.handlers.length) || 0) + ",net=" + (r.netHits || 0) + ",len=" + (r.len == null ? "?" : r.len) + ")";
              return b.no + ". " + brief(r.name || r.origin || b.target, 24) + " → " + briefErr(r.error || "未注册任何源(原因未知)", 80, 20) + " " + diag;
            });

          const head = "共 " + items.length + " 个音源:可用 " + okList.length + " 个,不可用 " + badList.length + " 个。";
          // 每侧最多列 15 条,超出的用「另有 X 个…未显示」点明并被日志兜住,
          // 避免以前那种「整段静默消失 / 无提示硬截断」。
          const LIST_MAX = 15;
          const moreNote = (total, shown, label) => (total > shown ? " …另有 " + (total - shown) + " 个" + label + "未显示(详见服务端日志)" : "");
          const build = (cap, useBriefOk) => {
            const bl = badList.length
              ? "不可用 " + badList.length + " 个:" + badItems.slice(0, cap).join(" | ") + moreNote(badList.length, cap, "不可用")
              : "";
            const shownOk = useBriefOk ? okBriefItems : okItems;
            const ol = okList.length
              ? "可用 " + okList.length + (useBriefOk ? " 个(摘要):" : " 个:") + shownOk.slice(0, cap).join(" | ") + moreNote(okList.length, cap, "可用")
              : "";
            return head + (bl ? "\n" + bl : "") + (ol ? "\n" + ol : "");
          };

          // 降级顺序:15 条明细 -> 8 条明细 -> 可用侧再压缩成纯名称 -> 兜底截断
          let message = build(LIST_MAX, false);
          if (message.length > 1200) message = build(8, false);
          if (message.length > 1200) message = build(8, true);
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

      /** 同步方法(契约:纯同步,返回 string)。直链来自 resolveStream 的缓存;未命中返回 ""(播放时走核心换源兜底)。 */
      streamUrl(config, song) {
        const direct = pick(song || {}, ["url", "playUrl", "playUrl", "downloadUrl"], null);
        if (typeof direct === "string" && isHttpUrl(direct)) return direct;
        const exUrl = song && song.extra && (song.extra.playUrl || song.extra.url);
        if (typeof exUrl === "string" && isHttpUrl(exUrl)) return exUrl;
        const hit = urlCache[songKey(song)] || urlCache[songTitleKey(song)] || "";
        if (hit) return hit;
        log("streamUrl 未命中缓存: " + songKey(song) + " (未命中时播放走核心换源兜底)");
        return "";
      },

      /**
       * 异步按 ID 直查(核心跨插件取链兜底的入口,2026-10-04 契约):
       * 本尊重搜+全平台失败后,核心对本插件调 resolveStream(config, song) ——
       * 按歌的 sourceData(source=平台名, remoteId=平台原生歌曲 ID)直接走
       * 洛雪源脚本 musicUrl 换直链,多音源轮切,不需要搜索。
       * 返回契约:成功=直链 URL 字符串;失败/无链=空串 ""(不抛错)。
       */
      async resolveStream(config, song) {
        try {
          const r = await withFallback("url", async (rec) => {
            const url = await resolveStreamUrl(rec, song);
            cacheUrl([songKey(song), songTitleKey(song)], url);
            return { url: url, source: rec.name };
          });
          const url = r && (typeof r === "string" ? r : (r.url || r.playUrl || ""));
          if (isHttpUrl(url)) return url;
          const msg = r && r.message ? String(r.message).slice(0, 160) : "无可用直链";
          log("resolveStream 未命中(" + songKey(song) + "): " + msg);
          return "";
        } catch (e) {
          log("resolveStream 失败(" + songKey(song) + "): " + String((e && e.message) || e));
          return "";
        }
      },

      canHandle() { return false; },
    };
  },
};
