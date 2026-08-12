// ============================================================================
//  MusicFlow-V2 官方外置插件：go-music-dl 全网聚合 (source + lyrics + cover)
// ----------------------------------------------------------------------------
//  三合一插件:源(搜索/推荐/歌单/流) + 歌词 + 封面,全部走同一台 go-music-dl 服务,
//  共用同一份 baseUrl 配置。
//
//  沙箱契约(QuickJS VM 内运行,拿不到 Node 能力):
//    - 纯 JS 脚本,无 import/require/export;把 { manifest, create(host) } 赋给
//      globalThis.__mfPlugin;
//    - 网络一律走 host.http(url, { timeout }) —— 自带超时,无需 AbortController;
//    - 可用 JSON / URL / URLSearchParams(沙箱已注入兼容层) / 标准 JS;
//    - host.config 每次调用前刷新为最新插件配置,调用时实时读取;
//    - 权限:只有 manifest.permissions 声明的能力(此处 net)可用。
// ============================================================================

globalThis.__mfPlugin = {
  manifest: {
    id: "go-music-dl",
    name: "go-music-dl 全网聚合",
    version: "1.2.2",
    type: "source",
    description:
      "三合一官方外置插件:通过局域网已部署的 go-music-dl 服务搜索全网音乐、获取推荐歌单、流式播放,并为在线歌曲提供 LRC 歌词与封面。源 / 歌词 / 封面共用同一份服务地址配置。运行于 QuickJS 沙箱。",
    capabilities: [
      "search",
      "recommend",
      "playlistSongs",
      "stream",
      "webRotation",
      "lyricProvider",
      "coverProvider",
    ],
    platforms: [
      "netease", "qq", "kugou", "kuwo", "migu", "qianqian",
      "soda", "fivesing", "jamendo", "joox", "bilibili", "apple",
    ],
    recommendPrefix: "gmdl://recommend/",
    platformLabels: {
      netease: "网易云", qq: "QQ 音乐", kugou: "酷狗", kuwo: "酷我",
      migu: "咪咕", qianqian: "千千", soda: "汽水", fivesing: "5sing",
      jamendo: "Jamendo", joox: "JOOX", bilibili: "Bilibili", apple: "Apple Music"
    },
    sourcePreference: ["netease", "kuwo", "kugou", "qq"],
    defaultEnabled: false,
    minAppVersion: "1.3.0", // 沙箱运行时自 v1.3.0 起
    permissions: ["net"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl: "https://gitee.com/ray5378/music-flow-plugins/raw/master/dist/go-music-dl.tar.gz",
    configSchema: [
      { key: "baseUrl", label: "服务地址", type: "url", required: true, help: "填写你在局域网部署的 go-music-dl 网页服务地址(源 / 歌词 / 封面共用)" },
      { key: "sources", label: "搜索平台", type: "multiselect", options: [
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
      ] },
      { key: "webSongsMode", label: "web 歌曲", type: "radio", options: [
        { label: "永不过期", value: "keep" },
        { label: "定期清理", value: "rotate" },
      ] },
      { key: "webSongsRetentionDays", label: "保留天数", type: "number", help: "超过该天数且不再被任何歌单/收藏引用的在线歌曲会被自动清理(含封面);仍在歌单或收藏中的不受影响。保留 0 天 = 下架即清。" },
    ],
  },

  create(host) {
    /** source 路径收到 config;lyric/cover 路径收到 host(其 config 已刷新)。 */
    function baseOf(input) {
      const cfg = input && input.config ? input.config : input;
      return String((cfg && cfg.baseUrl) || "").replace(/\/+$/, "");
    }
    /** host.http 的文本 GET。失败抛错,调用方决定是否兜底。 */
    async function httpText(url, timeoutMs) {
      const r = await host.http(url, { method: "GET", timeout: timeoutMs });
      if (!r.ok) throw new Error("HTTP " + r.status + ": " + url);
      return r.body;
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
      let m;
      const re = /"([^"]+)"\s*:\s*"([^"]*)"/g;
      while ((m = re.exec(cleaned)) !== null) generic[m[1]] = m[2];
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
      if (!song.url || !String(song.url).includes("/music/download")) return null;
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

    return {
      async test(config) {
        const url = baseOf(config);
        if (!url) return { success: false, message: "未配置 go-music-dl 地址" };
        try {
          const html = await httpText(url + "/music/?type=song&sources=netease", 8000);
          if (!html.includes("music-dl") && !html.includes("聚合搜索")) {
            return { success: false, message: "响应不是 go-music-dl 页面(地址可能指向了其他服务)" };
          }
          return { success: true, message: "连接成功" };
        } catch (e) {
          return { success: false, message: String((e && e.message) || e) };
        }
      },

      async search(config, params) {
        const qs = new URLSearchParams({ q: params.query, type: "song" });
        for (const s of params.sources || []) qs.append("sources", s);
        const html = await httpText(baseOf(config) + "/music/search?" + qs.toString(), 15000);
        return { songs: parseSongCards(html) };
      },

      async recommend(config) {
        const html = await httpText(baseOf(config) + "/music/recommend", 20000);
        return { channels: parseRecommendPlaylists(html) };
      },

      async playlistSongs(config, source, id) {
        const root = baseOf(config);
        const totalRe = /data-total-count="(\d+)"/;
        let page = 1;
        let total = 0;
        const all = [];
        do {
          const qs = new URLSearchParams({ source, id, page: String(page), page_size: "500" });
          const html = await httpText(root + "/music/playlist?" + qs.toString(), 30000);
          if (page === 1) {
            const m = totalRe.exec(html);
            if (m) total = parseInt(m[1], 10) || 0;
          }
          all.push(...parseSongCards(html));
          page++;
        } while (total > 0 && all.length < total && page <= 50);
        return { songs: all, name: "" };
      },

      // 同步方法:纯字符串构造,不发起网络。
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
        return baseOf(config) + "/music/download?" + qs.toString();
      },

      // ---- lyricProvider ----
      async searchLyrics(song) {
        const base = baseOf(host);
        if (!base) return null;
        // 拉取并校验 LRC:404/"Lyric not found" 或纯音乐/无歌词占位均视为无词。
        const tryFetch = async (u) => {
          const text = await httpText(u, 8000);
          if (!text || text.startsWith("Lyric not found")) return null;
          if (/纯音乐|无歌词|暂无歌词/.test(text)) return null;
          return text;
        };
        // 1) 原曲精确 id:由 song.url 反推 download_lrc。
        const lrcUrl = lrcUrlFromSong(song);
        if (lrcUrl) {
          try { const t = await tryFetch(lrcUrl); if (t) return { lrc: t }; } catch { /* 走回退 */ }
        }
        // 2) 回退:按 歌名+歌手 搜索,歌名精确匹配的候选逐首试词。
        //    go-music-dl 搜索结果里常有"云版本"id 无词,而正式版/官方版 id 有词;
        //    歌手名常带乱码合作者(如 "周杰伦.、Asasblue"),取第一段清洗后搜索,
        //    仍找不到再退 title-only。
        if (!song.title) return null;
        const norm = (s) => String(s || "").toLowerCase()
          .replace(/[（(].*?[)）]/g, "").replace(/[\s·\-:_~&,，.。!！?？]+/g, "").trim();
        const want = norm(song.title);
        const cleanArtist = String(song.artist || "").split(/[、。，,&/()（）\s-]+/)[0] || song.artist || "";
        const queries = [];
        queries.push((cleanArtist ? cleanArtist + " " : "") + song.title);
        if (cleanArtist !== (song.artist || "")) queries.push((song.artist ? song.artist + " " : "") + song.title);
        if (!queries.includes(song.title)) queries.push(song.title);
        const groups = song.source
          ? [[song.source], ["netease", "qq", "kugou", "kuwo"]]
          : [["netease", "qq", "kugou", "kuwo"]];
        for (const srcs of groups) {
          for (const query of queries) {
            try {
              const html = await httpText(base + "/music/search?" + new URLSearchParams({ q: query, type: "song", sources: srcs.join(",") }).toString(), 15000);
              const sameSource = [];
              const otherSource = [];
              for (const c of parseSongCards(html)) {
                if (norm(c.name) !== want) continue;
                const entry = { id: c.id, source: c.source, name: c.name || "Unknown", artist: c.artist || "Unknown" };
                (srcs.length === 1 && c.source === song.source ? sameSource : otherSource).push(entry);
              }
              const cands = srcs.length > 1 ? sameSource.concat(otherSource) : sameSource;
              for (const cand of cands.slice(0, 5)) {
                try {
                  const t = await tryFetch(base + "/music/download_lrc?" + new URLSearchParams({ ...cand, format: "line" }).toString());
                  if (t) return { lrc: t };
                } catch { /* 试下一首 */ }
              }
            } catch { /* 该查询失败,试下一个 */ }
          }
        }
        return null;
      },

      // ---- coverProvider ----
      async searchCover(song) {
        const base = baseOf(host);
        if (!base) return null;
        if (song.url && String(song.url).includes("/music/download")) {
          try {
            const c = new URL(song.url).searchParams.get("cover");
            if (c) return { url: c };
          } catch {
            /* fall through */
          }
        }
        if (!song.title) return null;
        const q = (song.artist ? song.artist + " " : "") + song.title;
        const qs = new URLSearchParams({ q, type: "song", sources: "netease,qq,kugou,kuwo" });
        try {
          const html = await httpText(base + "/music/search?" + qs.toString(), 15000);
          for (const card of parseSongCards(html)) {
            if (card.cover) return { url: card.cover };
          }
        } catch {
          /* ignore — 另一 provider 可能提供封面 */
        }
        return null;
      },
    };
  },
};
