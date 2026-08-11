// ============================================================================
//  MusicFlow-V2 官方外置插件：go-music-dl 封面 (cover / coverProvider)
// ----------------------------------------------------------------------------
//  与 go-music-dl 源插件配套,为缺少封面的歌曲补全封面。
//  本插件已从 MusicFlow-V2 后端「内置」移出,改为通过 MusicFlow-plugins 官方
//  插件市场分发(与 go-music-dl 源、go-music-dl 歌词同源仓库)。
//
//  约定(与后端 discovery.ts 一致):
//    - 必须是 ESM: export const manifest / export const impl
//    - 只能依赖全局 fetch,绝不 import 后端内部模块
//    - 外置插件无法跨插件读配置,故本插件自带 baseUrl(填与源插件相同的地址)
//
//  功能:
//    1) 若歌曲是 go-music-dl web 歌曲,直接复用其 cover 参数;
//    2) 否则按 标题+艺人 搜索 go-music-dl,取第一张封面。
//    (song-card 解析函数内联,不依赖后端。)
// ============================================================================

/** 去掉 baseUrl 结尾的斜杠。 */
function baseUrlOf(config) {
  return String((config && config.baseUrl) || "").replace(/\/+$/, "");
}

/** go-music-dl 的 HTML 里属性值是 HTML-escaped 的(&#34; 等),还原之。 */
function decodeAttr(v) {
  return String(v)
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/** 解析搜索结果里的 <li class="song-card" data-*="..."> 卡片(内联,不依赖后端)。 */
function parseSongCards(html) {
  const songs = [];
  const itemRe = /<li\s+class="song-card"([\s\S]*?)<\/li>/g;
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1];
    const attr = (name) => {
      const re = new RegExp(`data-${name}=(["'])(.*?)\\1`, "i");
      const a = re.exec(block);
      return a ? a[2] : "";
    };
    const id = decodeAttr(attr("id"));
    if (!id) continue;
    songs.push({
      id,
      source: decodeAttr(attr("source")),
      name: decodeAttr(attr("name")),
      artist: decodeAttr(attr("artist")),
      album: decodeAttr(attr("album")),
      duration: parseInt(attr("duration"), 10) || 0,
      cover: decodeAttr(attr("cover")),
      extra: null,
      sortSize: decodeAttr(attr("sort-size")),
      sortBitrate: decodeAttr(attr("sort-bitrate")),
    });
  }
  return songs;
}

/** 插件自描述。核心只读 manifest,绝不读具体实现。 */
export const manifest = {
  id: "go-music-dl-cover",
  name: "go-music-dl 封面",
  version: "1.0.0",
  type: "cover",
  description:
    "通过 go-music-dl 服务为缺少封面的歌曲补全封面。需填写与「go-music-dl 全网聚合」源插件相同的服务地址。官方外置插件(不再随后端内置)。",
  capabilities: ["coverProvider"],
  defaultEnabled: false, // 外置插件默认关,用户在插件页配置 baseUrl 后手动开启
  minAppVersion: "1.0.0",
  author: "ray5378",
  homepage: "https://github.com/ray5378/MusicFlow-plugins",
  downloadUrl:
    "https://raw.githubusercontent.com/ray5378/MusicFlow-plugins/master/plugins/go-music-dl-cover/go-music-dl-cover.tar.gz",
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

/** 插件实现:coverProvider 形态,核心按 capability 调用 searchCover(host, song)。 */
export const impl = {
  async searchCover(host, song) {
    const base = baseUrlOf(host.config);
    if (!base) return null;

    // 1) go-music-dl web 歌曲 → 复用其 cover 参数。
    if (song.url && song.url.includes("/music/download")) {
      try {
        const u = new URL(song.url);
        const c = u.searchParams.get("cover");
        if (c) return { url: c };
      } catch {
        /* fall through to search */
      }
    }

    // 2) 按 标题 + 艺人 搜索 go-music-dl,取第一张封面。
    if (!song.title) return null;
    const q = `${song.artist ? song.artist + " " : ""}${song.title}`;
    const qs = new URLSearchParams({ q, type: "song", sources: "netease,qq,kugou,kuwo" });
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`${base}/music/search?${qs.toString()}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const html = await res.text();
      for (const card of parseSongCards(html)) {
        if (card.cover) return { url: card.cover };
      }
    } catch {
      /* ignore — 另一 provider 可能提供封面 */
    }
    return null;
  },
};
