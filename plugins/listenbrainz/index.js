// ==================== ListenBrainz 播放记录上报（scrobbler） ====================
//
// MusicFlow V2 官方外置插件。把播放事件上报到 ListenBrainz(或任何 API 兼容的自建实例)。
//
// 沙箱契约(QuickJS VM 内运行,拿不到 Node 能力):
//   - 纯 JS 脚本:globalThis.__mfPlugin = { manifest, create(host) };
//   - 网络走 host.http(url, { method, headers, body, timeout }),返回
//     { ok, status, headers, body(text) };
//   - host.config 每次调用前刷新,调用时实时读取(cfg());
//   - 两个回调由核心包在 try/catch + 健康统计里,抛错会在后台「插件健康」显示。
//
// 契约(见 MusicFlow-V2 backend/src/plugins/scrobblers.ts)：
//   onPlay(host, event)      — 开始播放时触发 → 上报「正在播放」(playing_now)
//   onScrobble(host, event)  — 播放超过阈值时触发 → 记一条正式收听(single)

globalThis.__mfPlugin = {
  manifest: {
    id: "listenbrainz",
    name: "ListenBrainz 播放记录",
    version: "1.1.0",
    type: "scrobbler",
    description:
      "把播放记录上报到 ListenBrainz(开源的 Last.fm 替代品)。支持「正在播放」实时状态与正式收听记录,可指向自建实例。运行于 QuickJS 沙箱。",
    capabilities: ["scrobbler"],
    defaultEnabled: false,
    minAppVersion: "1.3.0", // 沙箱运行时自 v1.3.0 起
    permissions: ["net"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl: "https://github.com/ray5378/MusicFlow-plugins/releases/download/listenbrainz-v1.1.0/listenbrainz.tar.gz",
    configSchema: [
      { key: "userToken", label: "用户令牌", type: "text", required: true, help: "在 https://listenbrainz.org/settings/ 页面获取 User token" },
      { key: "apiUrl", label: "API 地址", type: "url", default: "https://api.listenbrainz.org", help: "官方实例留默认即可;自建 ListenBrainz 填你的地址" },
      { key: "submitPlayingNow", label: "上报「正在播放」", type: "switch", default: true, help: "关闭后只在播放达到阈值时记录正式收听,不实时同步当前曲目" },
      { key: "minDuration", label: "最短时长(秒)", type: "number", default: 30, help: "短于该时长的曲目不记录正式收听(ListenBrainz 官方建议忽略 30 秒以下)" },
    ],
  },

  create(host) {
    const DEFAULT_API = "https://api.listenbrainz.org";
    const cfg = () => host.config || {};

    /** 归一化 API 根地址：去掉结尾斜杠，空值回落到官方实例。 */
    function apiBase() {
      const raw = String(cfg().apiUrl || "").trim();
      return (raw || DEFAULT_API).replace(/\/+$/, "");
    }

    /** 取用户令牌；缺失时抛错，让后台健康面板直接显示原因。 */
    function requireToken() {
      const token = String(cfg().userToken || "").trim();
      if (!token) throw new Error("未配置 ListenBrainz 用户令牌(userToken)");
      return token;
    }

    /** ListenBrainz 强制要求 artist_name 与 track_name 非空，缺任一条就无法提交。 */
    function trackMetadata(event, extra) {
      const artist = String(event.artist || "").trim();
      const title = String(event.title || "").trim();
      if (!artist || !title) return null;

      const meta = { artist_name: artist, track_name: title };
      const album = String(event.album || "").trim();
      if (album) meta.release_name = album;

      const info = { media_player: "MusicFlow", submission_client: "MusicFlow-V2", ...(extra || {}) };
      const secs = Number(event.duration);
      if (Number.isFinite(secs) && secs > 0) info.duration_ms = Math.round(secs * 1000);
      meta.additional_info = info;
      return meta;
    }

    async function submit(body) {
      const token = requireToken();
      const r = await host.http(apiBase() + "/1/submit-listens", {
        method: "POST",
        headers: { Authorization: "Token " + token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeout: 15000,
      });
      if (r.ok) return;

      let detail = "";
      try {
        const t = r.body || "";
        try { detail = (JSON.parse(t) || {}).error || t; } catch { detail = t; }
      } catch { /* 读不到 body 就只报状态码 */ }

      if (r.status === 401) throw new Error("令牌无效或已失效(HTTP 401),请到 ListenBrainz 设置页重新获取");
      if (r.status === 429) {
        const retry = r.headers && (r.headers["retry-after"] || r.headers["Retry-After"]);
        throw new Error("触发限流(HTTP 429)" + (retry ? ",建议 " + retry + "s 后重试" : ""));
      }
      throw new Error("上报失败: HTTP " + r.status + (detail ? " - " + String(detail).slice(0, 200) : ""));
    }

    return {
      /** 开始播放 → 「正在播放」。注意 playing_now 不能带 listened_at，带了会被拒。 */
      async onPlay(event) {
        if (cfg().submitPlayingNow === false) return;
        const meta = trackMetadata(event);
        if (!meta) return; // 缺歌手或标题：无法构造合法 payload，静默跳过
        await submit({ listen_type: "playing_now", payload: [{ track_metadata: meta }] });
        try { host.log("已上报正在播放: " + meta.artist_name + " - " + meta.track_name); } catch { /* ignore */ }
      },

      /** 播放达到阈值 → 正式收听记录。 */
      async onScrobble(event) {
        const meta = trackMetadata(event);
        if (!meta) return;

        const min = Number(cfg().minDuration);
        const secs = Number(event.duration);
        const threshold = Number.isFinite(min) ? min : 30;
        if (Number.isFinite(secs) && secs > 0 && secs < threshold) {
          try { host.log("跳过过短曲目(" + secs + "s < " + threshold + "s): " + meta.artist_name + " - " + meta.track_name); } catch { /* ignore */ }
          return;
        }

        const parsed = Date.parse(event.playedAt);
        const listenedAt = Math.floor((Number.isFinite(parsed) ? parsed : Date.now()) / 1000);

        await submit({
          listen_type: "single",
          payload: [{ listened_at: listenedAt, track_metadata: meta }],
        });
        try { host.log("已记录收听: " + meta.artist_name + " - " + meta.track_name); } catch { /* ignore */ }
      },
    };
  },
};
