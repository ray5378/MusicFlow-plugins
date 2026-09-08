// ============================================================================
//  MusicFlow 外置插件：华为音乐榜单 (recommender)
// ----------------------------------------------------------------------------
//  自动抓取华为音乐官方榜单并同步到本地音乐库(已入库)。
//  首页展示走「本地歌单(localPlatformRecommend)」接口：直接读取本地库里的
//  榜单歌单(封面/数量来自 DB)，点击即本地播放，三端(Web/客户端/HA)统一走
//  本地库直连。
//
//  数据源：华为音乐 H5 运营服务(portal-drcn.music.dbankcloud.cn)公开接口，
//  无需鉴权，榜单歌曲自带标题/歌手/专辑/时长(秒)，门禁四维核实有料可核。
//
//  沙箱契约(QuickJS VM 内运行,拿不到 Node 能力):
//    - 纯 JS 脚本:globalThis.__mfPlugin = { manifest, create(host) };
//    - 网络走 host.http(url, { method, headers, timeout });
//    - host.config 每次调用前刷新为最新插件配置;
//    - 权限:manifest.permissions 声明的能力可用。
// ============================================================================

globalThis.__mfPlugin = {
  manifest: {
    id: "huawei-chart",
    name: "华为音乐榜单",
    version: "1.1.1",
    type: "recommender",
    schedules: true,
    description:
      "抓取华为音乐官方榜单（热歌榜、新歌榜、抖音热门榜、每日推荐、年代热歌榜、公告牌/UK/Melon等32个榜单）并同步到本地库。支持多选榜单，未匹配的歌曲通过在线源补全或外部占位由后端auto-match补全。首页以「本地歌单」分区直接展示已入库榜单，无需导入即可播放。同时支持搜索华为音乐官方歌单（榜单同款接口），可在歌单页与 go-music-dl 一样参与「聚合」搜索或单独搜索并导入，歌单页「筛选歌单」下拉含华为音乐平台。v1.1.1 起支持搜索华为音乐歌曲：既作为歌单导入门禁的同平台核实源（search），也参与歌曲页「聚合」搜索（songSearch）。",
    capabilities: ["localPlatformRecommend", "playlistSearch", "playlistSongs", "search", "songSearch"],
    platforms: ["huawei"],
    platformLabels: { huawei: "华为音乐" },
    defaultEnabled: true,
    minAppVersion: "1.7.39",
    longRunning: { runDailyJob: 120000, searchPlaylists: 20000, playlistSongs: 120000, search: 20000, searchSongs: 20000 },
    permissions: ["net", "storage", "songs:read", "songs:write", "playlists:write"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl:
      "https://github.com/ray5378/MusicFlow-plugins/releases/download/huawei-chart-v1.1.1/huawei-chart.tar.gz",
    configSchema: [
      {
        key: "chartIds",
        label: "选择榜单（可多选）",
        type: "multiselect",
        required: true,
        options: [
          { value: "24926", label: "热歌榜" },
          { value: "24931", label: "新歌榜" },
          { value: "146558", label: "每日推荐" },
          { value: "36102", label: "抖音热门榜" },
          { value: "8", label: "热歌人气榜" },
          { value: "10", label: "新歌抢鲜榜" },
          { value: "LWEPZdl0MoaSR1Czu", label: "人气飙升榜" },
          { value: "209", label: "粤语榜" },
          { value: "26677", label: "欧美榜" },
          { value: "27", label: "韩语大势榜" },
          { value: "26", label: "日语潮流榜" },
          { value: "29", label: "民谣歌曲榜" },
          { value: "31", label: "影视歌曲榜" },
          { value: "20127", label: "综艺风尚榜" },
          { value: "26039", label: "经典老歌榜" },
          { value: "26949", label: "网络歌曲榜" },
          { value: "74290", label: "国风潮音榜" },
          { value: "49078", label: "儿歌榜" },
          { value: "49080", label: "电音榜" },
          { value: "49081", label: "爵士榜" },
          { value: "49083", label: "嘻哈榜" },
          { value: "49084", label: "摇滚榜" },
          { value: "49085", label: "纯音榜" },
          { value: "49087", label: "古典榜" },
          { value: "MrVnaC4x17eHQmKKM", label: "00后热歌榜" },
          { value: "MrVnnwiCGa-kRUaRz", label: "90后热歌榜" },
          { value: "MrVo-uIRLraeHGgri", label: "80后热歌榜" },
          { value: "MrVoDILd4VOahRWul", label: "70后热歌榜" },
          { value: "OEqjHwrvOZgPR4PBK", label: "美国公告牌榜" },
          { value: "OEqjxdN6mzQX8YOwX", label: "英国UK榜" },
          { value: "OEqjl4jNbcCM-5qfj", label: "韩国Melon榜" },
          { value: "OEqjYDpvbiX--iDCs", label: "YouTube音乐排行榜" },
        ],
        default: ["24926"],
        help: "选择要同步的华为音乐官方榜单，可以多选",
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
        default: 33,
        help: "数值越小越靠前。QQ榜单(30)/酷狗榜单(31)/网易云榜单(32)/华为音乐榜单(33)按此值在首页「本地歌单」分区排列(1~100,默认 33)",
      },
      {
        key: "filterPlatforms",
        label: "歌单筛选平台",
        group: "frontend",
        type: "multiselect",
        options: [
          { value: "huawei", label: "华为音乐" },
        ],
        help: "选择在歌单页「筛选歌单」下拉中显示哪些平台,未选中的平台不会出现在筛选列表。默认全选。",
      },
    ],
    documentation:
      "### 功能介绍\n自动抓取华为音乐官方榜单并同步到本地音乐库，支持多选榜单，在首页「本地歌单」分区展示（直连本地库播放，无需导入）。\n\n### 配置说明\n- 选择要同步的榜单，可以多选；\n- 配置首页「本地歌单」展示的榜单数量；\n- 首页按所选榜单独立展示分区。",

    i18n: {
  "en": {
    "name": "Huawei Music Charts",
    "description": "Fetches Huawei Music official charts (Hot Songs, New Songs, Douyin Hits, Daily Picks, Decade Hot Charts, Billboard/UK/Melon, 32 charts in total) and syncs them into the local library. Multiple charts can be selected; unmatched songs are backfilled via online sources, external placeholders, or the backend auto-match. Charts are shown directly in the \"Local Playlists\" section on the home page, ready to play without import. Also searches Huawei Music official playlists and songs: joins the \"aggregate\" search modes or can be selected standalone, like go-music-dl; songs power the same-catalog import-gate verification (search) and the song page aggregate search (songSearch).",
    "groups": {
      "recommend": "Recommend",
      "schedule": "Scheduling"
    },
    "fields": {
      "chartIds": {
        "label": "Select charts (multi-select)",
        "help": "Select which Huawei Music official charts to sync (multi-select)",
        "options": {
          "24926": "Hot Songs Chart",
          "24931": "New Songs Chart",
          "146558": "Daily Picks",
          "36102": "Douyin Hits Chart",
          "8": "Hot Songs Popularity Chart",
          "10": "New Songs Preview Chart",
          "LWEPZdl0MoaSR1Czu": "Trending Chart",
          "209": "Cantonese Chart",
          "26677": "Western Chart",
          "27": "K-Pop Chart",
          "26": "J-Pop Chart",
          "29": "Folk Chart",
          "31": "TV/Movie Songs Chart",
          "20127": "Variety Show Chart",
          "26039": "Classic Oldies Chart",
          "26949": "Online Songs Chart",
          "74290": "Guofeng Chart",
          "49078": "Kids Chart",
          "49080": "Electronic Chart",
          "49081": "Jazz Chart",
          "49083": "Hip-Hop Chart",
          "49084": "Rock Chart",
          "49085": "Instrumental Chart",
          "49087": "Classical Chart",
          "MrVnaC4x17eHQmKKM": "Post-00s Hot Chart",
          "MrVnnwiCGa-kRUaRz": "Post-90s Hot Chart",
          "MrVo-uIRLraeHGgri": "Post-80s Hot Chart",
          "MrVoDILd4VOahRWul": "Post-70s Hot Chart",
          "OEqjHwrvOZgPR4PBK": "Billboard (US)",
          "OEqjxdN6mzQX8YOwX": "UK Chart",
          "OEqjl4jNbcCM-5qfj": "Melon Chart (KR)",
          "OEqjYDpvbiX--iDCs": "YouTube Music Chart"
        }
      },
      "homeCount": {
        "label": "Home playlists shown",
        "help": "How many imported charts to show in the \"Local Playlists\" section on the home page (1~50, default 6)"
      },
      "sortOrder": {
        "label": "Home display order",
        "help": "Lower value sorts first. QQ (30) / Kugou (31) / Netease (32) / Huawei Music (33) charts are arranged by this value in the \"Local Playlists\" section on the home page (1~100, default 33)"
      },
      "filterPlatforms": {
        "label": "Playlist filter platforms",
        "help": "Choose which platforms appear in the \"Filter playlists\" dropdown on the playlist page; unselected platforms do not appear in the filter list. All selected by default.",
        "options": {
          "huawei": "Huawei Music"
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
        "documentation": "### Features\nAutomatically fetches Huawei Music official charts and syncs them into the local music library. Supports multi-selecting charts; charts are shown in the \"Local Playlists\" section on the home page (played straight from the local library, no import needed).\n\n### Playlist & song search (new in v1.1.0 / v1.1.1)\nLike go-music-dl: joins the \"aggregate\" search modes and can be selected standalone — playlists on the playlist page (v1.1.0), songs on the music page (v1.1.1). Open a playlist to preview/play directly or import it into the library; imported songs are cross-verified against Huawei's own catalog via the import gate (search capability).\n\n### Configuration\n- Select the charts to sync (multi-select);\n- Configure how many charts the \"Local Playlists\" section shows on the home page;\n- The home page shows a separate section per selected chart;\n- \"Playlist filter platforms\" controls whether Huawei Music appears in the playlist page filter dropdown."
  }
},
  },

  create(host) {
    var CHART_NAME = {
      "24926": "热歌榜",
      "24931": "新歌榜",
      "146558": "每日推荐",
      "36102": "抖音热门榜",
      "8": "热歌人气榜",
      "10": "新歌抢鲜榜",
      "LWEPZdl0MoaSR1Czu": "人气飙升榜",
      "209": "粤语榜",
      "26677": "欧美榜",
      "27": "韩语大势榜",
      "26": "日语潮流榜",
      "29": "民谣歌曲榜",
      "31": "影视歌曲榜",
      "20127": "综艺风尚榜",
      "26039": "经典老歌榜",
      "26949": "网络歌曲榜",
      "74290": "国风潮音榜",
      "49078": "儿歌榜",
      "49080": "电音榜",
      "49081": "爵士榜",
      "49083": "嘻哈榜",
      "49084": "摇滚榜",
      "49085": "纯音榜",
      "49087": "古典榜",
      "MrVnaC4x17eHQmKKM": "00后热歌榜",
      "MrVnnwiCGa-kRUaRz": "90后热歌榜",
      "MrVo-uIRLraeHGgri": "80后热歌榜",
      "MrVoDILd4VOahRWul": "70后热歌榜",
      "OEqjHwrvOZgPR4PBK": "美国公告牌榜",
      "OEqjxdN6mzQX8YOwX": "英国UK榜",
      "OEqjl4jNbcCM-5qfj": "韩国Melon榜",
      "OEqjYDpvbiX--iDCs": "YouTube音乐排行榜",
    };
    var CHART_API =
      "https://portal-drcn.music.dbankcloud.cn/music-operation-service/v1/service/chart/detail/bychartid";
    var SEARCH_API =
      "https://portal-drcn.music.dbankcloud.cn/music-search-service/v9/service/fuzzysearch";
    var MUSICLIST_API =
      "https://portal-drcn.music.dbankcloud.cn/music-operation-service/v1/service/musiclist/detail/bymusiclistid";
    var H5_HOME = "https://portal-drcn.music.dbankcloud.cn/music-apph5-service/h5/index.html";
    var PLAYLIST_PREFIX = "pl-huawei-chart-";

    function norm(s) {
      return String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, "");
    }

    async function fetchJson(url) {
      var r = await host.http(url, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MusicFlow/1.0)", Referer: H5_HOME },
        timeout: 15000,
      });
      if (!r.ok) throw new Error("HTTP " + (r.status == null ? "?" : r.status) + ": " + url);
      try { return JSON.parse(r.body); } catch (e) { throw new Error("JSON 解析失败: " + (e.message || e)); }
    }

    async function postJson(url, payload) {
      var r = await host.http(url, {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MusicFlow/1.0)",
          Referer: H5_HOME,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        timeout: 15000,
      });
      if (!r.ok) throw new Error("HTTP " + (r.status == null ? "?" : r.status) + ": " + url);
      try { return JSON.parse(r.body); } catch (e) { throw new Error("JSON 解析失败: " + (e.message || e)); }
    }

    async function matchLocal(title, artist, album, durationMs, cache) {
      var key = String(title || "") + "|" + String(artist || "");
      if (cache.has(key)) return cache.get(key);
      var tNorm = norm(title);
      if (!tNorm) { cache.set(key, null); return null; }
      var aNorm = norm(artist);
      var hits = [];
      // 首轮带歌手搜(宿主已支持分词 AND,能命中 title/artist 都含词的候选);
      // 0 条才回退裸歌名,回退时拉大候选量避免同名多版本被截断漏掉正确歌手。
      try { hits = (await host.songs.search([title, artist].filter(Boolean).join(" "), { limit: 50 })) || []; } catch (e) { hits = []; }
      if (!hits.length) { try { hits = (await host.songs.search(title, { limit: 200 })) || []; } catch (e) { hits = []; } }
      if (!hits.length) { cache.set(key, null); return null; }
      var best = null, bestScore = -1;
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i], hT = norm(h.title), hA = norm(h.artist), sc = 0;
        // 歌名硬:必须精确相等。
        if (hT !== tNorm) continue;
        // 歌手硬:期望歌手非空时必须互相包含(处理 "G.E.M.邓紫棋" vs "邓紫棋");
        // 歌手不符 = 同名异曲,直接排除,绝不退而求其次绑同名歌。
        if (aNorm) {
          if (!(hA && (hA.indexOf(aNorm) >= 0 || aNorm.indexOf(hA) >= 0))) continue;
          sc = 140;
        } else {
          sc = 100;
        }
        // 时长软:双方均可比且差 ≤5s 加分(多版本择优,不否决)。
        // 本地库 duration 存秒(songs.duration 由 scanner 写入,music-metadata 单位秒),
        // 榜单侧传毫秒 → 本地值 <1000 视为秒先转毫秒再比较。
        if (durationMs > 0) {
          var rawDur = Number(h.duration) || 0;
          var hDurMs = rawDur > 0 && rawDur < 1000 ? rawDur * 1000 : rawDur;
          if (hDurMs > 0 && Math.abs(hDurMs - durationMs) <= 5000) sc += 10;
        }
        // 专辑软:归一后一致加分(同上,仅用于同歌名同歌手多版本择优)。
        if (album && h.album && norm(album) === norm(h.album)) sc += 5;
        if (sc > bestScore) { bestScore = sc; best = h; }
      }
      // 过线:期望歌手时须 140(歌名100+歌手40),无歌手信息时歌名精确即可。
      var pass = best && ((aNorm && bestScore >= 140) || (!aNorm && bestScore >= 100));
      var id = pass ? best.id : null;
      cache.set(key, id);
      return id;
    }

    // 导入命中门禁:透传专辑/时长(秒),宿主按「标题+歌手+专辑+时长」全维度核实。
    async function completeOnline(title, artist, album, durationMs) {
      try {
        var res = await host.sources.complete({
          artist: artist, title: title,
          album: album || "",
          duration: durationMs > 0 ? Math.round(durationMs / 1000) : 0,
        });
        return res && res.songId ? res.songId : null;
      } catch (e) { return null; }
    }

    /** 从 contentExInfo 提取时长(秒):completeFileInfos 各音质档都带同一 duration。 */
    function extractDurationSec(item) {
      try {
        var ex = JSON.parse(item.contentExInfo || "{}");
        var files = ex.completeFileInfos || {};
        for (var k in files) {
          var d = parseInt(files[k] && files[k].duration, 10);
          if (d > 0) return d;
        }
      } catch (e) { /* 无 exInfo 视为无时长 */ }
      return 0;
    }

    /** 歌单搜索结果里创建者昵称:contentExInfo.nickName 优先,退回 cpID。 */
    function playlistCreator(item) {
      try {
        var ex = JSON.parse(item.contentExInfo || "{}");
        if (ex.nickName) return ex.nickName;
      } catch (e) { /* 忽略 */ }
      return String(item.cpID || "华为音乐");
    }

    /** 搜索华为音乐官方歌单(playlistSearch 能力,fuzzysearch contentType=4)。
     *  返回结构与 go-music-dl 一致:歌单页「聚合」模式与单插件模式共用。 */
    async function searchPlaylists(config, params) {
      var query = String((params && params.query) || "").trim();
      if (!query) return { playlists: [] };
      var limit = Math.min(Math.max(parseInt(params && params.limit, 10) || 30, 1), 50);
      var data = await postJson(SEARCH_API, { queryWord: query, contentType: "4", start: 0, limit: limit });
      var lists = (data && data.musicListSimpleInfos) || [];
      var playlists = [];
      for (var i = 0; i < lists.length; i++) {
        var it = lists[i] || {};
        var id = String(it.contentID || "").trim();
        var name = String(it.contentName || it.keyName || "").trim();
        if (!id || !name) continue;
        var cover = "";
        try { cover = String((it.picture && (it.picture.bigImgURL || it.picture.middleImgURL || it.picture.smallImgURL)) || ""); } catch (e) { cover = ""; }
        playlists.push({
          id: id,
          source: "huawei",
          name: name,
          creator: playlistCreator(it),
          cover: cover,
          trackCount: parseInt(it.totalCount, 10) || 0,
          link: H5_HOME,
        });
      }
      host.log("华为音乐歌单搜索「" + query + "」命中 " + playlists.length + " 个歌单");
      return { playlists: playlists };
    }

    /** 搜索华为音乐歌曲(fuzzysearch contentType=1)。
     *  search 与 searchSongs 同源:search 暴露给核心导入门禁(crossVerifySongs 逐首
     *  交叉核实必须搜得到同平台候选,否则歌单搜索「加入库」会整单拒导——v1.1.0 缺
     *  这条道,346 首全部「provider 不支持搜索」拒导即此因),searchSongs 按能力
     *  契约暴露给歌曲页「聚合」搜索(songSearch 能力)。 */
    async function searchSongsImpl(config, params) {
      var query = String((params && params.query) || "").trim();
      if (!query) return { songs: [] };
      var limit = Math.min(Math.max(parseInt(params && params.limit, 10) || 20, 1), 50);
      var data = await postJson(SEARCH_API, { queryWord: query, contentType: 1, start: 0, limit: limit });
      var lists = (data && data.songSimpleInfos) || [];
      var songs = [];
      for (var i = 0; i < lists.length; i++) {
        var it = lists[i] || {};
        if (it.contentType && String(it.contentType) !== "1") continue; // 只收歌曲
        var name = String(it.contentName || "").trim();
        if (!name) continue;
        var cover = "";
        try { cover = String((it.picture && (it.picture.middleImgURL || it.picture.smallImgURL || it.picture.bigImgURL)) || ""); } catch (e) { cover = ""; }
        songs.push({
          id: String(it.contentID || "").trim(),
          source: "huawei",
          name: name,
          artist: String(it.artistName || "").trim(),
          album: String(it.albumName || "").trim(),
          duration: extractDurationSec(it),
          cover: cover,
        });
      }
      host.log("华为音乐歌曲搜索「" + query + "」命中 " + songs.length + " 首");
      return { songs: songs };
    }

    /** 拉取一个华为歌单内的歌曲(playlistSongs 能力,供「加入库」导入)。
     *  导入侧由核心 crossVerifySongs 逐首门禁核实,此处只如实返回源数据。 */
    async function playlistSongs(config, source, id) {
      // 非 huawei 来源(含冒烟调用的对象形态参数)安全返回空,不抛错。
      if (source !== "huawei") return { songs: [] };
      var lid = String(id || "").trim();
      if (!lid) return { songs: [] };
      var songs = [];
      var PAGE = 100, MAX = 500;
      for (var start = 0; start < MAX; start += PAGE) {
        var data = await fetchJson(MUSICLIST_API + "?musicListID=" + encodeURIComponent(lid) + "&start=" + start + "&limit=" + PAGE);
        var ex = (data && data.musicListInfoEx) || {};
        var batch = ex.songSimpleInfos || [];
        for (var i = 0; i < batch.length; i++) {
          var it = batch[i] || {};
          if (it.contentType && String(it.contentType) !== "1") continue; // 只收歌曲
          var name = String(it.contentName || "").trim();
          if (!name) continue;
          songs.push({
            id: String(it.contentID || "").trim(),
            source: "huawei",
            name: name,
            artist: String(it.artistName || "").trim(),
            album: String(it.albumName || "").trim(),
            duration: extractDurationSec(it),
            cover: "",
          });
        }
        if (batch.length < PAGE) break;
      }
      host.log("华为音乐歌单 " + lid + " 拉取 " + songs.length + " 首");
      return { songs: songs };
    }

    /** 抓取单个榜单并处理成 entries */
    async function fetchAndProcess(chartId, cache) {
      var chartName = CHART_NAME[chartId] || ("榜单 " + chartId);
      var data = await fetchJson(CHART_API + "?chartid=" + encodeURIComponent(chartId) + "&start=0&limit=100");
      var ex = (data && data.chartInfoEx) || {};
      var chartInfo = ex.chartInfo || {};
      var songs = ex.songSimpleInfos || [];
      if (!songs.length) {
        throw new Error("华为音乐" + chartName + "返回空榜单 (chart=" + (chartInfo.contentName || chartId) + ")");
      }
      var entries = [], matched = 0, online = 0, external = 0;
      for (var i = 0; i < songs.length; i++) {
        var item = songs[i] || {};
        var title = String(item.contentName || "").trim();
        if (!title) continue;
        var artist = String(item.artistName || "").trim();
        var album = String(item.albumName || "").trim();
        var duration = extractDurationSec(item) * 1000;
        var songId = String(item.contentID || "").trim();
        var localId = null;
        try { localId = await matchLocal(title, artist, album, duration, cache); } catch (e) { localId = null; }
        if (localId) { entries.push({ songId: localId }); matched++; continue; }
        var completedId = null;
        try { completedId = await completeOnline(title, artist, album, duration); } catch (e) { completedId = null; }
        if (completedId) { entries.push({ songId: completedId }); online++; continue; }
        entries.push({ externalSongId: "huawei:" + songId, externalTitle: title, externalArtist: artist, externalAlbum: album, externalDuration: duration });
        external++;
      }
      return { chartName: chartName, entries: entries, matched: matched, online: online, external: external };
    }

    /** 解析 config 中 chartIds 配置 */
    function parseChartIds(config) {
      var raw = config && config.chartIds;
      if (!raw) return ["24926"];
      if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
      if (typeof raw === "string") return raw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      return ["24926"];
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

      /** 首页本地歌单分区(localPlatformRecommend)：直接读取本插件每日同步入库的榜单歌单。
       *  封面/数量均取自本地库(DB)字段，真实且无网络依赖；点击即本地播放，三端统一走
       *  本地库直连。未同步入库的榜单不展示。 */
      async recommendLocal(config) {
        var chartIds = parseChartIds(config);
        var homeCount = Number(config && config.homeCount) || 6;
        var sortOrder = Number(config && config.sortOrder) || 33;
        var playlists = [];
        for (var i = 0; i < chartIds.length && playlists.length < homeCount; i++) {
          var cid = chartIds[i];
          try {
            var p = await host.playlists.get(PLAYLIST_PREFIX + cid);
            if (!p) continue; // 未同步入库 → 不在本地分区展示
            playlists.push({
              id: p.id,
              name: p.name || ("华为音乐·" + (CHART_NAME[cid] || cid)),
              coverArt: p.cover_art ? ("pl-" + p.id) : "",
              songCount: p.song_count || 0,
            });
          } catch (e) {
            // 单榜读取失败跳过，不影响其它榜
          }
        }
        host.log("华为音乐榜单本地分区展示: " + playlists.length + " 个已入库榜单");
        return { channels: [{ source: "huawei", name: "华为音乐榜单", count: playlists.length, sortOrder: sortOrder, subtag: "每日更新", playlists: playlists }] };
      },

      /** 每日定时任务：抓取所有所选榜单 → 写入独立歌单 */
      runDailyJob: async function () {
        var config = host.config || {};
        var chartIds = parseChartIds(config);
        var cache = new Map();
        var totalEntries = 0, totalMatched = 0, totalOnline = 0, totalExternal = 0;
        var successCount = 0;

        for (var i = 0; i < chartIds.length; i++) {
          var cid = chartIds[i];
          var cname = CHART_NAME[cid] || ("榜单 " + cid);
          try {
            var result = await fetchAndProcess(cid, cache);
            host.log("华为音乐 " + result.chartName + " 同步获取 " + result.entries.length + " 首(本地匹配 " + result.matched + " 首, 在线补全 " + result.online + " 首, 待补全 " + result.external + " 首)");
            await host.playlists.upsert(PLAYLIST_PREFIX + cid, {
              name: "华为音乐·" + result.chartName,
              description: "华为音乐官方榜单 - " + result.chartName + "，每日自动同步",
              entries: result.entries,
              sourcePlatform: "huawei",
              sourceUrl: H5_HOME,
            });
            totalEntries += result.entries.length;
            totalMatched += result.matched;
            totalOnline += result.online;
            totalExternal += result.external;
            successCount++;
          } catch (e) {
            host.log("华为音乐" + (CHART_NAME[cid] || cid) + "同步失败: " + (e.message || e));
          }
        }
        var summary = "华为音乐榜单同步完成: " + successCount + "/" + chartIds.length + " 个榜单, 共 " + totalEntries + " 首, 本地匹配 " + totalMatched + " 首, 在线补全 " + totalOnline + " 首, 待补全 " + totalExternal + " 首";
        host.log(summary);
        return summary;
      },
    };
  },
};