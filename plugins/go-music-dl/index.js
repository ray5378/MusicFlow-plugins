// ============================================================================
//  MusicFlow-V2 官方外置插件：go-music-dl 全网聚合 (source + lyrics + cover)
// ----------------------------------------------------------------------------
//  三合一插件:源(搜索/推荐/歌单/流) + 歌词 + 封面,全部走同一台 go-music-dl 服务,
//  共用同一份 baseUrl 配置。已从 MusicFlow-V2 后端「内置」移出,改为通过
//  MusicFlow-plugins 官方插件市场分发。
//
//  对应 V1 时代的三个插件(go-music-dl / go-music-dl-lyrics / go-music-dl-cover)
//  已合并为本文件:单个 manifest 声明全部能力,单个 impl 实现全部方法。核心按
//  capability 遍历调用,与拆不拆分无关。
//
//  约定(与后端 discovery.ts 一致):
//    - 必须是 ESM: export const manifest / export const impl
//    - 只能依赖全局 fetch,绝不 import 后端内部模块(host.* 契约之外不引入耦合)
//    - manifest.id 全局唯一;与已注册插件重名会被跳过
//    - 仅声明的能力会被核心调用(source 路径收 config,provider 路径收 host)
//
//  功能: 通过你在局域网部署的 go-music-dl 网页服务搜索全网音乐、获取推荐歌单、
//        拉取歌单详情、生成流式播放地址,并为在线歌曲提供 LRC 歌词与封面。
// ============================================================================

/** 支持的搜索平台(同时作为「搜索平台」多选选项)。 */
const PLATFORMS = [
  { value: "netease", label: "网易云" },
  { value: "qq", label: "QQ 音乐" },
  { value: "kugou", label: "酷狗" },
  { value: "kuwo", label: "酷我" },
  { value: "migu", label: "咪咕" },
  { value: "qianqian", label: "千千" },
  { value: "soda", label: "汽水" },
  { value: "fivesing", label: "5sing" },
  { value: "jamendo", label: "Jamendo" },
  { value: "joox", label: "JOOX" },
  { value: "bilibili", label: "Bilibili" },
  { value: "apple", label: "Apple Music" },
];

/** 统一取 baseUrl:source 路径直接收到 config,provider 路径收到 host.config。 */
function baseOf(input) {
  const cfg = input && input.config ? input.config : input;
  return String((cfg && cfg.baseUrl) || "").replace(/\/+$/, "");
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

/** 解析 data-extra 属性里嵌的 JSON(或退化成 generic dict)。 */
function parseSongExtra(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/&#34;/g, '"').replace(/&#39;/g, "'");
  try {
    const direct = JSON.parse(cleaned);
    if (direct && typeof direct === "object") return direct;
  } catch {
    /* fall through to generic dict parse */
  }
  const generic = {};
  for (const m of cleaned.matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)) {
    generic[m[1]] = m[2];
  }
  return Object.keys(generic).length ? generic : null;
}

/** 解析搜索结果里的 <li class="song-card" data-*="..."> 卡片。 */
function parseSongCards(html) {
  const songs = [];
  const itemRe = /<li\s+class="song-card"([\s\S]*?)<\/li>/g;
  let m;
  while ((m = itemRe.exec(html)) !== null) {
    const block = m[1];
    const attr = (name) => {
      // go-music-dl 对普通 data-* 用双引号,对 data-extra='{...}' 用单引号(内嵌 JSON)。
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
      extra: parseSongExtra(attr("extra")),
      sortSize: decodeAttr(attr("sort-size")),
      sortBitrate: decodeAttr(attr("sort-bitrate")),
    });
  }
  return songs;
}

