// ============================================================================
//  MusicFlow 外置插件：网易云榜单 (recommender)
// ----------------------------------------------------------------------------
//  自动抓取网易云音乐排行榜并同步到本地音乐库，支持首页固定展示。
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
    version: "1.0.1",
    type: "recommender",
    description:
      "自动抓取网易云音乐排行榜（热歌榜、飙升榜、新歌榜、原创榜）并同步到本地音乐库。对每首歌曲自动匹配本地曲库，未匹配的通过在线源补全或写入外部占位条目，由后端auto-match继续补全为可播条目。支持首页固定展示。",
    capabilities: ["recommendPlaylist"],
    homePlaylistId: "pl-netease-chart",
    defaultEnabled: false,
    minAppVersion: "1.7.39",
    longRunning: { runDailyJob: 120000 },
    permissions: ["net", "storage", "songs:read", "songs:write", "playlists:write"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl:
      "https://github.com/ray5378/MusicFlow-plugins/releases/download/netease-chart-v1.0.1/netease-chart.tar.gz",
    configSchema: [
      {
        key: "chartId",
        label: "选择榜单",
        type: "select",
        required: true,
        options: [
          { value: "3778678", label: "热歌榜" },
          { value: "19723756", label: "飙升榜" },
          { value: "3779629", label: "新歌榜" },
          { value: "2884035", label: "原创榜" },
        ],
        help: "选择要同步到本地音乐库的网易云音乐榜单",
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
      "### 功能介绍\n自动抓取网易云音乐排行榜（支持热歌榜、飙升榜、新歌榜、原创榜）并同步到本地音乐库，支持首页固定展示。\n\n### 处理逻辑\n1. 每日定时任务：从网易云音乐官方API获取榜单数据；\n2. 对每首歌曲尝试匹配本地曲库（按歌名+歌手模糊匹配）；\n3. 本地匹配成功的直接关联到本地曲目，失败的通过已启用的在线源插件（如go-music-dl）补全；\n4. 在线补全仍失败的写入外部占位条目，由后端后台auto-match继续补全为可播条目；\n5. 生成一个固定歌单（id: pl-netease-chart），可配置在首页展示。\n\n### 配置说明\n- 选择一个榜单同步（默认热歌榜）；\n- 可开启「在首页展示」让榜单歌单出现在首页顶部固定卡片。",
  },

  create(host) {
    /** 网易云榜单 playlistId → 中文名称映射 */
    var CHART_NAME = {
      "3778678": "热歌榜",
      "19723756": "飙升榜",
      "3779629": "新歌榜",
      "2884035": "原创榜",
    };

    var NETEASE_API = "https://music.163.com/api/playlist/detail";
    var PLAYLIST_ID = "pl-netease-chart";

    function norm(s) {
      return String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, "");
    }

    async function fetchJson(url) {
      var r = await host.http(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MusicFlow/1.0)",
          Referer: "https://music.163.com/",
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

    /** 从网易云 track 的 artists 数组中提取歌手名串 */
    function parseArtists(artists) {
      if (!Array.isArray(artists) || !artists.length) return "";
      return artists
        .map(function (a) {
          return String(a.name || "").trim();
        })
        .filter(Boolean)
        .join(", ");
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
        var chartId = String(config.chartId || "3778678");
        var chartName = CHART_NAME[chartId] || ("榜单 " + chartId);
        var cache = new Map();

        // 1. 抓取榜单数据
        var data;
        try {
          data = await fetchJson(NETEASE_API + "?id=" + chartId + "&t=" + Date.now());
        } catch (e) {
          host.log("网易云榜单API请求失败: " + (e.message || e));
          return "网易云榜单抓取失败: " + (e.message || e);
        }

if (!data || !data.result || !data.result.tracks) {
          var code = data && data.code;
          host.log("网易云榜单API返回格式异常: code=" + code);
          return "网易云榜单数据格式异常 (code=" + code + ")";
        }

        var tracks = data.result.tracks;
        host.log("网易云" + chartName + "API返回 " + tracks.length + " 首歌曲");

        // 2. 逐曲匹配
        var entries = [];
        var matchedCount = 0;
        var onlineCount = 0;
        var externalCount = 0;

        for (var i = 0; i < tracks.length; i++) {
          var track = tracks[i];
          var title = String(track.name || "").trim();
          if (!title) continue;

          var artist = parseArtists(track.artists);
          var album = track.album ? String(track.album.name || "").trim() : "";
          var duration = Number(track.duration || 0); // 网易云直接用 ms
          var songId = String(track.id || "").trim();

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
            externalSongId: "netease:" + songId,
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
            name: "网易云 · " + chartName,
            description: "网易云音乐排行榜 - " + chartName + "，每日自动同步",
            entries: entries,
            sourcePlatform: "netease",
            sourceUrl: "https://music.163.com/#/playlist?id=" + chartId,
          });
        } catch (e) {
          host.log("歌单写入失败: " + (e.message || e));
          return "歌单写入失败: " + (e.message || e);
        }

        var summary =
          "网易云" +
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