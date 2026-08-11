// ============================================================================
//  MusicFlow-V2 官方外置插件：go-music-dl 歌词 (lyrics / lyricProvider)
// ----------------------------------------------------------------------------
//  与 go-music-dl 源插件配套,从同一台 go-music-dl 服务获取 LRC 歌词。
//  本插件已从 MusicFlow-V2 后端「内置」移出,改为通过 MusicFlow-plugins 官方
//  插件市场分发(与 go-music-dl 源、go-music-dl 封面同源仓库)。
//
//  约定(与后端 discovery.ts 一致):
//    - 必须是 ESM: export const manifest / export const impl
//    - 只能依赖全局 fetch,绝不 import 后端内部模块
//    - 外置插件无法跨插件读配置,故本插件自带 baseUrl(填与源插件相同的地址)
//
//  功能: 由已存储的 /music/download 流地址构造 /music/download_lrc 歌词地址,
//        向 go-music-dl 请求 LRC 文本。
// ============================================================================

/** 去掉 baseUrl 结尾的斜杠。 */
function baseUrlOf(config) {
  return String((config && config.baseUrl) || "").replace(/\/+$/, "");
}

/** 由已存储的 /music/download 流地址构造 /music/download_lrc 歌词地址。 */
function lrcUrlFromSong(song) {
  if (!song.url || !song.url.includes("/music/download")) return null;
  try {
    const u = new URL(song.url);
    if (!u.pathname.endsWith("/music/download")) return null;
    u.pathname = u.pathname.slice(0, -"/music/download".length) + "/music/download_lrc";
    u.searchParams.delete("stream");
    u.searchParams.delete("range");
    u.searchParams.delete("cover");
    u.searchParams.delete("embed");
    u.searchParams.set("format", "line");
    if ((song.duration || 0) > 0 && !u.searchParams.has("duration")) {
      u.searchParams.set("duration", String(song.duration));
    }
    return u.toString();
  } catch {
    return null;
  }
}

/** 插件自描述。核心只读 manifest,绝不读具体实现。 */
export const manifest = {
  id: "go-music-dl-lyrics",
  name: "go-music-dl 歌词",
  version: "1.0.0",
  type: "lyrics",
  description:
    "通过 go-music-dl 服务为在线歌曲获取 LRC 歌词。需填写与「go-music-dl 全网聚合」源插件相同的服务地址。官方外置插件(不再随后端内置)。",
  capabilities: ["lyricProvider"],
  defaultEnabled: false, // 外置插件默认关,用户在插件页配置 baseUrl 后手动开启
  minAppVersion: "1.0.0",
  author: "ray5378",
  homepage: "https://github.com/ray5378/MusicFlow-plugins",
  downloadUrl:
    "https://raw.githubusercontent.com/ray5378/MusicFlow-plugins/master/plugins/go-music-dl-lyrics/go-music-dl-lyrics.tar.gz",
  permissions: ["net"],
  configSchema: [
    {
      key: "baseUrl",
      label: "服务地址",
      type: "url",
      required: true,
      help: "填写你的 go-music-dl 服务地址(与「go-music-dl 全网聚合」源插件一致)",
    },
  ],
};

/** 插件实现:lyricProvider 形态,核心按 capability 调用 searchLyrics(host, song)。 */
export const impl = {
  async searchLyrics(host, song) {
    const base = baseUrlOf(host.config);
    if (!base) return null;
    const lrcUrl = lrcUrlFromSong(song);
    if (!lrcUrl) return null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(lrcUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const text = await res.text();
      if (!text || text.startsWith("Lyric not found")) return null;
      return { lrc: text };
    } catch {
      return null;
    }
  },
};
