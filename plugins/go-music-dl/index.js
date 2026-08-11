// ============================================================================
//  MusicFlow-V2 官方外置插件：go-music-dl 全网聚合 (source)
// ----------------------------------------------------------------------------
//  本插件已从 MusicFlow-V2 后端「内置」中移出,改为通过 MusicFlow-plugins 官方
//  插件市场分发。安装方式二选一:
//    1) 插件管理页 → 「插件市场」→ 添加官方注册表 → 一键安装;
//    2) 手动把本目录(含 index.js + plugin.json)复制到 <data>/plugins/go-music-dl/。
//
//  约定(与后端 discovery.ts 一致):
//    - 必须是 ESM: export const manifest / export const impl
//    - 只能依赖全局 fetch,绝不 import 后端内部模块(host.* 契约之外不引入耦合)
//    - manifest.id 全局唯一;与已注册插件重名会被跳过
//    - 仅声明的能力会被核心调用
//
//  功能: 通过你在局域网部署的 go-music-dl 网页服务搜索全网音乐、获取推荐歌单、
//        拉取歌单详情、生成流式播放地址与 LRC 歌词地址。
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

/** 去掉 baseUrl 结尾的斜杠。 */
function baseUrl(config) {
  return String(config?.baseUrl || "").replace(/\/+$/, "");
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

/** 插件自描述。核心只读 manifest,绝不读具体实现。 */
export const manifest = {
  id: "go-music-dl",
  name: "go-music-dl 全网聚合",
  version: "1.0.0",
  type: "source",
  description:
    "通过局域网已部署的 go-music-dl 服务搜索全网音乐,并把结果作为在线歌曲保存入库。官方外置插件(不再随后端内置)。",
  capabilities: ["search", "recommend", "playlistSongs", "stream", "webRotation"],
  platforms: PLATFORMS.map((p) => p.value),
  recommendPrefix: "gmdl://recommend/",
  defaultEnabled: false, // 外置插件默认关,用户在插件页配置 baseUrl 后手动开启
  minAppVersion: "1.0.0", // dev 构建不受限;正式版要求 App >= 1.0.0
  downloadUrl:
    "https://raw.githubusercontent.com/ray5378/MusicFlow-plugins/master/plugins/go-music-dl/go-music-dl.tar.gz",
  configSchema: [
    {
      key: "baseUrl",
      label: "服务地址",
      type: "url",
      required: true,
      help: "填写你在局域网部署的 go-music-dl 网页服务地址",
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

/** 插件实现:OnlineProvider 形态,核心按 capability 调用对应方法。 */
export const impl = {
  async test(config) {
    const url = baseUrl(config);
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
    const url = `${baseUrl(config)}/music/search`;
    const qs = new URLSearchParams({ q: params.query, type: "song" });
    for (const s of params.sources || []) qs.append("sources", s);
    const res = await fetch(`${url}?${qs.toString()}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`go-music-dl 搜索失败: HTTP ${res.status}`);
    const html = await res.text();
    return { songs: parseSongCards(html) };
  },

  async recommend(config) {
    const url = `${baseUrl(config)}/music/recommend`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`go-music-dl 获取推荐歌单失败: HTTP ${res.status}`);
    const html = await res.text();
    return { channels: parseRecommendPlaylists(html) };
  },

  async playlistSongs(config, source, id) {
    const root = baseUrl(config);
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
    return `${baseUrl(config)}/music/download?${qs.toString()}`;
  },

  // 由已存储的 /music/download 流地址构造 /music/download_lrc 歌词地址。
  // 保留 id/source/name/artist/album/extra,去掉流式专用参数,加 duration +
  // format=line 让 go-music-dl 返回行式 LRC(逐字/卡拉OK 歌词折叠成普通带时行)。
  lyricUrl(_config, song) {
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
  },
};
