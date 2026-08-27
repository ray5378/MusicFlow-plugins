// ============================================================================
//  MusicFlow 外置插件：QQ音乐榜单 (recommender)
// ----------------------------------------------------------------------------
//  自动抓取QQ音乐巅峰榜并同步到本地音乐库，支持首页固定展示。
//
//  沙箱契约(QuickJS VM 内运行,拿不到 Node 能力):
//    - 纯 JS 脚本:globalThis.__mfPlugin = { manifest, create(host) };
//    - 网络走 host.http(url, { method, headers, timeout });
//    - host.config 每次调用前刷新为最新插件配置;
//    - 权限:manifest.permissions 声明的能力可用。
// ============================================================================

globalThis.__mfPlugin = {
  manifest: {
    id: "qq-chart",
    name: "QQ音乐榜单",
    version: "1.0.1",
    type: "recommender",
    description:
      "自动抓取QQ音乐巅峰榜（热歌榜、抖音热歌榜、K歌金曲榜等14个榜单）并同步到本地音乐库。对每首歌曲自动匹配本地曲库，未匹配的通过在线源补全或写入外部占位条目，由后端auto-match继续补全为可播条目。支持首页固定展示。",
    capabilities: ["recommendPlaylist"],
    homePlaylistId: "pl-qq-chart",
    defaultEnabled: false,
    minAppVersion: "1.7.39",
    longRunning: { runDailyJob: 120000 },
    permissions: ["net", "storage", "songs:read", "songs:write", "playlists:write"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl:
      "https://github.com/ray5378/MusicFlow-plugins/releases/download/qq-chart-v1.0.1/qq-chart.tar.gz",
    configSchema: [
      {
        key: "chartId",
        label: "选择榜单",
        type: "select",
        required: true,
        options: [
          { value: "26", label: "热歌榜(TOP300)" },
          { value: "27", label: "抖音热歌榜" },
          { value: "52", label: "K歌金曲榜" },
          { value: "62", label: "新歌榜" },
          { value: "4", label: "流行指数榜" },
          { value: "36", label: "飙升榜" },
          { value: "5", label: "内地榜" },
          { value: "6", label: "港台榜" },
          { value: "3", label: "欧美榜" },
          { value: "57", label: "影视金曲榜" },
          { value: "51", label: "网络歌曲榜" },
          { value: "59", label: "说唱榜" },
          { value: "60", label: "电音榜" },
          { value: "61", label: "国风热歌榜" },
        ],
        help: "选择要同步到本地音乐库的QQ音乐巅峰榜榜单",
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
      "### 功能介绍\n自动抓取QQ音乐巅峰榜（支持热歌榜、抖音热歌榜、K歌金曲榜、新歌榜、飙升榜等14个榜单）并同步到本地音乐库，支持首页固定展示。\n\n### 处理逻辑\n1. 每日定时任务：从QQ音乐官方API获取榜单数据；\n2. 对每首歌曲尝试匹配本地曲库（按歌名+歌手模糊匹配）；\n3. 本地匹配成功的直接关联到本地曲目，失败的通过已启用的在线源插件（如go-music-dl）补全；\n4. 在线补全仍失败的写入外部占位条目，由后端后台auto-match继续补全为可播条目；\n5. 生成一个固定歌单（id: pl-qq-chart），可配置在首页展示。\n\n### 配置说明\n- 选择一个榜单同步（默认热歌榜）；\n- 可开启「在首页展示」让榜单歌单出现在首页顶部固定卡片。",
  },

  create(host) {
    /** QQ音乐巅峰榜 topid → 中文名称映射 */
    var CHART_NAME = {
      "26": "热歌榜",
      "27": "抖音热歌榜",
      "52": "K歌金曲榜",
      "62": "新歌榜",
      "4": "流行指数榜",
      "36": "飙升榜",
      "5": "内地榜",
      "6": "港台榜",
      "3": "欧美榜",
      "57": "影视金曲榜",
      "51": "网络歌曲榜",
      "59": "说唱榜",
      "60": "电音榜",
      "61": "国风热歌榜",
    };

    var QQ_CHART_API = "https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg";
    var PLAYLIST_ID = "pl-qq-chart";

    /**
     * 字符串归一化：去特殊字符，用于匹配比较
     */
    function norm(s) {
      return String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, "");
    }

    /**
     * GET 请求并解析 JSON
     */
    async function fetchJson(url) {
      var r = await host.http(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MusicFlow/1.0)",
          Referer: "https://y.qq.com/",
        },
        timeout: 15000,
      });
      if (!r.ok) {
        throw new Error("HTTP " + (r.status == null ? "?" : r.status) + ": " + url);
      }
      try {
        return JSON.parse(r.body);
      } catch (e) {
        throw new Error("JSON 解析失败: " + (e.message || e));
      }
    }

    /**
     * 本地曲库模糊匹配：优先「标题+艺人」，再退化「仅标题」
     */
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
        var q = [title, artist].filter(Boolean).join(" ");
        hits = (await host.songs.search(q, { limit: 10 })) || [];
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

      var best = null, bestScore = -1;
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i];
        var hTitle = norm(h.title);
        var hArtist = norm(h.artist);

        var score = 0;
        if (hTitle === tNorm) score += 100;
        else if (hTitle.indexOf(tNorm) >= 0 || tNorm.indexOf(hTitle) >= 0) score += 60;

        if (aNorm && hArtist && (hArtist.indexOf(aNorm) >= 0 || aNorm.indexOf(hArtist) >= 0)) {
          score += 40;
        }

        if (score > bestScore) {
          bestScore = score;
          best = h;
        }
      }

      var id = best && bestScore >= 60 ? best.id : null;
      cache.set(key, id);
      return id;
    }

    /**
     * 通过已启用的在线源插件（如 go-music-dl）补全为可播 songId
     */
    async function completeOnline(title, artist) {
      try {
        var res = await host.sources.complete({ artist: artist, title: title });
        return res && res.songId ? res.songId : null;
      } catch (e) {
        return null;
      }
    }

    return {
      /**
       * 每日定时任务：抓取QQ音乐榜单 → 匹配本地曲库 → 写入固定歌单
       */
      runDailyJob: async function () {
        var config = host.config || {};
        var chartId = String(config.chartId || "26");
        var chartName = CHART_NAME[chartId] || ("榜单 " + chartId);
        var cache = new Map();

        // 1. 抓取榜单数据
        var data;
        try {
          data = await fetchJson(
            QQ_CHART_API + "?topid=" + chartId + "&format=json&t=" + Date.now()
          );
        } catch (e) {
          host.log("QQ音乐榜单API请求失败: " + (e.message || e));
          return "QQ音乐榜单抓取失败: " + (e.message || e);
        }

        if (!data || data.code !== 0 || !data.songlist) {
          var code = data && data.code;
          host.log("QQ音乐榜单API返回格式异常: code=" + code);
          return "QQ音乐榜单数据格式异常 (code=" + code + ")";
        }

        var songs = data.songlist;
        host.log("QQ音乐" + chartName + "API返回 " + songs.length + " 首歌曲");

        // 2. 逐曲匹配
        var entries = [];
        var matchedCount = 0;
        var onlineCount = 0;
        var externalCount = 0;

        for (var i = 0; i < songs.length; i++) {
          var item = (songs[i] && songs[i].data) || {};
          var title = String(item.songname || "").trim();
          if (!title) continue;

          var artist = "";
          if (item.singer && item.singer.length > 0) {
            artist = String(item.singer[0].name || "").trim();
          }
          var album = String(item.albumname || "").trim();
          var duration = (parseInt(item.interval, 10) || 0) * 1000;
          var songmid = String(item.songmid || "").trim();

          // 2a. 本地曲库匹配
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

          // 2b. 在线源补全
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

          // 2c. 外部占位（由后端auto-match继续补全）
          entries.push({
            externalSongId: "qq:" + songmid,
            externalTitle: title,
            externalArtist: artist,
            externalAlbum: album,
            externalDuration: duration,
          });
          externalCount++;
        }

        // 3. 写入固定歌单
        try {
          await host.playlists.upsert(PLAYLIST_ID, {
            name: "QQ音乐 · " + chartName,
            description: "QQ音乐巅峰榜 - " + chartName + "，每日自动同步",
            entries: entries,
            sourcePlatform: "qq",
            sourceUrl: "https://y.qq.com/n/ryqq/toplist/" + chartId,
          });
        } catch (e) {
          host.log("歌单写入失败: " + (e.message || e));
          return "歌单写入失败: " + (e.message || e);
        }

        var summary =
          "QQ音乐" +
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