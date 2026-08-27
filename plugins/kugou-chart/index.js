// ============================================================================
//  MusicFlow 外置插件：酷狗榜单 (recommender)
// ----------------------------------------------------------------------------
//  自动抓取酷狗排行榜并同步到本地音乐库，在首页推荐分区展示。
//
//  沙箱契约(QuickJS VM 内运行,拿不到 Node 能力):
//    - 纯 JS 脚本:globalThis.__mfPlugin = { manifest, create(host) };
//    - 网络走 host.http(url, { method, headers, timeout });
//    - host.config 每次调用前刷新为最新插件配置;
//    - 权限:manifest.permissions 声明的能力可用。
// ============================================================================

globalThis.__mfPlugin = {
  manifest: {
    id: "kugou-chart",
    name: "酷狗榜单",
    version: "1.1.0",
    type: "recommender",
    description:
      "抓取酷狗排行榜（TOP500、飙升榜、网络红歌榜、DJ热歌榜）并同步到本地。支持多选榜单，未匹配的歌曲通过在线源补全或外部占位由后端auto-match补全。在首页以独立推荐分区展示。",
    capabilities: ["recommend", "recommendPlaylist"],
    defaultEnabled: false,
    minAppVersion: "1.7.39",
    longRunning: { runDailyJob: 300000, recommend: 120000 },
    permissions: ["net", "storage", "songs:read", "songs:write", "playlists:write"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl:
      "https://github.com/ray5378/MusicFlow-plugins/releases/download/kugou-chart-v1.1.0/kugou-chart.tar.gz",
    configSchema: [
      {
        key: "rankIds",
        label: "选择榜单（可多选）",
        type: "tag-input",
        required: true,
        default: "8888",
        help: "输入榜单ID后按回车添加。可选ID: 8888=TOP500, 6666=飙升榜, 23784=网络红歌榜, 24971=DJ热歌榜。TOP500共500首，自动分5页拉取。",
      },
      {
        key: "pageSize",
        label: "每页数量",
        type: "number",
        default: 100,
        help: "每页获取多少首歌曲，TOP500需要分5×100=500首。",
      },
      {
        key: "maxPages",
        label: "最多拉页数",
        type: "number",
        default: 5,
        help: "最多获取多少页，TOP500设置5页就能拉完整500首。",
      },
    ],
    documentation:
      "### 功能介绍\n自动抓取酷狗排行榜并同步到本地音乐库，支持多选榜单，在首页推荐分区展示。\n\n### 配置说明\n- 「选择榜单」输入榜单ID后按回车添加，可添加多个；\n- TOP500需要设置`maxPages=5`才能拉满500首；\n- 首页按所选榜单独立展示推荐分区。",
  },

  create(host) {
    var CHART_NAME = {
      "8888": "TOP500",
      "6666": "飙升榜",
      "23784": "网络红歌榜",
      "24971": "DJ热歌榜",
    };
    var KUGOU_API_BASE = "http://m.kugou.com";
    var PLAYLIST_PREFIX = "pl-kugou-chart-";

    function norm(s) {
      return String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, "");
    }

    async function fetchJson(url) {
      var r = await host.http(url, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MusicFlow/1.0)" },
        timeout: 15000,
      });
      if (!r.ok) throw new Error("HTTP " + (r.status == null ? "?" : r.status) + ": " + url);
      try { return JSON.parse(r.body); } catch (e) { throw new Error("JSON 解析失败: " + (e.message || e)); }
    }

    function parseArtist(authors) {
      if (!authors || !Array.isArray(authors)) return "";
      var names = authors.map(function (a) { return String(a.author_name || "").trim(); }).filter(Boolean);
      return names.join(", ");
    }

    async function matchLocal(title, artist, cache) {
      var key = String(title || "") + "|" + String(artist || "");
      if (cache.has(key)) return cache.get(key);
      var tNorm = norm(title);
      if (!tNorm) { cache.set(key, null); return null; }
      var aNorm = norm(artist);
      var hits = [];
      try { hits = (await host.songs.search([title, artist].filter(Boolean).join(" "), { limit: 10 })) || []; } catch (e) { hits = []; }
      if (!hits.length) { try { hits = (await host.songs.search(title, { limit: 10 })) || []; } catch (e) { hits = []; } }
      if (!hits.length) { cache.set(key, null); return null; }
      var best = null, bestScore = -1;
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i], hT = norm(h.title), hA = norm(h.artist), sc = 0;
        if (hT === tNorm) sc += 100; else if (hT.indexOf(tNorm) >= 0 || tNorm.indexOf(hT) >= 0) sc += 60;
        if (aNorm && hA && (hA.indexOf(aNorm) >= 0 || aNorm.indexOf(hA) >= 0)) sc += 40;
        if (sc > bestScore) { bestScore = sc; best = h; }
      }
      var id = best && bestScore >= 60 ? best.id : null;
      cache.set(key, id);
      return id;
    }

    async function completeOnline(title, artist) {
      try { var res = await host.sources.complete({ artist: artist, title: title }); return res && res.songId ? res.songId : null; } catch (e) { return null; }
    }

    /** 抓取单个榜单所有页 */
    async function fetchAllPages(rankid, pageSize, maxPages) {
      var allSongs = [];
      for (var page = 1; page <= maxPages; page++) {
        var url = KUGOU_API_BASE + "/rank/info/?rankid=" + rankid + "&page=" + page + "&json=true";
        var data = await fetchJson(url);
        if (!data || !data.songs || !Array.isArray(data.songs.list)) break;
        var pageSongs = data.songs.list;
        allSongs = allSongs.concat(pageSongs);
        host.log("酷狗" + (CHART_NAME[rankid] || rankid) + " 第" + page + "页获取 " + pageSongs.length + " 首, 累计 " + allSongs.length + " 首");
        // 如果本页小于请求的 pageSize，说明是最后一页，停止
        if (pageSongs.length < pageSize) break;
      }
      return allSongs;
    }

    /** 处理单首歌曲生成 entry，返回 { entry, type } */
    async function processItem(item, cache) {
      var title = String(item.songname || "").trim();
      if (!title) return null;
      var artist = parseArtist(item.authors);
      var album = String(item.album_name || "").trim();
      var duration = Number(item.duration || 0) * 1000;
      var hash = String(item.hash || item.filehash || "").trim();
      var localId = null;
      try { localId = await matchLocal(title, artist, cache); } catch (e) { localId = null; }
      if (localId) return { entry: { songId: localId }, type: "local" };
      var completedId = null;
      try { completedId = await completeOnline(title, artist); } catch (e) { completedId = null; }
      if (completedId) return { entry: { songId: completedId }, type: "online" };
      return { entry: { externalSongId: "kugou:" + hash, externalTitle: title, externalArtist: artist, externalAlbum: album, externalDuration: duration > 0 ? duration : null }, type: "external" };
    }

    /** 解析 config 中 rankIds 配置 */
    function parseRankIds(config) {
      var raw = config && config.rankIds;
      if (!raw) return ["8888"];
      if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
      if (typeof raw === "string") return raw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      return ["8888"];
    }

    function getPageSize(config) {
      var v = Number(config && config.pageSize);
      return Number.isFinite(v) && v > 0 ? v : 100;
    }

    function getMaxPages(config) {
      var v = Number(config && config.maxPages);
      return Number.isFinite(v) && v > 0 ? v : 5;
    }

    return {
      /** 首页推荐：按所选榜单独立展示 */
      async recommend(config) {
        var rankIds = parseRankIds(config);
        var pageSize = getPageSize(config);
        var maxPages = getMaxPages(config);
        var cache = new Map();
        var playlists = [];
        for (var i = 0; i < rankIds.length; i++) {
          var rid = rankIds[i];
          var rname = CHART_NAME[rid] || ("榜单 " + rid);
          try {
            var allSongs = await fetchAllPages(rid, pageSize, maxPages);
            var entries = [];
            for (var j = 0; j < allSongs.length; j++) {
              var result = await processItem(allSongs[j], cache);
              if (result) entries.push(result.entry);
            }
            playlists.push({
              id: PLAYLIST_PREFIX + rid,
              name: "酷狗·" + rname,
              cover: "",
              songs: entries,
            });
          } catch (e) {
            host.log("酷狗" + rname + "推荐获取失败: " + (e.message || e));
          }
        }
        return { channels: [{ source: "kugou", name: "酷狗榜单", count: playlists.length, playlists: playlists }] };
      },

      /** 每日定时任务：抓取所有所选榜单 → 写入独立歌单 */
      runDailyJob: async function () {
        var config = host.config || {};
        var rankIds = parseRankIds(config);
        var pageSize = getPageSize(config);
        var maxPages = getMaxPages(config);
        var cache = new Map();
        var totalEntries = 0, totalMatched = 0, totalOnline = 0, totalExternal = 0;
        var successCount = 0;
        for (var i = 0; i < rankIds.length; i++) {
          var rid = rankIds[i];
          var rname = CHART_NAME[rid] || ("榜单 " + rid);
          try {
            var allSongs = await fetchAllPages(rid, pageSize, maxPages);
            var entries = [];
            var matched = 0, online = 0, external = 0;
            for (var j = 0; j < allSongs.length; j++) {
              var result = await processItem(allSongs[j], cache);
              if (result) {
                entries.push(result.entry);
                if (result.type === "local") matched++;
                else if (result.type === "online") online++;
                else external++;
              }
            }
            await host.playlists.upsert(PLAYLIST_PREFIX + rid, {
              name: "酷狗·" + rname,
              description: "酷狗排行榜 - " + rname + "，每日自动同步，共 " + entries.length + " 首",
              entries: entries,
              sourcePlatform: "kugou",
              sourceUrl: "https://www.kugou.com/web/rank/",
            });
            totalEntries += entries.length;
            totalMatched += matched;
            totalOnline += online;
            totalExternal += external;
            successCount++;
          } catch (e) {
            host.log("酷狗" + rname + "同步失败: " + (e.message || e));
          }
        }
        var summary = "酷狗榜单同步完成: " + successCount + "/" + rankIds.length + " 个榜单, 共 " + totalEntries + " 首, 本地匹配 " + totalMatched + " 首, 在线补全 " + totalOnline + " 首, 待补全 " + totalExternal + " 首";
        host.log(summary);
        return summary;
      },
    };
  },
};