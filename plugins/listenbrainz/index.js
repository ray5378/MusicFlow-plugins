// ==================== ListenBrainz 播放记录上报（scrobbler） ====================
//
// MusicFlow V2 官方外置插件。把播放事件上报到 ListenBrainz(或任何 API 兼容的自建实例)。
//
// 契约(见 MusicFlow-V2 backend/src/plugins/scrobblers.ts)：
//   onPlay(host, event)      — 开始播放时触发 → 上报「正在播放」(playing_now)
//   onScrobble(host, event)  — 播放超过阈值时触发 → 记一条正式收听(single)
// 两个回调都由核心包在 try/catch + 健康统计里：抛错会被记为该插件的一次失败并
// 显示在后台「插件健康」中，所以这里对可诊断的问题一律抛出明确错误，而不是静默返回。
//
// 自包含：只用全局 fetch，不 import 任何后端内部模块。

export const manifest = {
  id: "listenbrainz",
  name: "ListenBrainz 播放记录",
  version: "1.0.0",
  type: "scrobbler",
  description:
    "把播放记录上报到 ListenBrainz(开源的 Last.fm 替代品)。支持「正在播放」实时状态与正式收听记录,可指向自建实例。",
  capabilities: ["scrobbler"],
  defaultEnabled: false,
  minAppVersion: "1.0.0",
  permissions: ["net"],
  author: "ray5378",
  homepage: "https://github.com/ray5378/MusicFlow-plugins",
  configSchema: [
    {
      key: "userToken",
      label: "用户令牌",
      type: "text",
      required: true,
      help: "在 https://listenbrainz.org/settings/ 页面获取 User token",
    },
    {
      key: "apiUrl",
      label: "API 地址",
      type: "url",
      default: "https://api.listenbrainz.org",
      help: "官方实例留默认即可;自建 ListenBrainz 填你的地址",
    },
    {
      key: "submitPlayingNow",
      label: "上报「正在播放」",
      type: "switch",
      default: true,
      help: "关闭后只在播放达到阈值时记录正式收听,不实时同步当前曲目",
    },
    {
      key: "minDuration",
      label: "最短时长(秒)",
      type: "number",
      default: 30,
      help: "短于该时长的曲目不记录正式收听(ListenBrainz 官方建议忽略 30 秒以下)",
    },
  ],
};

const DEFAULT_API = "https://api.listenbrainz.org";

/** 归一化 API 根地址：去掉结尾斜杠，空值回落到官方实例。 */
function apiBase(host) {
  const raw = String(host.config?.apiUrl || "").trim();
  return (raw || DEFAULT_API).replace(/\/+$/, "");
}

/** 取用户令牌；缺失时抛错，让后台健康面板直接显示原因。 */
function requireToken(host) {
  const token = String(host.config?.userToken || "").trim();
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
  // duration 在 MusicFlow 里是秒，ListenBrainz 要毫秒。
  const secs = Number(event.duration);
  if (Number.isFinite(secs) && secs > 0) info.duration_ms = Math.round(secs * 1000);
  meta.additional_info = info;

  return meta;
}

async function submit(host, body) {
  const token = requireToken(host);
  const res = await fetch(`${apiBase(host)}/1/submit-listens`, {
    method: "POST",
    headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (res.ok) return;

  // 拿到服务端的 error 文本再抛，否则只看到一个光秃秃的状态码，没法排查。
  let detail = "";
  try {
    const text = await res.text();
    try {
      detail = JSON.parse(text)?.error || text;
    } catch {
      detail = text;
    }
  } catch {
    /* 读不到 body 就只报状态码 */
  }

  if (res.status === 401) throw new Error("令牌无效或已失效(HTTP 401),请到 ListenBrainz 设置页重新获取");
  if (res.status === 429) {
    const retry = res.headers?.get?.("Retry-After");
    throw new Error(`触发限流(HTTP 429)${retry ? `,建议 ${retry}s 后重试` : ""}`);
  }
  throw new Error(`上报失败: HTTP ${res.status}${detail ? ` - ${String(detail).slice(0, 200)}` : ""}`);
}

export const impl = {
  /** 开始播放 → 「正在播放」。注意 playing_now 不能带 listened_at，带了会被拒。 */
  async onPlay(host, event) {
    if (host.config?.submitPlayingNow === false) return;
    const meta = trackMetadata(event);
    if (!meta) return; // 缺歌手或标题：无法构造合法 payload，静默跳过
    await submit(host, { listen_type: "playing_now", payload: [{ track_metadata: meta }] });
    host.log?.(`已上报正在播放: ${meta.artist_name} - ${meta.track_name}`);
  },

  /** 播放达到阈值 → 正式收听记录。 */
  async onScrobble(host, event) {
    const meta = trackMetadata(event);
    if (!meta) return;

    // ListenBrainz 官方建议忽略过短的曲目，避免污染统计。
    const min = Number(host.config?.minDuration);
    const secs = Number(event.duration);
    const threshold = Number.isFinite(min) ? min : 30;
    if (Number.isFinite(secs) && secs > 0 && secs < threshold) {
      host.log?.(`跳过过短曲目(${secs}s < ${threshold}s): ${meta.artist_name} - ${meta.track_name}`);
      return;
    }

    // listened_at 是 Unix 秒。playedAt 解析不出来就退回当前时间，
    // 否则会提交 NaN 被服务端拒绝。
    const parsed = Date.parse(event.playedAt);
    const listenedAt = Math.floor((Number.isFinite(parsed) ? parsed : Date.now()) / 1000);

    await submit(host, {
      listen_type: "single",
      payload: [{ listened_at: listenedAt, track_metadata: meta }],
    });
    host.log?.(`已记录收听: ${meta.artist_name} - ${meta.track_name}`);
  },
};

export default { manifest, impl };
