// ============================================================================
//  MusicFlow 外置插件：网易云榜单 (recommender)
// ----------------------------------------------------------------------------
//  自动抓取网易云音乐排行榜并同步到本地音乐库，在首页推荐分区展示。
//
//  沙箱契约(QuickJS VM 内运行,拿不到 Node 能力):
//    - 纯 JS 脚本:globalThis.__mfPlugin = { manifest, create(host) };
//    - 网络走 host.http(url, { method, headers, timeout });
//    - host.config 每次调用前刷新为最新插件配置;
//    - 权限:manifest.permissions 声明的能力可用。
// ============================================================================

globalThis.__mfPlugin = {
  manifest: {
    id: "netease-chart",
    name: "网易云榜单",
    version: "1.6.4",
    type: "recommender",
    description:
      "抓取网易云音乐排行榜（热歌榜、飙升榜、新歌榜、原创榜）并同步到本地库。支持多选榜单，未匹配的歌曲通过在线源补全或外部占位由后端auto-match补全。首页以「本地歌单」分区直接展示已入库榜单，无需导入即可播放。",
    capabilities: ["localPlatformRecommend"],
    defaultEnabled: true,
    minAppVersion: "1.7.39",
    longRunning: { runDailyJob: 120000 },
    permissions: ["net", "storage", "songs:read", "songs:write", "playlists:write"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl:
      "https://github.com/ray5378/MusicFlow-plugins/releases/download/netease-chart-v1.6.2/netease-chart.tar.gz",
    configSchema: [
      {
        key: "chartIds",
        label: "选择榜单（可多选）",
        type: "multiselect",
        required: true,
        options: [
          { "value": "3778678", "label": "热歌榜" },
          { "value": "19723756", "label": "飙升榜" },
          { "value": "3779629", "label": "新歌榜" },
          { "value": "2884035", "label": "原创榜" }
        ],
        default: ["3778678"],
        help: "选择要同步的网易云音乐榜单，可以多选",
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
        default: 32,
        help: "数值越小越靠前。QQ音乐榜单/酷狗榜单/网易云榜单按此值在首页「本地歌单」分区排列(1~100,默认 32)",
      },
    ],
    documentation:
      "### 功能介绍\n自动抓取网易云音乐排行榜并同步到本地音乐库，支持多选榜单，在首页「本地歌单」分区展示（直连本地库播放，无需导入）。\n\n### 配置说明\n- 选择要同步的榜单，可以多选；\n- 配置首页「本地歌单」展示的榜单数量；\n- 首页按所选榜单独立展示分区。",
  },

  create(host) {
    var CHART_NAME = {
      "3778678": "热歌榜",
      "19723756": "飙升榜",
      "3779629": "新歌榜",
      "2884035": "原创榜",
    };
    var NETEASE_API = "https://music.163.com/api/playlist/detail";
    var PLAYLIST_PREFIX = "pl-netease-chart-";

    function norm(s) {
      return String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, "");
    }

    async function fetchJson(url) {
      var r = await host.http(url, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MusicFlow/1.0)", Referer: "https://music.163.com/" },
        timeout: 15000,
      });
      if (!r.ok) throw new Error("HTTP " + (r.status == null ? "?" : r.status) + ": " + url);
      try { return JSON.parse(r.body); } catch (e) { throw new Error("JSON 解析失败: " + (e.message || e)); }
    }

    function parseArtists(artists) {
      if (!Array.isArray(artists) || !artists.length) return "";
      return artists.map(function (a) { return String(a.name || "").trim(); }).filter(Boolean).join(", ");
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
        // 歌名硬:必须精确相等(不再收 60 包含分——同名单曲不得绑到 Live/Remix 等变体)。
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

    async function completeOnline(title, artist) {
      try { var res = await host.sources.complete({ artist: artist, title: title }); return res && res.songId ? res.songId : null; } catch (e) { return null; }
    }

    /** 抓取单个榜单并处理成 entries */
    async function fetchAndProcess(chartId, cache) {
      var chartName = CHART_NAME[chartId] || ("榜单 " + chartId);
      var data = await fetchJson(NETEASE_API + "?id=" + chartId + "&t=" + Date.now());
      if (!data || !data.result || !data.result.tracks) {
        throw new Error("网易云" + chartName + "API返回格式异常");
      }
      var tracks = data.result.tracks;
      var entries = [], matched = 0, online = 0, external = 0;
      for (var i = 0; i < tracks.length; i++) {
        var track = tracks[i];
        var title = String(track.name || "").trim();
        if (!title) continue;
        var artist = parseArtists(track.artists);
        var album = track.album ? String(track.album.name || "").trim() : "";
        var duration = Number(track.duration || 0);
        var songId = String(track.id || "").trim();
        var localId = null;
        try { localId = await matchLocal(title, artist, album, duration, cache); } catch (e) { localId = null; }
        if (localId) { entries.push({ songId: localId }); matched++; continue; }
        var completedId = null;
        try { completedId = await completeOnline(title, artist); } catch (e) { completedId = null; }
        if (completedId) { entries.push({ songId: completedId }); online++; continue; }
        entries.push({ externalSongId: "netease:" + songId, externalTitle: title, externalArtist: artist, externalAlbum: album, externalDuration: duration > 0 ? duration : null });
        external++;
      }
      return { chartName: chartName, entries: entries, matched: matched, online: online, external: external };
    }

    /** 解析 config 中 chartIds 配置 */
    function parseChartIds(config) {
      var raw = config && config.chartIds;
      if (!raw) return ["3778678"];
      if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
      if (typeof raw === "string") return raw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      return ["3778678"];
    }

    // 首页「本地歌单」分区(localPlatformRecommend)：直接读取本插件每日同步入库的榜单
    // 歌单。封面/数量均取自本地库(DB)字段，真实且无网络依赖；点击即本地播放，三端统一
    // 走本地库直连，绝不走 go-music-dl 导入路线。未同步入库的榜单不展示。
    return {
      /** 首页本地歌单分区(localPlatformRecommend)：读取已入库榜单歌单 */
      async recommendLocal(config) {
        var chartIds = parseChartIds(config);
        var homeCount = Number(config && config.homeCount) || 6;
        var sortOrder = Number(config && config.sortOrder) || 32;
        var playlists = [];
        for (var i = 0; i < chartIds.length && playlists.length < homeCount; i++) {
          var cid = chartIds[i];
          try {
            var p = await host.playlists.get(PLAYLIST_PREFIX + cid);
            if (!p) continue; // 未同步入库 → 不在本地分区展示
            playlists.push({
              id: p.id,
              name: p.name || ("网易云·" + (CHART_NAME[cid] || cid)),
              coverArt: p.cover_art ? ("pl-" + p.id) : "",
              songCount: p.song_count || 0,
            });
          } catch (e) {
            // 单榜读取失败跳过，不影响其它榜
          }
        }
        host.log("网易云榜单本地分区展示: " + playlists.length + " 个已入库榜单");
        return { channels: [{ source: "netease", name: "网易云榜单", count: playlists.length, sortOrder: sortOrder, subtag: "每日更新", playlists: playlists }] };
      },

      /** 每日定时任务：抓取所有所选榜单 → 写入独立歌单 */
      runDailyJob: async function () {
        var config = host.config || {};
        var chartIds = parseChartIds(config);
        var cache = new Map();
        var totalEntries = 0, totalMatched = 0, totalOnline = 0, totalExternal = 0;
        var successCount = 0;

        // 清理 v1.0.x 遗留的固定歌单 id: pl-netease-chart
        try {
          await host.playlists.delete("pl-netease-chart");
          host.log("清理旧版遗留固定歌单: pl-netease-chart");
        } catch (e) {
          // 不存在忽略
        }

        for (var i = 0; i < chartIds.length; i++) {
          var cid = chartIds[i];
          var cname = CHART_NAME[cid] || ("榜单 " + cid);
          try {
            var result = await fetchAndProcess(cid, cache);
            host.log("网易云 " + result.chartName + " 同步获取 " + result.entries.length + " 首(本地匹配 " + result.matched + " 首, 在线补全 " + result.online + " 首, 待补全 " + result.external + " 首)");
            await host.playlists.upsert(PLAYLIST_PREFIX + cid, {
              name: "网易云·" + result.chartName,
              description: "网易云音乐排行榜 - " + result.chartName + "，每日自动同步",
              entries: result.entries,
              sourcePlatform: "netease",
              sourceUrl: "https://music.163.com/#/playlist?id=" + cid,
            });
            totalEntries += result.entries.length;
            totalMatched += result.matched;
            totalOnline += result.online;
            totalExternal += result.external;
            successCount++;
          } catch (e) {
            host.log("网易云" + (CHART_NAME[cid] || cid) + "同步失败: " + (e.message || e));
          }
        }
        var summary = "网易云榜单同步完成: " + successCount + "/" + chartIds.length + " 个榜单, 共 " + totalEntries + " 首, 本地匹配 " + totalMatched + " 首, 在线补全 " + totalOnline + " 首, 待补全 " + totalExternal + " 首";
        host.log(summary);
        return summary;
      },
    };
  },
};