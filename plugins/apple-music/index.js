// ============================================================================
//  MusicFlow 外置插件：Apple Music 榜单 (recommender)
// ----------------------------------------------------------------------------
//  抓取 Apple Music 中国区官方榜单与编辑歌单并同步到本地音乐库(已入库)。
//  榜单构成(全部长期稳定):
//    - 每日热门歌曲:charts API(most-played songs,每日更新,最多 200 首)
//    - 每周热门 100 首:官方编辑歌单,pl. ID 永久固定(大陆/全球/香港/韩/日/美)
//    - 城市 Top 25:官方编辑歌单,pl. ID 永久固定(上海/北京/成都/广州/武汉)
//    - 热门歌单排行:Apple 官方 RSS 每日榜单(动态排名,同步为排行位次歌单)
//  首页展示走「本地歌单(localPlatformRecommend)」接口：直接读取本地库字段,
//  点击即本地播放,三端(Web/客户端/HA)统一走本地库直连。
//
//  数据通道(全部实测,本插件零硬编码凭据):
//    1. MusicKit Web API(api.music.apple.com/v1/catalog/cn/...):
//       歌单曲目/搜索/charts,字段完整(名称/歌手/专辑/时长毫秒)。
//       鉴权用 web player JWT——运行时从 music.apple.com 首页壳页找到 JS 主包
//       地址并提取(Apple 约每 2 个月轮换,动态抓取天然自续;401 自动重抓一次)。
//    2. Apple 官方 RSS(rss.marketingtools.apple.com):热门歌单排行,无需鉴权。
//    注意:歌单详情页是纯 SPA(plain fetch 只有壳),曲目必须走 API;
//    iTunes Search API 已废(歌曲搜索恒 0 结果),不可用。
//
//  直链:Apple 仅提供 30s 试听(previews),无全曲直链——不实现 streamUrl,
//  落库为空直链 web 行,首播由核心换源兜底(findFallbackStream)出流,与
//  huawei-chart 同款形态。
//
//  通用能力契约(SPEC §1.6.3):库内匹配先 host.songs.match(核心 v2.3.9+),
//  matchLocal 仅作旧宿主回退;host.sources.complete 必须透传 album+duration;
//  search 能力作为导入门禁的同平台核实源(crossVerifySongs)。
//
//  沙箱契约(QuickJS VM 内运行,拿不到 Node 能力):
//    - 纯 JS 脚本:globalThis.__mfPlugin = { manifest, create(host) };
//    - 网络走 host.http(url, { method, headers, timeout });
//    - host.config 每次调用前刷新为最新插件配置;
//    - 权限:manifest.permissions 声明的能力可用。
// ============================================================================

