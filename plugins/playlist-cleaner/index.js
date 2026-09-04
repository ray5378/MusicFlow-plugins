// ============================================================================
//  MusicFlow 外置插件：歌单清理 (playlist-cleaner)
// ----------------------------------------------------------------------------
//  一键清理低歌曲数歌单：可设置阈值，自动删除歌曲数量低于该值的歌单。
//  支持每日定时自动清理和手动触发。
//
//  沙箱契约(QuickJS VM 内运行,拿不到 Node 能力):
//    - 纯 JS 脚本,无 import/require/export;把 { manifest, create(host) } 赋给
//      globalThis.__mfPlugin;
//    - 网络一律走 host.http(url, { timeout }) —— 自带超时,无需 AbortController;
//    - 可用 JSON / URL / URLSearchParams(沙箱已注入兼容层) / 标准 JS;
//    - host.config 每次调用前刷新为最新插件配置,调用时实时读取;
//    - 权限:只有 manifest.permissions 声明的能力(此处 playlists:read/write)可用。
// ============================================================================

globalThis.__mfPlugin = {
  manifest: {
    id: "playlist-cleaner",
    name: "歌单清理",
    version: "1.0.3",
    type: "sync",
    schedules: true,
    description:
      "一键清理低歌曲数歌单：可设置最少歌曲数阈值，自动删除歌曲数量低于该值的歌单。支持跳过平台同步歌单和推荐歌单，每日定时自动清理或手动触发。",
    capabilities: ["playlistCleanup"],
    defaultEnabled: false,
    minAppVersion: "1.7.39",
    longRunning: { runDailyJob: 120000 },
    permissions: ["playlists:read", "playlists:write"],
    author: "MusicFlow",
    downloadUrl: "https://github.com/ray5378/MusicFlow-plugins/releases/download/playlist-cleaner-v1.0.3/playlist-cleaner.tar.gz",
    configSchema: [
      {
        key: "minSongs",
        label: "最少歌曲数",
        type: "number",
        default: 5,
        required: true,
        help: "歌单歌曲数量小于或等于此值时会被清理删除。例如输入 5 会删除所有歌曲数 ≤ 5 的歌单。",
      },
      {
        key: "skipSourcePlaylists",
        label: "跳过平台同步歌单",
        type: "switch",
        default: true,
        help: "开启后，会跳过由平台插件（如 go-music-dl）同步来的歌单，只清理本地生成的歌单。",
      },
      {
        key: "skipRecommendPlaylists",
        label: "跳过推荐歌单",
        type: "switch",
        default: true,
        help: "开启后，会跳过每日推荐、本地推荐等系统推荐歌单，只清理其他歌单。",
      },
    ],
  
    i18n: {
  "en": {
    "name": "Playlist Cleaner",
    "description": "Clean up low-song playlists in one click: set a minimum song-count threshold to automatically delete playlists with fewer songs. Supports skipping platform-synced and recommended playlists, with daily scheduled cleanup or manual triggering.",
    "groups": {},
    "fields": {
      "minSongs": {
        "label": "Min song count",
        "help": "Playlists whose song count is less than or equal to this value are cleaned up/deleted. For example, entering 5 deletes every playlist with ≤ 5 songs."
      },
      "skipSourcePlaylists": {
        "label": "Skip platform-synced playlists",
        "help": "When on, playlists synced by platform plugins (such as go-music-dl) are skipped and only locally generated playlists are cleaned."
      },
      "skipRecommendPlaylists": {
        "label": "Skip recommended playlists",
        "help": "When on, system recommendation playlists such as daily and local recommendations are skipped; only other playlists are cleaned."
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
    }
  }
},
  },

  create(host) {
    /** 系统推荐歌单 ID 前缀列表，用于判断是否为推荐歌单 */
    var RECOMMEND_PREFIXES = [
      "pl-daily-",       // 每日推荐
      "pl-local-",       // 本地推荐
      "pl-combo-",       // 今日漫游
      "pl-recommend-",   // 通用推荐
    ];

    /**
     * 判断是否为推荐歌单（根据 id 前缀）
     */
    function isRecommendPlaylist(playlistId) {
      for (var i = 0; i < RECOMMEND_PREFIXES.length; i++) {
        if (playlistId.indexOf(RECOMMEND_PREFIXES[i]) === 0) return true;
      }
      return false;
    }

    /**
     * 判断是否为平台同步歌单（由 source 插件同步而来）
     */
    function isSourcePlaylist(playlist) {
      return !!(playlist.source_plugin && playlist.source_plugin !== "");
    }

    /**
     * 执行歌单清理
     * @param {number} minSongs - 最少歌曲数阈值
     * @param {boolean} skipSource - 是否跳过平台同步歌单
     * @param {boolean} skipRecommend - 是否跳过推荐歌单
     * @returns {string} 清理结果摘要
     */
    async function runCleanup(minSongs, skipSource, skipRecommend) {
      var allPlaylists = await host.playlists.list();
      var deleted = 0;
      var skipped = 0;
      var total = allPlaylists.length;

      for (var i = 0; i < allPlaylists.length; i++) {
        var pl = allPlaylists[i];
        var songCount = Number(pl.song_count) || 0;

        // 跳过歌曲数大于阈值的歌单
        if (songCount > minSongs) continue;

        // 跳过平台同步歌单
        if (skipSource && isSourcePlaylist(pl)) {
          skipped++;
          continue;
        }

        // 跳过推荐歌单
        if (skipRecommend && isRecommendPlaylist(pl.id)) {
          skipped++;
          continue;
        }

        // 删除歌单
        try {
          await host.playlists.delete(pl.id);
          deleted++;
        } catch (e) {
          host.log("删除歌单失败:", pl.id, String(e));
        }
      }

      var summary = "清理完成: 共检查 " + total + " 个歌单, 删除 " + deleted + " 个, 跳过 " + skipped + " 个 (阈值: ≤" + minSongs + " 首)";
      host.log(summary);
      return summary;
    }

    return {
      /**
       * 每日定时任务：读取配置，执行歌单清理
       */
      runDailyJob: async function () {
        var config = host.config;
        var minSongs = Number(config && config.minSongs);
        if (isNaN(minSongs) || minSongs < 0) minSongs = 5;

        var skipSource = !!(config && config.skipSourcePlaylists);
        var skipRecommend = !!(config && config.skipRecommendPlaylists);

        return runCleanup(minSongs, skipSource, skipRecommend);
      },
    };
  },
};