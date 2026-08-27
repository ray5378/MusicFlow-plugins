// ============================================================================
//  MusicFlow 外置插件：酷狗榜单 (recommender)
// ----------------------------------------------------------------------------
//  自动抓取酷狗排行榜并同步到本地音乐库，支持首页固定展示。
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
    version: "1.0.0",
    type: "recommender",
    description:
      "自动抓取酷狗排行榜（TOP500、飙升榜、网络红歌榜、DJ热歌榜）并同步到本地音乐库。对每首歌曲自动匹配本地曲库，未匹配的通过在线源补全或写入外部占位条目，由后端auto-match继续补全为可播条目。支持首页固定展示。",
    capabilities: ["recommendPlaylist"],
    homePlaylistId: "pl-kugou-chart",
    defaultEnabled: false,
    minAppVersion: "1.7.39",
    longRunning: { runDailyJob: 120000 },
    permissions: ["net", "storage", "songs:read", "songs:write", "playlists:write"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl:
      "https://github.com/ray5378/MusicFlow-plugins/releases/download/kugou-chart-v1.0.0/kugou-chart.tar.gz",
    configSchema: [
      {
        key: "chartId",
        label: "选择榜单",
        type: "select",
        required: true,
        default: "8888",
        options: [
          { value: "8888", label: "酷狗TOP500" },
          { value: "6666", label: "飙升榜" },
          { value: "23784", label: "网络红歌榜" },
          { value: "24971", label: "DJ热歌榜" },
        ],
        help: "选择要同步到本地音乐库的酷狗榜单",
      },
      {
        key: "pageSize",
        label: "每页数量",
        type: "number",
        default: 100,
        help: "每页获取多少首歌曲，TOP500需要分多次获取",
      },
      {
        key: "maxPages",
        label: "获取页数",
        type: "number",
        default: 5,
        help: "最多获取多少页，TOP500:5页=500首，飙升榜:2页=200首",
      },
      {
        key: "showOnHome",
        label: "在首页展示",
        type: "switch",
        default: true,
        help: "开启后，该榜单歌单会显示在首页顶部的固定卡片中",
      },
      {
        key: "homePosition",
        label: "首页位置",
        type: "number",
        default: 0,
        help: "首页固定位次（1起；0=未固定）",
      },
    ],
    documentation:
      "### 功能介绍\n自动抓取酷狗排行榜（支持TOP500、飙升榜、网络红歌榜、DJ热歌榜）并同步到本地音乐库，支持首页固定展示。\n\n### 处理逻辑\n1. 每日定时任务：从酷狗移动端API获取榜单数据；\n2. 对每首歌曲尝试匹配本地曲库（按歌名+歌手模糊匹配）；\n3. 本地匹配成功的直接关联到本地曲目，失败的通过已启用的在线源插件（如go-music-dl）补全；\n4. 在线补全仍失败的写入外部占位条目，由后端后台auto-match继续补全为可播条目；\n5. 生成一个固定歌单（id: pl-kugou-chart），可配置在首页展示。\n\n### 配置说明\n- 选择一个榜单同步（默认TOP500）；\n- 可开启「在首页展示」让榜单歌单出现在首页顶部固定卡片。",
  },

  create(host) {
    /** 酷狗榜单 rankid → 中文名称映射 */
    var CHART_NAME = {
      "8888": "TOP500",
      "6666": "飙升榜",
      "23784": "网络红歌榜",
      "24971": "DJ热歌榜",
    };

    var KUGOU_API_BASE = "http://m.kugou.com";
    var PLAYLIST_ID = "pl-kugou-chart";

    function norm(s) {
      return String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, "");
    }

    async function fetchJson(url) {
      var r = await host.http(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MusicFlow/1.0)",
        },
        timeout: 15000,
      });
      if (!r.ok) throw new Error("HTTP " + (r.status || "?") + ": " + url);
      try {
        return JSON.parse(r.body);
      } catch (e) {
        throw new Error("JSON 解析失败: " + (e.message || e));
      }
    }

    /** 解析酷狗榜单中的歌手名字串 */
    function parseArtist(authors) {
      if (!authors || !Array.isArray(authors)) return "";
      var names = authors
        .map(function (a) {
          return String(a.author_name || "").trim();
        })
        .filter(Boolean);
      return names.join(", ");
    }

    async function matchLocal(title, artist, cache) {
      var key = String(title || "") + "|" + String(artist || "");
      if (cache.has(key)) return cache.get(key);

      var tNorm = norm(title);
      if (!tNorm) {
        cache.set(key, null);
        return null;
      }
      var aNorm = norm(artist);

      var hits = [];
      try {
        hits = (await host.songs.search([title, artist].filter(Boolean).join(" "), { limit: 10 })) || [];
      } catch (e) {
        hits = [];
      }
      if (!hits.length) {
        try {
          hits = (await host.songs.search(title, { limit: 10 })) || [];
        } catch (e) {
          hits = [];
        }
      }
      if (!hits.length) {
        cache.set(key, null);
        return null;
      }

      var best = null,
        bestScore = -1;
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i];
        var hTitle = norm(h.title);
        var hArtist = norm(h.artist);
        var score = 0;
        if (hTitle === tNorm) score += 100;
        else if (hTitle.indexOf(tNorm) >= 0 || tNorm.indexOf(hTitle) >= 0) score += 60;
        if (aNorm && hArtist && (hArtist.indexOf(aNorm) >= 0 || aNorm.indexOf(hArtist) >= 0)) score += 40;
        if (score > bestScore) {
          bestScore = score;
          best = h;
        }
      }
      var id = best && bestScore >= 60 ? best.id : null;
      cache.set(key, id);
      return id;
    }

    async function completeOnline(title, artist) {
      try {
        var res = await host.sources.complete({ artist: artist, title: title });
        return res && res.songId ? res.songId : null;
      } catch (e) {
        return null;
      }
    }

    return {
      runDailyJob: async function () {
        var config = host.config || {};
        var rankid = String(config.chartId || "8888");
        var pageSize = Math.max(10, Number(config.pageSize) || 100);
        var maxPages = Math.max(1, Number(config.maxPages) || 5);
        var chartName = CHART_NAME[rankid] || ("榜单 " + rankid);

        var cache = new Map();
        var allSongs = [];
        var matchedCount = 0;
        var onlineCount = 0;
        var externalCount = 0;

        // 1. 逐页抓取榜单数据
        for (var page = 1; page <= maxPages; page++) {
          var url = KUGOU_API_BASE + "/rank/info/?rankid=" + rankid + "&page=" + page + "&json=true";
          try {
            var data = await fetchJson(url);
            if (data && data.infos && Array.isArray(data.infos)) {
              allSongs = allSongs.concat(data.infos);
              host.log(
                "第" +
                  page +
                  "页获取 " +
                  data.infos.length +
                  " 首, 累计 " +
                  allSongs.length +
                  " 首(" +
                  chartName +
                  ")"
              );
              if (data.infos.length < pageSize) break;
            }
          } catch (e) {
            host.log("第" + page + "页获取失败: " + (e.message || e));
            break;
          }
        }

        if (!allSongs.length) {
          return "酷狗" + chartName + "未获取到歌曲数据";
        }

        // 2. 逐曲匹配
        var entries = [];
        for (var i = 0; i < allSongs.length; i++) {
          var item = allSongs[i];
          var title = String(item.songname || "").trim();
          if (!title) continue;

          var artist = parseArtist(item.authors);
          var album = String(item.albumname || "").trim();
          var duration = Number(item.duration || 0) * 1000;
          var hash = String(item.hash || "").trim();

          var localId = null;
          try {
            localId = await matchLocal(title, artist, cache);
          } catch (e) {
            localId = null;
          }
          if (localId) {
            entries.push({ songId: localId });
            matchedCount++;
            continue;
          }

          var completedId = null;
          try {
            completedId = await completeOnline(title, artist);
          } catch (e) {
            completedId = null;
          }
          if (completedId) {
            entries.push({ songId: completedId });
            onlineCount++;
            continue;
          }

          entries.push({
            externalSongId: "kugou:" + hash,
            externalTitle: title,
            externalArtist: artist,
            externalAlbum: album,
            externalDuration: duration > 0 ? duration : null,
          });
          externalCount++;
        }

        // 3. 写入固定歌单
        try {
          await host.playlists.upsert(PLAYLIST_ID, {
            name: "酷狗 · " + chartName,
            description: "酷狗排行榜 - " + chartName + "，每日自动同步",
            entries: entries,
            sourcePlatform: "kugou",
            sourceUrl: "https://www.kugou.com/web/rank/",
          });
        } catch (e) {
          host.log("歌单写入失败: " + (e.message || e));
          return "歌单写入失败: " + (e.message || e);
        }

        var summary =
          "酷狗" +
          chartName +
          "同步完成: 共 " +
          entries.length +
          " 首, 本地匹配 " +
          matchedCount +
          " 首, 在线补全 " +
          onlineCount +
          " 首, 待补全 " +
          externalCount +
          " 首";
        host.log(summary);
        return summary;
      },
    };
  },
};