/** 解析 /music/recommend 里的平台分类 tab 与歌单卡片。 */
function parseRecommendPlaylists(html) {
  const channels = [];
  const tabRe = /<button[^>]*class="category-source-tab[^"]*"[^>]*data-target="([^"]*recommend-([a-z]+))"[^>]*>([\s\S]*?)<\/button>/g;
  let tm;
  while ((tm = tabRe.exec(html)) !== null) {
    const source = tm[2].toLowerCase();
    const inner = tm[3];
    const nameM = /category-source-tab-name"[^>]*>\s*([^<]+?)\s*</.exec(inner);
    const countM = /category-source-tab-count"[^>]*>\s*(\d+)\s*</.exec(inner);
    channels.push({
      source,
      name: nameM ? decodeAttr(nameM[1]) : source,
      count: countM ? parseInt(countM[1], 10) || 0 : 0,
      playlists: [],
    });
  }
  const cardRe = /<div\s+class="playlist-card"[^>]*onclick="navigateTo\(\s*['"](.*?)['"]\s*\)"/g;
  let cm;
  while ((cm = cardRe.exec(html)) !== null) {
    let path = decodeAttr(cm[1]).replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
    if (!path.startsWith("/music/playlist")) continue;
    const p = path.split("?")[1] || "";
    if (!p) continue;
    const params = new URLSearchParams(p);
    const source = params.get("source") || "";
    const id = params.get("id") || "";
    if (!source || !id) continue;
    const info = {
      id,
      source,
      name: params.get("name") || "",
      creator: params.get("creator") || "",
      cover: params.get("cover") || "",
      trackCount: params.get("track_count") || "",
      link: params.get("link") || "",
    };
    const ch =
      channels.find((c) => c.source === source) ||
      channels.find((c) => c.source.toLowerCase() === source.toLowerCase());
    if (ch) ch.playlists.push(info);
    else channels.push({ source, name: source, count: 0, playlists: [info] });
  }
  return channels;
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
  id: "go-music-dl",
  name: "go-music-dl 全网聚合",
  version: "1.1.1",
  type: "source",
  description:
    "三合一官方外置插件:通过局域网已部署的 go-music-dl 服务搜索全网音乐、获取推荐歌单、流式播放,并为在线歌曲提供 LRC 歌词与封面。源 / 歌词 / 封面共用同一份服务地址配置。",
  // 源系能力 + 歌词 + 封面,全部声明在同一个 manifest 里。
  capabilities: [
    "search",
    "recommend",
    "playlistSongs",
    "stream",
    "webRotation",
    "lyricProvider",
    "coverProvider",
  ],
  platforms: PLATFORMS.map((p) => p.value),
  recommendPrefix: "gmdl://recommend/",
  defaultEnabled: false, // 外置插件默认关,用户在插件页配置 baseUrl 后手动开启
  minAppVersion: "1.0.0", // dev 构建不受限;正式版要求 App >= 1.0.0
  permissions: ["net"],
  author: "ray5378",
  homepage: "https://github.com/ray5378/MusicFlow-plugins",
  downloadUrl:
    "https://raw.githubusercontent.com/ray5378/MusicFlow-plugins/master/plugins/go-music-dl/go-music-dl.tar.gz",
  // 一份 baseUrl 同时服务 源 / 歌词 / 封面(不再各填一次)。
  configSchema: [
    {
      key: "baseUrl",
      label: "服务地址",
      type: "url",
      required: true,
      help: "填写你在局域网部署的 go-music-dl 网页服务地址(源 / 歌词 / 封面共用)",
    },
    { key: "sources", label: "搜索平台", type: "multiselect", options: PLATFORMS },
    {
      key: "webSongsMode",
      label: "web 歌曲",
      type: "radio",
      options: [
        { label: "永不过期", value: "keep" },
        { label: "定期清理", value: "rotate" },
      ],
    },
    {
      key: "webSongsRetentionDays",
      label: "保留天数",
      type: "number",
      help: "超过该天数且不再被任何歌单/收藏引用的在线歌曲会被自动清理(含封面);仍在歌单或收藏中的不受影响。保留 0 天 = 下架即清。",
    },
  ],
};

/** 插件实现:source + lyricProvider + coverProvider 形态,核心按 capability 调用对应方法。 */
export const impl = {
  async test(config) {
    const url = baseOf(config);
    if (!url) return { success: false, message: "未配置 go-music-dl 地址" };
    try {
      const res = await fetch(`${url}/music/?type=song&sources=netease`, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { success: false, message: `HTTP ${res.status}` };
      const html = await res.text();
      if (!html.includes("music-dl") && !html.includes("聚合搜索")) {
        return { success: false, message: "响应不是 go-music-dl 页面(地址可能指向了其他服务)" };
      }
      return { success: true, message: "连接成功" };
    } catch (e) {
      return { success: false, message: e?.message || "连接失败" };
    }
  },

  async search(config, params) {
    const url = `${baseOf(config)}/music/search`;
    const qs = new URLSearchParams({ q: params.query, type: "song" });
    for (const s of params.sources || []) qs.append("sources", s);
    const res = await fetch(`${url}?${qs.toString()}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`go-music-dl 搜索失败: HTTP ${res.status}`);
    const html = await res.text();
    return { songs: parseSongCards(html) };
  },

  async recommend(config) {
    const url = `${baseOf(config)}/music/recommend`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`go-music-dl 获取推荐歌单失败: HTTP ${res.status}`);
    const html = await res.text();
    return { channels: parseRecommendPlaylists(html) };
  },

  async playlistSongs(config, source, id) {
    const root = baseOf(config);
    // go-music-dl 服务端分页渲染 song-card(page_size 上限 500)。
    const totalRe = /data-total-count="(\d+)"/;
    let page = 1;
    let total = 0;
    const all = [];
    do {
      const qs = new URLSearchParams({ source, id, page: String(page), page_size: "500" });
      const res = await fetch(`${root}/music/playlist?${qs.toString()}`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`go-music-dl 获取歌单详情失败: HTTP ${res.status}`);
      const html = await res.text();
      if (page === 1) {
        const m = totalRe.exec(html);
        if (m) total = parseInt(m[1], 10) || 0;
      }
      all.push(...parseSongCards(html));
      page++;
    } while (total > 0 && all.length < total && page <= 50); // 硬上限 50 页
    return { songs: all, name: "" };
  },

  streamUrl(config, song, range) {
    const qs = new URLSearchParams({
      id: song.id,
      source: song.source,
      name: song.name || "Unknown",
      artist: song.artist || "Unknown",
      stream: "1",
    });
    if (song.album) qs.set("album", song.album);
    if (song.cover) qs.set("cover", song.cover);
    if (song.extra) qs.set("extra", JSON.stringify(song.extra));
    if (range) qs.set("range", range);
    return `${baseOf(config)}/music/download?${qs.toString()}`;
  },

  // ---- lyricProvider:由已存储的 /music/download 流地址构造 /music/download_lrc 歌词地址 ----
  async searchLyrics(host, song) {
    const base = baseOf(host);
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

  // ---- coverProvider:go-music-dl web 歌曲复用其 cover 参数,否则按 标题+艺人 搜索取首图 ----
  async searchCover(host, song) {
    const base = baseOf(host);
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