globalThis.__mfPlugin = {
  manifest: {
    id: "apple-music",
    name: "Apple Music 榜单",
    version: "1.0.0",
    type: "recommender",
    schedules: true,
    description:
      "抓取 Apple Music 中国区官方榜单并同步到本地库：每日热门歌曲（charts API）、每周热门 100 首（大陆/全球/香港/韩/日/美，官方歌单 ID 永久固定）、城市 Top 25（上海/北京/成都/广州/武汉）、热门歌单排行（官方 RSS 每日动态排名）。歌曲自带标题/歌手/专辑/时长，门禁四维核实有料可核。首页以「本地歌单」分区直接展示已入库榜单，无需导入即可播放。同时支持搜索 Apple Music 官方歌单与歌曲：歌单页/歌曲页「聚合」搜索或单独搜索并导入，歌曲搜索同时作为歌单导入门禁的同平台核实源。Apple 无全曲直链（仅 30s 试听），落库为空直链 web 行，首播自动换源出流。",
    capabilities: ["localPlatformRecommend", "playlistSearch", "playlistSongs", "search", "songSearch"],
    platforms: ["apple"],
    platformLabels: { apple: "Apple Music" },
    defaultEnabled: true,
    minAppVersion: "1.7.39",
    longRunning: { runDailyJob: 180000, searchPlaylists: 20000, playlistSongs: 120000, search: 20000, searchSongs: 20000 },
    permissions: ["net", "storage", "songs:read", "songs:write", "playlists:write"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl:
      "https://github.com/ray5378/MusicFlow-plugins/releases/download/apple-music-v1.0.0/apple-music.tar.gz",
    configSchema: [
      {
        key: "chartIds",
        label: "选择榜单（可多选）",
        type: "multiselect",
        required: true,
        options: [
          { value: "daily-songs", label: "每日热门歌曲" },
          { value: "weekly-cn", label: "每周热门100首·中国大陆" },
          { value: "weekly-global", label: "每周热门100首·全球" },
          { value: "weekly-hk", label: "每周热门100首·中国香港" },
          { value: "weekly-kr", label: "每周热门100首·韩国" },
          { value: "weekly-jp", label: "每周热门100首·日本" },
          { value: "weekly-us", label: "每周热门100首·美国" },
          { value: "city-shanghai", label: "城市榜 Top25·上海" },
          { value: "city-beijing", label: "城市榜 Top25·北京" },
          { value: "city-chengdu", label: "城市榜 Top25·成都" },
          { value: "city-guangzhou", label: "城市榜 Top25·广州" },
          { value: "city-wuhan", label: "城市榜 Top25·武汉" },
          { value: "hot-today", label: "今日热门（官方歌单）" },
          { value: "hot-mandopop", label: "热播金曲·国语流行" },
          { value: "alist-mandopop", label: "A-List·国语流行" },
          { value: "hot-playlists-top10", label: "热门歌单排行 TopN（每日动态）" },
        ],
        default: ["daily-songs"],
        help: "选择要同步的 Apple Music 官方榜单/歌单，可以多选。每周热门/城市榜/固定歌单的 pl. ID 由 Apple 官方长期维护，内容自动更新。",
      },
      {
        key: "hotPlaylistCount",
        label: "热门歌单排行数量",
        type: "number",
        default: 10,
        help: "选择「热门歌单排行 TopN」时,每日同步榜单前几名官方歌单(1~30,默认 10)",
      },
      {
        key: "homeCount",
        label: "首页展示歌单数",
        group: "recommend",
        type: "number",
        default: 6,
        help: "首页「本地歌单」展示多少个已入库榜单(1~50,默认 6)",
      },
      {
        key: "sortOrder",
        label: "首页显示顺序",
        group: "recommend",
        type: "number",
        default: 34,
        help: "数值越小越靠前。QQ榜单(30)/酷狗榜单(31)/网易云榜单(32)/华为音乐榜单(33)/Apple Music榜单(34)按此值在首页「本地歌单」分区排列(1~100,默认 34)",
      },
      {
        key: "filterPlatforms",
        label: "歌单筛选平台",
        group: "frontend",
        type: "multiselect",
        options: [
          { value: "apple", label: "Apple Music" },
        ],
        help: "选择在歌单页「筛选歌单」下拉中显示哪些平台,未选中的平台不会出现在筛选列表。默认全选。",
      },
    ],
    documentation:
      "### 功能介绍\n自动抓取 Apple Music 中国区官方榜单并同步到本地音乐库，支持多选榜单，在首页「本地歌单」分区展示（直连本地库播放，无需导入）。榜单构成：每日热门歌曲（charts API）、每周热门 100 首、城市 Top 25（官方编辑歌单，ID 永久固定）、热门歌单排行（官方 RSS 每日动态排名）。\n\n### 歌单/歌曲搜索\n与 go-music-dl 一致：歌单页搜索模式下既参与「聚合」搜索，也可单独选择本插件搜索 Apple Music 官方歌单；点开歌单可预览/直接播放或「加入库」（导入歌曲经导入门禁交叉核实）。歌曲搜索同时作为门禁的同平台核实源。\n\n### 直链说明\nApple 仅提供 30 秒试听，无全曲直链：入库为空直链 web 行，首播由核心换源兜底自动出流（与华为音乐榜单同款形态）。\n\n### 配置说明\n- 选择要同步的榜单，可以多选；\n- 「热门歌单排行 TopN」控制每日动态同步榜单前几名官方歌单；\n- 配置首页「本地歌单」展示的榜单数量；\n- 「歌单筛选平台」控制歌单页「筛选歌单」下拉是否显示 Apple Music。",

    i18n: {
      "en": {
        "name": "Apple Music Charts",
        "description": "Fetches Apple Music (China storefront) official charts into the local library: Daily Top Songs (charts API), Weekly Hot 100 (Mainland/Global/HK/KR/JP/US, permanent official playlist IDs), City Top 25 (Shanghai/Beijing/Chengdu/Guangzhou/Wuhan), and the Hot Playlists ranking (official RSS, updated daily). Songs carry title/artist/album/duration for full import-gate verification. Charts are shown directly in the \"Local Playlists\" section on the home page, ready to play without import. Also searches Apple Music official playlists and songs: joins the \"aggregate\" search modes or can be selected standalone; song search doubles as the same-catalog verification source for the import gate. Apple offers no full-track links (30s previews only), so songs are stored as empty-URL web rows and resolved via the source-fallback on first play.",
        "groups": {
          "recommend": "Recommend",
          "schedule": "Scheduling",
          "frontend": "Frontend"
        },
        "fields": {
          "chartIds": {
            "label": "Select charts (multi-select)",
            "help": "Select which Apple Music official charts/playlists to sync (multi-select). Weekly/City/fixed playlists use permanent official pl. IDs maintained by Apple.",
            "options": {
              "daily-songs": "Daily Top Songs",
              "weekly-cn": "Weekly Hot 100 · Mainland China",
              "weekly-global": "Weekly Hot 100 · Global",
              "weekly-hk": "Weekly Hot 100 · Hong Kong, China",
              "weekly-kr": "Weekly Hot 100 · Korea",
              "weekly-jp": "Weekly Hot 100 · Japan",
              "weekly-us": "Weekly Hot 100 · USA",
              "city-shanghai": "City Top 25 · Shanghai",
              "city-beijing": "City Top 25 · Beijing",
              "city-chengdu": "City Top 25 · Chengdu",
              "city-guangzhou": "City Top 25 · Guangzhou",
              "city-wuhan": "City Top 25 · Wuhan",
              "hot-today": "Today's Hits (official playlist)",
              "hot-mandopop": "Hot Tracks: Mandopop",
              "alist-mandopop": "A-List: Mandopop",
              "hot-playlists-top10": "Hot Playlists Top N (daily)"
            }
          },
          "hotPlaylistCount": {
            "label": "Hot Playlists Top N",
            "help": "When \"Hot Playlists Top N\" is selected, how many top-ranked official playlists to sync daily (1~30, default 10)"
          },
          "homeCount": {
            "label": "Home playlists shown",
            "help": "How many imported charts to show in the \"Local Playlists\" section on the home page (1~50, default 6)"
          },
          "sortOrder": {
            "label": "Home display order",
            "help": "Lower value sorts first. QQ (30) / Kugou (31) / Netease (32) / Huawei (33) / Apple Music (34) charts are arranged by this value in the \"Local Playlists\" section on the home page (1~100, default 34)"
          },
          "filterPlatforms": {
            "label": "Playlist filter platforms",
            "help": "Choose which platforms appear in the \"Filter playlists\" dropdown on the playlist page; unselected platforms do not appear in the filter list. All selected by default.",
            "options": {
              "apple": "Apple Music"
            }
          },
          "scheduleEnabled": {
            "label": "Participate in daily scheduled sync",
            "help": "When off, the daily auto-sync will skip this plugin (the manual refresh button still works)."
          },
          "runOnBoot": {
            "label": "Fetch once on container startup",
            "help": "When on, MusicFlow will fetch this plugin playlists once on every start/restart (keeps chart-type plugins up to date)."
          },
          "batchParallel": {
            "label": "Allow parallel execution",
            "help": "Off (default): this plugin's scheduled/batch jobs always run serially in the global queue; On: allowed to run in parallel with other plugins that enable this switch (uses more CPU but is faster)."
          }
        },
        "documentation": "### Features\nAutomatically fetches Apple Music (China) official charts and syncs them into the local music library. Supports multi-selecting charts; charts are shown in the \"Local Playlists\" section on the home page (played straight from the local library, no import needed). Chart set: Daily Top Songs (charts API), Weekly Hot 100, City Top 25 (permanent official playlist IDs), Hot Playlists ranking (official RSS, daily).\n\n### Playlist & song search\nLike go-music-dl: joins the \"aggregate\" search modes and can be selected standalone. Open a playlist to preview/play directly or import it into the library; imported songs are cross-verified against Apple Music's own catalog via the import gate (search capability).\n\n### Direct links\nApple provides 30-second previews only — songs are stored as empty-URL web rows and resolved via the core source-fallback on first play (same shape as Huawei Music Charts).\n\n### Configuration\n- Select the charts to sync (multi-select);\n- \"Hot Playlists Top N\" controls how many top-ranked official playlists are synced daily;\n- Configure how many charts the \"Local Playlists\" section shows on the home page;\n- \"Playlist filter platforms\" controls whether Apple Music appears in the playlist page filter dropdown."
      }
    },
  },

  create(host) {
    var SOURCE = "apple";
    var API_BASE = "https://api.music.apple.com/v1/catalog/cn";
    var WEB_HOME = "https://music.apple.com/cn/";
    var RSS_BASE = "https://rss.marketingtools.apple.com/api/v2/cn/music/most-played";
    var PLAYLIST_PREFIX = "pl-apple-music-";
    var HOT_PREFIX = "pl-apple-music-hot-";
    var UA = "Mozilla/5.0 (compatible; MusicFlow/1.0)";

    // ==================== 榜单目录 ====================
    // kind: chart=charts API 每日榜 | playlist=固定 pl. ID 官方歌单 | hot=RSS 动态热门歌单排行
    var CHARTS = {
      "daily-songs": { name: "每日热门歌曲", kind: "chart" },
      "weekly-cn": { name: "每周热门100首·中国大陆", kind: "playlist", plId: "pl.939cf56e73c44970b81fd9648f859223" },
      "weekly-global": { name: "每周热门100首·全球", kind: "playlist", plId: "pl.921750b485a6496ea58b16d46c097557" },
      "weekly-hk": { name: "每周热门100首·中国香港", kind: "playlist", plId: "pl.f600030d19174703ab6e37605a6bec08" },
      "weekly-kr": { name: "每周热门100首·韩国", kind: "playlist", plId: "pl.4a5c566712634cb1914ec3d104a9e4db" },
      "weekly-jp": { name: "每周热门100首·日本", kind: "playlist", plId: "pl.417f0970ea794ee9b7c819f6d2324821" },
      "weekly-us": { name: "每周热门100首·美国", kind: "playlist", plId: "pl.6f4d1d4d6eae48579cead6a7bc2a0c0d" },
      "city-shanghai": { name: "城市榜Top25·上海", kind: "playlist", plId: "pl.4cc86bb8172b45f4a2f4aec473176320" },
      "city-beijing": { name: "城市榜Top25·北京", kind: "playlist", plId: "pl.85439c5739b547c6a805a0aede6a7865" },
      "city-chengdu": { name: "城市榜Top25·成都", kind: "playlist", plId: "pl.a91e9af475e447fcb7252f6e0a5aa72e" },
      "city-guangzhou": { name: "城市榜Top25·广州", kind: "playlist", plId: "pl.5b45c8decd4c4c40b40239136fe5b9ff" },
      "city-wuhan": { name: "城市榜Top25·武汉", kind: "playlist", plId: "pl.1812e61fc0d940dd988461238cc8a6b2" },
      "hot-today": { name: "今日热门", kind: "playlist", plId: "pl.f4d106fed2bd41149aaacabb233eb5eb" },
      "hot-mandopop": { name: "热播金曲·国语流行", kind: "playlist", plId: "pl.6d8228f57b864a4296dc02d9761a0d9b" },
      "alist-mandopop": { name: "A-List·国语流行", kind: "playlist", plId: "pl.beb783da7712481fbeed35be144bd48c" },
      "hot-playlists-top10": { name: "热门歌单排行", kind: "hot" },
    };

    // ==================== 基础工具 ====================
    function norm(s) {
      return String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, "");
    }

    async function fetchText(url, headers) {
      var r = await host.http(url, {
        method: "GET",
        headers: headers || { "User-Agent": UA },
        timeout: 20000,
      });
      if (!r.ok) throw new Error("HTTP " + (r.status == null ? "?" : r.status) + ": " + url);
      return String(r.body || "");
    }

    async function fetchJson(url, headers) {
      var body = await fetchText(url, headers);
      try { return JSON.parse(body); } catch (e) { throw new Error("JSON 解析失败: " + (e.message || e) + " <- " + url); }
    }

    // ==================== web player JWT(运行时动态抓取,零硬编码) ====================
    // Apple web player 的 API token 是嵌在首页 JS 主包里的 JWT,约 2 个月轮换。
    // 流程:首页壳 HTML → 提取 /assets/index~<hash>.js 地址 → 主包内正则提取
    // 三段式 JWT → 解码 payload 校验 exp。401 时强制重抓一次自愈。
    var tokenCache = null; // { token, expMs }

    function b64urlDecode(s) {
      var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      var bits = 0, acc = 0, out = "";
      for (var i = 0; i < s.length; i++) {
        var idx = B64.indexOf(s.charAt(i));
        if (idx < 0) continue;
        acc = (acc << 6) | idx;
        bits += 6;
        if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 0xff); }
      }
      return out;
    }

    function jwtExpMs(t) {
      try {
        var parts = String(t).split(".");
        if (parts.length < 2) return 0;
        var payload = JSON.parse(b64urlDecode(parts[1]));
        return (parseInt(payload.exp, 10) || 0) * 1000;
      } catch (e) { return 0; }
    }

    async function getApiToken(force) {
      var now = Date.now();
      if (!force && tokenCache && tokenCache.expMs > now + 300000) return tokenCache.token;
      var shell = await fetchText(WEB_HOME);
      var m = shell.match(/\/assets\/index~[A-Za-z0-9]+\.js/);
      if (!m) throw new Error("Apple Music 首页未找到 JS 包地址(页面结构可能变化)");
      var bundle = await fetchText("https://music.apple.com" + m[0]);
      var jwts = bundle.match(/eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}/g) || [];
      for (var i = 0; i < jwts.length; i++) {
        var exp = jwtExpMs(jwts[i]);
        if (exp > now + 300000) {
          tokenCache = { token: jwts[i], expMs: exp };
          host.log("Apple Music API token 已更新,有效期至 " + new Date(exp).toISOString());
          return tokenCache.token;
        }
      }
      throw new Error("未能从 Apple Music JS 包提取有效 API token");
    }

    async function apiGet(path, params) {
      var q = [];
      var p = params || {};
      for (var k in p) {
        if (p[k] === undefined || p[k] === null) continue;
        q.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(p[k])));
      }
      var url = API_BASE + path + (q.length ? "?" + q.join("&") : "");
      var reqHeaders = function (token) {
        return { "User-Agent": UA, Origin: "https://music.apple.com", Authorization: "Bearer " + token };
      };
      var token = await getApiToken(false);
      var r = await host.http(url, { method: "GET", headers: reqHeaders(token), timeout: 15000 });
      if (r.status === 401) {
        // token 轮换/失效 → 强制重抓一次并重试
        token = await getApiToken(true);
        r = await host.http(url, { method: "GET", headers: reqHeaders(token), timeout: 15000 });
      }
      if (!r.ok) throw new Error("Apple Music API HTTP " + (r.status == null ? "?" : r.status) + ": " + path);
      try { return JSON.parse(r.body); } catch (e) { throw new Error("Apple Music API JSON 解析失败: " + (e.message || e)); }
    }

    // ==================== 数据映射 ====================
    /** MusicKit song 属性 → 统一歌曲结构(时长转秒,封面取 200x200) */
    function attrToSongItem(it) {
      var a = (it && it.attributes) || {};
      var cover = "";
      try { cover = String((a.artwork && a.artwork.url) || "").replace("{w}", "200").replace("{h}", "200"); } catch (e) { cover = ""; }
      return {
        songId: String((it && it.id) || "").trim(),
        title: String(a.name || "").trim(),
        artist: String(a.artistName || "").trim(),
        album: String(a.albumName || "").trim(),
        durationSec: a.durationInMillis > 0 ? Math.round(a.durationInMillis / 1000) : 0,
        cover: cover,
      };
    }

    /** 每日热门歌曲(charts API most-played songs,带完整专辑/时长) */
    async function fetchDailySongs() {
      var d = await apiGet("/charts", { types: "songs", limit: 100 });
      var bucket = ((d.results || {}).songs || [])[0];
      var data = (bucket && bucket.data) || [];
      var out = [];
      for (var i = 0; i < data.length; i++) {
        var it = attrToSongItem(data[i]);
        if (it.title) out.push(it);
      }
      if (!out.length) throw new Error("Apple Music 每日热门歌曲返回空榜单");
      return out;
    }

    /** 拉取一个官方歌单内的歌曲(分页,直到取完或达到 max) */
    async function fetchPlaylistSongsRaw(plId, max) {
      var songs = [];
      var PAGE = 100;
      var offset = 0;
      while (offset < max) {
        var d = await apiGet("/playlists/" + encodeURIComponent(plId) + "/tracks", { limit: PAGE, offset: offset });
        var data = d.data || [];
        for (var i = 0; i < data.length; i++) {
          var it = attrToSongItem(data[i]);
          if (it.title) songs.push(it);
        }
        if (data.length < PAGE) break;
        offset += PAGE;
      }
      return songs;
    }

    /** 热门歌单排行(官方 RSS,每日更新,无需鉴权):取前 n 个官方歌单 */
    async function fetchHotPlaylists(n) {
      var d = await fetchJson(RSS_BASE + "/30/playlists.json");
      var results = ((d.feed || {}).results) || [];
      var out = [];
      for (var i = 0; i < results.length && out.length < n; i++) {
        var r = results[i] || {};
        var id = String(r.id || "").trim();
        var name = String(r.name || "").trim();
        if (!id || !name) continue;
        out.push({ plId: id, name: name, rank: out.length + 1 });
      }
      if (!out.length) throw new Error("Apple Music 热门歌单排行 RSS 返回空");
      return out;
    }

    // ==================== 通用能力接入(SPEC §1.6.3) ====================
    // 导入命中门禁:透传专辑/时长(秒),宿主按「标题+歌手+专辑+时长」全维度核实。
    async function completeOnline(title, artist, album, durationSec) {
      try {
        var res = await host.sources.complete({
          artist: artist, title: title,
          album: album || "",
          duration: durationSec > 0 ? Math.round(durationSec) : 0,
        });
        return res && res.songId ? res.songId : null;
      } catch (e) { return null; }
    }

    // 旧宿主回退匹配(host.songs.match 不可用时;新宿主永远走上面批量通道)
    async function matchLocal(title, artist, album, durationMs, cache) {
      var key = String(title || "") + "|" + String(artist || "");
      if (cache.has(key)) return cache.get(key);
      var tNorm = norm(title);
      if (!tNorm) { cache.set(key, null); return null; }
      var aNorm = norm(artist);
      var hits = [];
      try { hits = (await host.songs.search([title, artist].filter(Boolean).join(" "), { limit: 50 })) || []; } catch (e) { hits = []; }
      if (!hits.length) { try { hits = (await host.songs.search(title, { limit: 200 })) || []; } catch (e) { hits = []; } }
      if (!hits.length) { cache.set(key, null); return null; }
      var best = null, bestScore = -1;
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i], hT = norm(h.title), hA = norm(h.artist), sc = 0;
        if (hT !== tNorm) continue;
        if (aNorm) {
          if (!(hA && (hA.indexOf(aNorm) >= 0 || aNorm.indexOf(hA) >= 0))) continue;
          sc = 140;
        } else {
          sc = 100;
        }
        if (durationMs > 0) {
          var rawDur = Number(h.duration) || 0;
          var hDurMs = rawDur > 0 && rawDur < 1000 ? rawDur * 1000 : rawDur;
          if (hDurMs > 0 && Math.abs(hDurMs - durationMs) <= 5000) sc += 10;
        }
        if (album && h.album && norm(album) === norm(h.album)) sc += 5;
        if (sc > bestScore) { bestScore = sc; best = h; }
      }
      var pass = best && ((aNorm && bestScore >= 140) || (!aNorm && bestScore >= 100));
      var id = pass ? best.id : null;
      cache.set(key, id);
      return id;
    }

    /** 榜单条目 → 歌单 entries:批量库内匹配(host.songs.match) → 在线补全 → 外部占位 */
    async function processItems(items, cache) {
      var hostIds = null;
      try {
        if (host.songs && typeof host.songs.match === "function") {
          var res = await host.songs.match(items.map(function (it) {
            return { title: it.title, artist: it.artist, album: it.album, duration: it.durationSec };
          }));
          if (Array.isArray(res) && res.length === items.length) hostIds = res;
        }
      } catch (e) { hostIds = null; }
      var entries = [], matched = 0, online = 0, external = 0;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var localId = hostIds ? (hostIds[i] || null) : null;
        if (!localId) {
          try { localId = await matchLocal(it.title, it.artist, it.album, it.durationSec * 1000, cache); } catch (e) { localId = null; }
        }
        if (localId) { entries.push({ songId: localId }); matched++; continue; }
        var completedId = null;
        try { completedId = await completeOnline(it.title, it.artist, it.album, it.durationSec); } catch (e) { completedId = null; }
        if (completedId) { entries.push({ songId: completedId }); online++; continue; }
        entries.push({ externalSongId: "apple:" + it.songId, externalTitle: it.title, externalArtist: it.artist, externalAlbum: it.album, externalDuration: it.durationSec * 1000 });
        external++;
      }
      return { entries: entries, matched: matched, online: online, external: external };
    }

    /** 解析 config 中 chartIds 配置 */
    function parseChartIds(config) {
      var raw = config && config.chartIds;
      var fallback = ["daily-songs"];
      if (!raw) return fallback;
      var ids = Array.isArray(raw) ? raw.map(String) : String(raw).split(",");
      ids = ids.map(function (s) { return s.trim(); }).filter(Boolean);
      return ids.length ? ids : fallback;
    }

    // ==================== 能力实现 ====================

    /** 搜索 Apple Music 歌曲(search/searchSongs 同源):search 供核心导入门禁
     *  crossVerifySongs 逐首交叉核实,songSearch 参与歌曲页「聚合」搜索。 */
    async function searchSongsImpl(config, params) {
      var query = String((params && params.query) || "").trim();
      if (!query) return { songs: [] };
      var limit = Math.min(Math.max(parseInt(params && params.limit, 10) || 20, 1), 50);
      var d = await apiGet("/search", { term: query, types: "songs", limit: limit });
      var data = (((d.results || {}).songs || {}).data) || [];
      var songs = [];
      for (var i = 0; i < data.length; i++) {
        var it = data[i] || {};
        var a = it.attributes || {};
        if (!String(a.name || "").trim()) continue;
        var cover = "";
        try { cover = String((a.artwork && a.artwork.url) || "").replace("{w}", "200").replace("{h}", "200"); } catch (e) { cover = ""; }
        songs.push({
          id: String(it.id || "").trim(),
          source: SOURCE,
          name: String(a.name || "").trim(),
          artist: String(a.artistName || "").trim(),
          album: String(a.albumName || "").trim(),
          duration: a.durationInMillis > 0 ? Math.round(a.durationInMillis / 1000) : 0,
          cover: cover,
        });
      }
      host.log("Apple Music 歌曲搜索「" + query + "」命中 " + songs.length + " 首");
      return { songs: songs };
    }

    /** 搜索 Apple Music 官方歌单(playlistSearch 能力,catalog 编辑歌单)。
     *  返回结构与 go-music-dl 一致:歌单页「聚合」模式与单插件模式共用。 */
    async function searchPlaylists(config, params) {
      var query = String((params && params.query) || "").trim();
      if (!query) return { playlists: [] };
      var limit = Math.min(Math.max(parseInt(params && params.limit, 10) || 30, 1), 50);
      var d = await apiGet("/search", { term: query, types: "playlists", limit: limit });
      var data = (((d.results || {}).playlists || {}).data) || [];
      var playlists = [];
      for (var i = 0; i < data.length; i++) {
        var it = data[i] || {};
        var a = it.attributes || {};
        var id = String(it.id || "").trim();
        var name = String(a.name || "").trim();
        if (!id || !name) continue;
        var cover = "";
        try { cover = String((a.artwork && a.artwork.url) || "").replace("{w}", "400").replace("{h}", "400"); } catch (e) { cover = ""; }
        playlists.push({
          id: id,
          source: SOURCE,
          name: name,
          creator: String(a.curatorName || "Apple Music").trim(),
          cover: cover,
          trackCount: parseInt(a.trackCount, 10) || 0,
          link: String(a.url || WEB_HOME),
        });
      }
      host.log("Apple Music 歌单搜索「" + query + "」命中 " + playlists.length + " 个歌单");
      return { playlists: playlists };
    }

    /** 拉取一个 Apple Music 歌单内的歌曲(playlistSongs 能力,供「加入库」导入)。
     *  导入侧由核心 crossVerifySongs 逐首门禁核实,此处只如实返回源数据。 */
    async function playlistSongs(config, source, id) {
      if (source !== SOURCE) return { songs: [] };
      var lid = String(id || "").trim();
      if (!lid) return { songs: [] };
      if (!/^pl\./.test(lid)) lid = "pl." + lid; // 容错:搜索结果之外的裸 catalog id
      var raw = await fetchPlaylistSongsRaw(lid, 500);
      var songs = [];
      for (var i = 0; i < raw.length; i++) {
        songs.push({
          id: raw[i].songId,
          source: SOURCE,
          name: raw[i].title,
          artist: raw[i].artist,
          album: raw[i].album,
          duration: raw[i].durationSec,
          cover: raw[i].cover,
        });
      }
      host.log("Apple Music 歌单 " + lid + " 拉取 " + songs.length + " 首");
      return { songs: songs };
    }

    /** 首页本地歌单分区(localPlatformRecommend)：直接读取本插件每日同步入库的榜单歌单。
     *  零网络、同步秒回；未同步入库的榜单不展示。 */
    async function recommendLocal(config) {
      var chartIds = parseChartIds(config);
      var homeCount = Number(config && config.homeCount) || 6;
      var sortOrder = Number(config && config.sortOrder) || 34;
      var playlists = [];
      for (var i = 0; i < chartIds.length && playlists.length < homeCount; i++) {
        var cid = chartIds[i];
        var meta = CHARTS[cid];
        if (!meta) continue;
        if (meta.kind === "hot") {
          // 动态热门歌单:排行位次 1..N 的歌单 id 固定,逐个读本地库
          var n = Math.min(Math.max(parseInt(config && config.hotPlaylistCount, 10) || 10, 1), 30);
          for (var r = 1; r <= n && playlists.length < homeCount; r++) {
            try {
              var hp = await host.playlists.get(HOT_PREFIX + r);
              if (hp) playlists.push({ id: hp.id, name: hp.name || ("Apple Music·热门#" + r), coverArt: hp.cover_art ? ("pl-" + hp.id) : "", songCount: hp.song_count || 0 });
            } catch (e) { /* 单个读取失败跳过 */ }
          }
          continue;
        }
        try {
          var p = await host.playlists.get(PLAYLIST_PREFIX + cid);
          if (!p) continue; // 未同步入库 → 不在本地分区展示
          playlists.push({
            id: p.id,
            name: p.name || ("Apple Music·" + meta.name),
            coverArt: p.cover_art ? ("pl-" + p.id) : "",
            songCount: p.song_count || 0,
          });
        } catch (e) {
          // 单榜读取失败跳过，不影响其它榜
        }
      }
      host.log("Apple Music 榜单本地分区展示: " + playlists.length + " 个已入库榜单");
      return { channels: [{ source: SOURCE, name: "Apple Music 榜单", count: playlists.length, sortOrder: sortOrder, subtag: "每日更新", playlists: playlists }] };
    }

    return {
      /** 歌曲搜索(search 能力):核心导入门禁 crossVerifySongs 用同平台曲库逐首核实。 */
      async search(config, params) { return searchSongsImpl(config, params); },

      /** 歌曲搜索(songSearch 能力):参与歌曲页「聚合」搜索,也可单独选择本插件搜索。 */
      searchSongs: searchSongsImpl,

      /** 歌单搜索(playlistSearch):参与歌单页「聚合」搜索,也可单独选择本插件搜索。 */
      searchPlaylists: searchPlaylists,

      /** 歌单内歌曲(playlistSongs):供歌单搜索「加入库」导入(核心经门禁交叉核实)。 */
      playlistSongs: playlistSongs,

      /** 首页本地歌单分区(localPlatformRecommend)。 */
      recommendLocal: recommendLocal,

      /** 每日定时任务：抓取所有所选榜单/歌单 → 写入独立歌单 */
      runDailyJob: async function () {
      var config = host.config || {};
      var chartIds = parseChartIds(config);
      var cache = new Map();
      var totalEntries = 0, totalMatched = 0, totalOnline = 0, totalExternal = 0;
      var successCount = 0, taskCount = 0;

      for (var i = 0; i < chartIds.length; i++) {
        var cid = chartIds[i];
        var meta = CHARTS[cid];
        if (!meta) { host.log("Apple Music 未知榜单 " + cid + ",跳过"); continue; }
        try {
          if (meta.kind === "hot") {
            // 动态热门歌单排行:RSS 取前 N 个官方歌单,逐一拉曲同步(排行位次=稳定歌单 id)
            var n = Math.min(Math.max(parseInt(config.hotPlaylistCount, 10) || 10, 1), 30);
            var hot = await fetchHotPlaylists(n);
            for (var h = 0; h < hot.length; h++) {
              var hp = hot[h];
              taskCount++;
              try {
                var raw = await fetchPlaylistSongsRaw(hp.plId, 100);
                var processed = await processItems(raw, cache);
                await host.playlists.upsert(HOT_PREFIX + hp.rank, {
                  name: "Apple Music·" + hp.name,
                  description: "Apple Music 热门歌单排行 #" + hp.rank + " - " + hp.name + "，每日自动同步",
                  entries: processed.entries,
                  sourcePlatform: SOURCE,
                  sourceUrl: "https://music.apple.com/cn/playlist/" + hp.plId,
                });
                totalEntries += processed.entries.length;
                totalMatched += processed.matched;
                totalOnline += processed.online;
                totalExternal += processed.external;
                successCount++;
                host.log("Apple Music 热门#" + hp.rank + "「" + hp.name + "」同步 " + processed.entries.length + " 首(本地匹配 " + processed.matched + ", 在线补全 " + processed.online + ", 待补全 " + processed.external + ")");
              } catch (e) {
                host.log("Apple Music 热门#" + hp.rank + "「" + hp.name + "」同步失败: " + (e.message || e));
              }
            }
            continue;
          }
          taskCount++;
          var items = meta.kind === "chart" ? await fetchDailySongs() : await fetchPlaylistSongsRaw(meta.plId, 200);
          var result = await processItems(items, cache);
          host.log("Apple Music " + meta.name + " 同步获取 " + result.entries.length + " 首(本地匹配 " + result.matched + " 首, 在线补全 " + result.online + " 首, 待补全 " + result.external + " 首)");
          await host.playlists.upsert(PLAYLIST_PREFIX + cid, {
            name: "Apple Music·" + meta.name,
            description: "Apple Music 官方榜单 - " + meta.name + "，每日自动同步",
            entries: result.entries,
            sourcePlatform: SOURCE,
            sourceUrl: meta.kind === "playlist" ? ("https://music.apple.com/cn/playlist/" + meta.plId) : "https://music.apple.com/cn/new/top-charts",
          });
          totalEntries += result.entries.length;
          totalMatched += result.matched;
          totalOnline += result.online;
          totalExternal += result.external;
          successCount++;
        } catch (e) {
          taskCount++;
          host.log("Apple Music " + (meta.name || cid) + " 同步失败: " + (e.message || e));
        }
      }
      var summary = "Apple Music 榜单同步完成: " + successCount + "/" + taskCount + " 个任务, 共 " + totalEntries + " 首, 本地匹配 " + totalMatched + " 首, 在线补全 " + totalOnline + " 首, 待补全 " + totalExternal + " 首";
      host.log(summary);
      return summary;
      },
    };
  },
};
