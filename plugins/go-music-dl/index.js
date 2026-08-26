// ============================================================================
//  MusicFlow 官方外置插件：go-music-dl 全网聚合 (source + lyrics + cover)
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

globalThis.__mfPlugin = { manifest: {
    id: "go-music-dl",
    name: "go-music-dl 全网聚合",
    version: "1.2.42",
    type: "source",
    description:
      "三合一官方外置插件:通过局域网已部署的 go-music-dl 服务搜索全网音乐、获取推荐歌单、流式播放,并为在线歌曲提供 LRC 歌词与封面。搜索自动限制平台数(调用方指定 → 配置 sources → 国内快速默认,国内优先 ≤5 平台),避免全平台搜索(含外网)超时。配置后台用户名/密码后,插件会每日自动登录,并把各平台「我的私人歌单」(网易云 / QQ / 酷狗 / 汽水)作为**持久歌单**同步到本地(不轮转、不被清理;经 manifest.longRunning 声明长耗时预算,单次任务即可全量同步(窗口并行拉取提速;配合主项目 v1.7.47 软看门狗批量任务无墙钟,无限歌单/封面/歌词一次跑完;歌单带**平台标签**,前端显示对应平台徽标)。支持关键词搜索自动入库:配置关键词后每日自动搜索所有平台匹配歌单并入库(已入库自动跳过)。源 / 歌词 / 封面共用同一份服务地址配置。运行于 QuickJS 沙箱。",
    capabilities: [
      "search",
      "playlistSearch",
      "songSearch",
      "albumSearch",
      "recommend",
      "playlistSongs",
      "stream",
      "webRotation",
      "lyricProvider",
      "coverProvider",
      "recommendPlaylist",
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
    minAppVersion: "1.7.39", // longRunning 方法级长耗时预算需 1.7.39 沙箱
    // 方法级长耗时预算(毫秒):拉平台歌单/外网操作极慢,声明后沙箱按此预算而非默认 15s。
    // runDailyJob:全量同步私人歌单(上限 10 分钟,配合窗口并行拉取);playlistSongs:浏览远程歌单(60s);
    // searchPlaylists:歌单搜索按全部平台聚合(go-music-dl 后端自身多源并发,通常 2~5s,给 30s 兜底);
    // searchAlbums:专辑搜索同样按全部平台聚合(30s);searchSongs:歌曲搜索受 pickSearchSources ≤5 截断,15s。
    // recommend:首页「平台精选」实时拉取 + 酷狗预热重试,默认定 15s 不够,给 60s 兜底。
    longRunning: { runDailyJob: 600000, playlistSongs: 60000, searchPlaylists: 30000, searchAlbums: 30000, searchSongs: 15000, recommend: 60000 },
    permissions: ["net", "storage", "songs:read", "songs:write", "playlists:read", "playlists:write"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl: "https://github.com/ray5378/MusicFlow-plugins/releases/download/go-music-dl-v1.2.41/go-music-dl.tar.gz",
    configSchema: [
      { key: "baseUrl", label: "服务地址", group: "backend", type: "url", required: true, help: "填写你在局域网部署的 go-music-dl 网页服务地址(源 / 歌词 / 封面共用)" },
      { key: "username", label: "登录用户名", group: "backend", type: "text", help: "go-music-dl 网页后台登录用户名。留空则不登录,仅拉公开推荐歌单;填写后插件会登录并同步各平台「我的歌单」" },
      { key: "password", label: "登录密码", group: "backend", type: "password", help: "go-music-dl 网页后台登录密码(经系统代理/直连发送,仅存于插件配置,不对外暴露)" },
      { key: "importMyPlaylists", label: "同步我的私人歌单", group: "backend", type: "switch", default: true, help: "开启后,插件每日自动登录并分批滚动同步各平台「我的歌单」(网易云 / QQ / 酷狗 / 汽水)为**持久本地歌单**:不轮转、不被清理;每次同步一个批次(沙箱 15s 配额内),进度持久化、跨日推进直至全部覆盖,歌单内歌曲自动刷新为可播条目(本地缺失的交由后台自动补全);关闭则只同步公开推荐" },
      { key: "sources", label: "搜索平台", group: "backend", type: "multiselect", help: "搜索/匹配时使用的平台(未配置则默认国内 4 平台)。每次搜索自动按国内优先重排并最多取 5 个——避免全平台搜索(含 bilibili/JOOX/Apple 等外网)单次超时。", options: [
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
      { key: "webSongsMode", label: "web 歌曲", group: "backend", type: "radio", options: [
        { label: "永不过期", value: "keep" },
        { label: "定期清理", value: "rotate" },
      ] },
      { key: "webSongsRetentionDays", label: "保留天数", group: "backend", type: "number", help: "超过该天数且不再被任何歌单/收藏引用的在线歌曲会被自动清理(含封面);仍在歌单或收藏中的不受影响。保留 0 天 = 下架即清。" },
      { key: "recommendPlatforms", label: "首页推荐平台", group: "recommend", type: "multiselect", help: "选择在首页「平台精选」中显示哪些平台的歌单,未选中的平台不会出现在首页。默认全选。", options: [
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
      { key: "homeCount", label: "平台首页歌单数", group: "recommend", type: "number", help: "首页「平台精选」每个平台展示的歌单数量(1~50,默认 6)。所有平台取同一个值。" },
      { key: "keywords", label: "搜索关键词", group: "keyword", type: "text", default: "抖音\n热门\n民谣\n经典", help: "每行一个关键词,插件每天自动搜索所有平台匹配的歌单并入库,已入库的自动跳过,不会重复导入" },
      { key: "keywordSearchPlatforms", label: "关键词搜索选择平台", group: "keyword", type: "multiselect", help: "选择「搜索关键词」功能搜索哪些平台的歌单,未选中的平台不会被搜索。默认空(搜索全部平台)。", options: [
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
      { key: "minSongs", label: "歌单最少歌曲数", group: "keyword", type: "number", default: 30, help: "歌单歌曲数量大于此值才保留入库,避免导入空歌单" },
      { key: "filterPlatforms", label: "歌单筛选平台", group: "frontend", type: "multiselect", help: "选择在歌单页「筛选歌单」下拉中显示哪些平台,未选中的平台不会出现在筛选列表。默认全选。", options: [
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
    ],
  },

  create(host) {
    // manifest 是 __mfPlugin 对象的属性,不是 create 内的自由变量——在此解构为
    // 闭包内可用(沙箱 globalThis 挂载了 __mfPlugin),否则方法内引用会 ReferenceError。
    const manifest = (globalThis && globalThis.__mfPlugin && globalThis.__mfPlugin.manifest) || {};
    /** source 路径收到 config;lyric/cover 路径收到 host(其 config 已刷新)。 */
    function baseOf(input) {
      const cfg = input && input.config ? input.config : input;
      return String((cfg && cfg.baseUrl) || "").replace(/\/+$/, "");
    }
    /** host.http 的文本 GET。失败抛错,调用方决定是否兜底。 */
    async function httpText(url, timeoutMs) {
      const r = await host.http(url, { method: "GET", timeout: timeoutMs });
      if (!r.ok) {
        // 携带真实失败原因(r.error),避免盲报 "HTTP undefined" 无从排查。
        // 典型:net 权限未授予 → r.error.message="PERMISSION_DENIED: net";
        //       服务不可达 → r.error.message="fetch failed"/"ECONNREFUSED" 等。
        const detail = r.error ? " (" + (r.error.message || r.error) + ")" : "";
        throw new Error("HTTP " + (r.status == null ? "?" : r.status) + ": " + url + detail);
      }
      return r.body;
    }

    /** 有界缓存通用包装器:达到上限后自动清空,防止内存无限增长。
     *  适用场景:matchLocal 的搜索结果缓存、跨歌单/跨关键词共享的临时数据。 */
    function boundedCache(maxSize) {
      var map = new Map();
      return {
        get: function(k) { return map.get(k); },
        has: function(k) { return map.has(k); },
        set: function(k, v) {
          if (map.size >= maxSize) { map.clear(); }
          map.set(k, v);
        },
        clear: function() { map.clear(); },
        get size() { return map.size; },
      };
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

    /** 解码 go-music-dl 服务端在 HTML 里嵌入的 JS 字符串转义(如 \u002b → +)。
     *  必须在 URLSearchParams 拆分之后再对字段值做 — \u0026 在路径里是参数分隔符,
     *  而在字段值里 \u002b 若提前解成 + 会被 URLSearchParams 当空格吞掉。 */
    function decodeUnicode(v) {
      return String(v).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
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
          name: decodeUnicode(decodeAttr(attr("name"))),
          artist: decodeUnicode(decodeAttr(attr("artist"))),
          album: decodeUnicode(decodeAttr(attr("album"))),
          duration: parseInt(attr("duration"), 10) || 0,
          cover: decodeUnicode(decodeAttr(attr("cover"))),
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
          name: decodeUnicode(nameM ? decodeAttr(nameM[1]) : source),
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
          name: decodeUnicode(params.get("name") || ""),
          creator: decodeUnicode(params.get("creator") || ""),
          cover: decodeUnicode(params.get("cover") || ""),
          trackCount: decodeUnicode(params.get("track_count") || ""),
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

    /** 解析「我的歌单」页面:优先按每张卡片「导入本地」按钮的 data-* 属性提取,
     *  兜底再扫 navigateTo('/music/playlist?...') 链接。两种都产出自同形状对象,
     *  按 id 去重。只取平台歌单,跳过 local 自制。 */
    function parseUserPlaylists(html) {
      const out = [];
      const seen = new Set();
      const push = (p) => {
        if (!p.id || !p.source || p.source === "local" || seen.has(p.id)) return;
        seen.add(p.id);
        out.push(p);
      };
      // 模式 1:「导入本地」按钮携带 data-* 属性
      const btnRe = /<button\b[^>]*\bonclick="[^"]*importCollectionFromButton\(this\)"[^>]*>/g;
      let m;
      while ((m = btnRe.exec(html)) !== null) {
        const block = m[0];
        const attr = (name) => {
          const a = new RegExp(`\\bdata-${name}="([^"]*)"`, "i").exec(block);
          return a ? decodeUnicode(decodeAttr(a[1])) : "";
        };
        push({
          id: attr("external-id"),
          source: attr("source"),
          name: attr("name"),
          creator: attr("creator"),
          trackCount: attr("track-count"),
          link: attr("link"),
        });
      }
      // 模式 2:navigateTo('/music/playlist?source=..&id=..') 链接(兜底)
      const navRe = /navigateTo\(\s*['"]([^'"]*\/music\/playlist[^'"]*)['"]\s*\)/g;
      while ((m = navRe.exec(html)) !== null) {
        let path = decodeAttr(m[1]).replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
        const params = new URLSearchParams(path.split("?")[1] || "");
        push({
          id: params.get("id") || "",
          source: params.get("source") || "",
          name: decodeUnicode(params.get("name") || ""),
          creator: decodeUnicode(params.get("creator") || ""),
          trackCount: decodeUnicode(params.get("track_count") || ""),
          link: params.get("link") || "",
        });
      }
      return out;
    }

    /** 解析 /music/search?type=playlist 的歌单结果卡片。卡片形状与推荐/我的歌单页
     *  一致(navigateTo('/music/playlist?...') 链接或「导入本地」data-* 按钮),
     *  按 id+source 去重,只取平台歌单。 */
    function parseSearchPlaylists(html) {
      const out = [];
      const seen = new Set();
      const push = (p) => {
        if (!p.id || !p.source || p.source === "local" || seen.has(p.source + ":" + p.id)) return;
        seen.add(p.source + ":" + p.id);
        out.push(p);
      };
      // 模式 1:playlist-card + navigateTo('/music/playlist?source=..&id=..&name=..')
      const cardRe = /<div\s+class="playlist-card"[^>]*onclick="navigateTo\(\s*['"](.*?)['"]\s*\)"/g;
      let cm;
      while ((cm = cardRe.exec(html)) !== null) {
        let path = decodeAttr(cm[1]).replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
        if (!path.startsWith("/music/playlist")) continue;
        const p = new URLSearchParams(path.split("?")[1] || "");
        const source = p.get("source") || "";
        const id = p.get("id") || "";
        if (!source || !id) continue;
        push({
          id,
          source,
          name: decodeUnicode(p.get("name") || ""),
          creator: decodeUnicode(p.get("creator") || ""),
          cover: decodeUnicode(p.get("cover") || ""),
          trackCount: decodeUnicode(p.get("track_count") || p.get("trackCount") || ""),
          link: p.get("link") || "",
        });
      }
      // 模式 2:「导入本地」按钮 data-* 属性(同「我的歌单」页)
      const btnRe = /<button\b[^>]*\bonclick="[^"]*importCollectionFromButton\(this\)"[^>]*>/g;
      let bm;
      while ((bm = btnRe.exec(html)) !== null) {
        const block = bm[0];
        const attr = (name) => {
          const a = new RegExp(`\\bdata-${name}="([^"]*)"`, "i").exec(block);
          return a ? decodeUnicode(decodeAttr(a[1])) : "";
        };
        push({
          id: attr("external-id"),
          source: attr("source"),
          name: attr("name"),
          creator: attr("creator"),
          trackCount: attr("track-count"),
          link: attr("link"),
        });
      }
      return out;
    }

    /** 解析 /music/search?type=album 的专辑结果卡片。与歌单卡片同构
     *  (navigateTo('/music/album?...') 链接),按 id+source 去重,只取平台专辑。
     *  字段: id/source/name/artist/cover/track_count/link。 */
    function parseSearchAlbums(html) {
      const out = [];
      const seen = new Set();
      const push = (a) => {
        if (!a.id || !a.source || a.source === "local" || seen.has(a.source + ":" + a.id)) return;
        seen.add(a.source + ":" + a.id);
        out.push(a);
      };
      // 模式 1:album-card 块内 data-* 属性(与 song-card 同款结构,li 或 div 都兼容)。
      // 专辑卡片与歌曲卡片同渲染函数,真实前端可能是 <li class="album-card" data-*="...">,
      // 旧实现只匹配 <div class="album-card"> 会解析 0 结果。
      const blockRe = /<(li|div)\s+class="album-card"([\s\S]*?)<\/\1>/g;
      let bm;
      while ((bm = blockRe.exec(html)) !== null) {
        const block = bm[2];
        const attr = (name) => {
          const re = new RegExp(`data-${name}=(["'])(.*?)\\1`, "i");
          const a = re.exec(block);
          return a ? decodeUnicode(decodeAttr(a[2])) : "";
        };
        const id = attr("id");
        if (!id) continue;
        push({
          id,
          source: attr("source"),
          name: attr("name"),
          artist: attr("artist") || attr("creator"),
          cover: attr("cover"),
          trackCount: attr("track-count") || attr("trackCount"),
          link: attr("link"),
        });
      }
      // 模式 2(兜底):卡片 navigateTo('/music/album?...')(无 data-* 的旧结构)。
      // go-music-dl 前端把专辑搜索结果渲染成 playlist-card 卡片类(onclick 指向
      // /music/album…),故 album-card 与 playlist-card 都匹配,避免解析出 0 结果。
      if (out.length === 0) {
        const cardRe = /<(li|div)\s+class="(?:album-card|playlist-card)"[^>]*onclick="navigateTo\(\s*['"](.*?)['"]\s*\)"/g;
        let cm;
        while ((cm = cardRe.exec(html)) !== null) {
          let path = decodeAttr(cm[2]).replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
          if (!path.startsWith("/music/album")) continue;
          const p = new URLSearchParams(path.split("?")[1] || "");
          const source = p.get("source") || "";
          const id = p.get("id") || "";
          if (!source || !id) continue;
          push({
            id,
            source,
            name: decodeUnicode(p.get("name") || ""),
            artist: decodeUnicode(p.get("artist") || p.get("creator") || ""),
            cover: decodeUnicode(p.get("cover") || ""),
            trackCount: decodeUnicode(p.get("track_count") || p.get("trackCount") || ""),
            link: p.get("link") || "",
          });
        }
      }
      return out;
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

    // ===== 私人歌单同步(路径 B:持久歌单,不轮转,每日自动拉取+刷新) =====
    // 这些辅助函数同时被 recommend()/runDailyJob() 复用,故提升到 create() 作用域。
    const PRIVATE_SOURCES = ["netease", "qq", "kugou", "soda"]; // go-music-dl 支持私人歌单的平台
    const PRIVATE_LABELS = { netease: "网易云", qq: "QQ 音乐", kugou: "酷狗", soda: "汽水" };
    const labelOf = (src) => PRIVATE_LABELS[src] || src;
    // 沙箱单次调用 15s 硬配额 → 分批滚动同步:每次只处理一个批次,进度持久化到
    // host.storage(gmdlMineCursor),跨日推进直至全部歌单覆盖;歌单本身不轮转、不被清理。
    // v1.2.9+ 主项目支持 manifest.longRunning 方法级预算;v1.7.47 起主项目批量任务
    // 改「软看门狗」:无墙钟硬超时(等网络/DB 无限合法,只杀 CPU 空转)→ 插件侧移除
    // SYNC_WINDOW_MS / MAX_PLAYLISTS_PER_RUN 预算闸,一次任务跑完全部歌单(无限歌单/
    // 封面/歌词)。游标仍保留:意外中断(网络断/进程重启)时可续传,不丢进度。
    const MAX_SONGS_PER_PLAYLIST = 5000; // 单歌单最多拉取歌曲(10 页×500,防超大歌单独占内存)
    const PREFETCH_CONCURRENCY = 3;      // 窗口并行拉取歌单歌曲的并发数(配合主项目 batchPacer 节流,3 路已足够,降低 CPU/网络峰值)
    const BATCH_GATE_MS = 20 * 3600e3;   // 非 force:距上次批次 <20h 跳过(启动补跑+每日调度同日不双跑)
    const LOCAL_POOL_LIMIT = 5000;       // 本地曲库池上限(10 页×500),池内 O(1) 匹配免逐曲搜索往返
    /** 归一化:小写 + 去非字母数字/汉字(用于标题/艺人匹配键)。 */
    const norm = (s) => String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, "");
    // search 平台选择:①调用方指定 → ②插件配置 sources → ③快速默认(国内 4 平台)。
    // 关键:绝不「无 sources → go-music-dl 全平台搜索」——含 bilibili/joox/apple 等
    // 外网平台,单次搜索 10s+,直接打爆沙箱 15s(交互搜索与后台 auto-match 双双超时,
    // 日志见「调用 search() 执行超时(> 15000ms)」「host.http 失败 ... aborted due to timeout」)。
    // 按国内优先顺序重排并截断至 ≤5,兼顾召回与速度。
    const SEARCH_PREFERENCE = ["netease", "kuwo", "kugou", "qq"];
    const FAST_DEFAULT_SOURCES = ["netease", "kugou", "qq", "kuwo"];
    const MAX_SEARCH_SOURCES = 5;
    function pickSearchSources(config, params) {
      const fromParams = (params && Array.isArray(params.sources) ? params.sources : []).filter((s) => typeof s === "string" && s);
      const fromCfg = Array.isArray(config && config.sources) ? config.sources.filter((s) => typeof s === "string" && s) : [];
      const list = fromParams.length ? fromParams : fromCfg.length ? fromCfg : FAST_DEFAULT_SOURCES;
      const score = (s) => { const i = SEARCH_PREFERENCE.indexOf(s); return i >= 0 ? i : SEARCH_PREFERENCE.length; };
      return [...new Set(list)].sort((a, b) => score(a) - score(b)).slice(0, MAX_SEARCH_SOURCES);
    }
    const extractSessionCookie = (raw) => {
      if (!raw) return null;
      for (const part of String(raw).split(";")) {
        const i = part.indexOf("music_dl_session=");
        if (i >= 0) return part.slice(i + "music_dl_session=".length).trim();
      }
      return null;
    };
    const getSetCookie = (r) => {
      if (!r || !r.headers) return null;
      if (typeof r.headers.get === "function") {
        const v = r.headers.get("set-cookie");
        if (v) return v;
      }
      return r.headers["set-cookie"] || r.headers["Set-Cookie"] || null;
    };
    const ensureLogin = async (cfg) => {
      const user = String((cfg && cfg.username) || "").trim();
      const pass = String((cfg && cfg.password) || "").trim();
      if (!user || !pass) return null; // 未配置 → 不登录
      try {
        const cached = await host.storage.get("gmdlSession");
        if (cached && cached.cookie && Date.now() - (cached.ts || 0) < 6 * 864e5) return cached.cookie;
      } catch { /* 忽略缓存读取错误 */ }
      const base = baseOf(cfg);
      try {
        // go-music-dl 登录为表单提交,成功后经 Set-Cookie 下发 music_dl_session;
        // 返回 302 跳转,故用 redirect:"manual" 直接拿到带 Cookie 的响应。
        const r = await host.http(base + "/music/login", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "username=" + encodeURIComponent(user) + "&password=" + encodeURIComponent(pass),
          redirect: "manual",
          timeout: 10000,
        });
        const cookie = extractSessionCookie(getSetCookie(r));
        if (cookie) {
          try { await host.storage.set("gmdlSession", { cookie, ts: Date.now() }); } catch { /* 忽略 */ }
          return cookie;
        }
        host.log("go-music-dl 登录未返回会话 Cookie(凭据错误或后端未启用登录)");
      } catch (e) {
        host.log("go-music-dl 登录失败: " + (e && e.message ? e.message : e));
      }
      return null;
    };
    const fetchUserPlaylists = async (cfg, source, cookie) => {
      const base = baseOf(cfg);
      const url = base + "/music/user_playlists?sources=" + encodeURIComponent(source);
      const doFetch = (ck) => {
        const h = {};
        if (ck) h["Cookie"] = "music_dl_session=" + ck;
        return host.http(url, { method: "GET", headers: h, timeout: 10000 });
      };
      // 后端无 auth 时 user_playlists 直接返回歌单;有 auth 时未带有效 Cookie 会 302 到登录页。
      const isLoginPage = (b) => /登录 music-dl|初始化管理员账号/.test(b || "");
      let r = await doFetch(cookie);
      if (r.ok && isLoginPage(r.body)) {
        // 会话失效(缓存 Cookie 过期)→ 清缓存重新登录一次再试
        try { await host.storage.delete("gmdlSession"); } catch { /* 忽略 */ }
        const fresh = await ensureLogin(cfg);
        if (fresh) r = await doFetch(fresh);
      }
      if (!r.ok || isLoginPage(r.body)) return [];
      return parseUserPlaylists(r.body || "");
    };
    const fetchPlaylistSongs = async (config, source, id) => {
      const root = baseOf(config);
      const totalRe = /data-total-count="(\d+)"/;
      // 分页拉取指定详情页(歌单 / 专辑页面同构:song-card + data-total-count)。
      const fetchPages = async (endpoint) => {
        let page = 1, total = 0;
        const all = [];
        do {
          const qs = new URLSearchParams({ source, id, page: String(page), page_size: "500" });
          const html = await httpText(root + endpoint + "?" + qs.toString(), 30000);
          if (page === 1) {
            const m = totalRe.exec(html);
            if (m) total = parseInt(m[1], 10) || 0;
          }
          all.push(...parseSongCards(html));
          page++;
        } while (total > 0 && all.length < total && all.length < MAX_SONGS_PER_PLAYLIST && page <= 50);
        return all;
      };
      // 歌单搜索「加入库」走 /music/playlist;专辑搜索「加入库」经同一 playlistSongs 契约
      // 调用,但专辑 id 在 /music/playlist 下无歌曲 → 回退 /music/album 再拉一遍。
      let songs = await fetchPages("/music/playlist");
      if (!songs.length) songs = await fetchPages("/music/album");
      return songs;
    };
    /** 一次性拉本地曲库子集(≤ LOCAL_POOL_LIMIT 首,分页 500/页),按归一化标题建索引,
     *  池内 O(1) 匹配免去逐曲 host.songs.search 往返(单批几千首时是主要耗时)。 */
    async function loadLocalPool() {
      const pool = new Map(); // normTitle -> [{ id, artist(norm) }]
      try {
        for (let off = 0; off < LOCAL_POOL_LIMIT; off += 500) {
          const page = await host.songs.list({ limit: 500, offset: off });
          if (!Array.isArray(page) || !page.length) break;
          for (const s of page) {
            const t = norm(s.title);
            if (!t) continue;
            const arr = pool.get(t);
            if (arr) arr.push({ id: s.id, artist: norm(s.artist) });
            else pool.set(t, [{ id: s.id, artist: norm(s.artist) }]);
          }
          if (page.length < 500) break;
        }
        return pool.size ? pool : null;
      } catch {
        return null; // 拉池失败 → 退回逐曲搜索
      }
    }
    /** 池内匹配:标题精确 + 艺人包含;命中返回 songId,否则 null。 */
    function matchInPool(pool, title, artist) {
      if (!pool) return null;
      const t = norm(title);
      if (!t) return null;
      const cands = pool.get(t);
      if (!cands || !cands.length) return null;
      const a = norm(artist);
      if (!a) return cands[0].id;
      for (const cnd of cands) {
        if (cnd.artist && (cnd.artist.includes(a) || a.includes(cnd.artist))) return cnd.id;
      }
      // 歌名撞车但有歌手期望:歌手不符即视为「同名异曲」,不得绑定本地曲库
      // (回退 matchLocal / 外部占位,由后台 auto-match 严格匹配)。
      return null;
    }
    /** 本地曲库模糊匹配(与 ListenBrainz 插件同款打分),命中返回 songId。
     *  cache 为调用内 Map(title|artist → id|null),去重跨歌单重复曲目。 */
    async function matchLocal(title, artist, cache) {
      const key = String(title || "") + "|" + String(artist || "");
      if (cache.has(key)) return cache.get(key);
      const tNorm = norm(title);
      if (!tNorm) { cache.set(key, null); return null; }
      const tryQuery = async (q) => {
        try { return (await host.songs.search(q, { limit: 10 })) || []; } catch { return []; }
      };
      let hits = await tryQuery([title, artist].filter(Boolean).join(" "));
      if (!hits.length) hits = await tryQuery(title);
      let best = null, bestScore = -1;
      for (const h of hits) {
        const hTitle = norm(h.title);
        const aNorm = norm(artist);
        const hArtist = norm(h.artist);
        // 收紧:同歌名很常见,歌手不符的候选直接排除(避免 bind 到同名异曲)。
        const artistOk = !aNorm || !!(hArtist && (hArtist.includes(aNorm) || aNorm.includes(hArtist)));
        if (!artistOk) continue;
        let score = 0;
        if (hTitle === tNorm) score += 100;
        else if (hTitle.includes(tNorm) || tNorm.includes(hTitle)) score += 60;
        if (artist) {
          if (aNorm && (hArtist.includes(aNorm) || aNorm.includes(hArtist))) score += 40;
        }
        if (score > bestScore) { bestScore = score; best = h; }
      }
      const id = best && bestScore >= 60 ? best.id : null;
      cache.set(key, id);
      return id;
    }
    /** 每日私人歌单自动同步(路径 B,分批滚动):登录 → 按游标推进一批歌单 upsert。
     *  进度存 host.storage(gmdlMineCursor) {srcIdx, plIdx, ts, done};单批在
     *  SYNC_WINDOW_MS 预算 / MAX_PLAYLISTS_PER_RUN 上限内,超了就存档收尾,下次继续。
     *  未命中本地的歌以外部占位写入,由后端 upsert 后自动触发的后台 auto-match
     *  (主进程、不受沙箱 15s 限制)继续本地/在线补全为可播条目。返回摘要串或 null。 */
    async function syncMyPlaylists(opts, pool, matchCache) {
      const c = host.config || {};
      if (c.importMyPlaylists === false) return null;
      const user = String(c.username || "").trim();
      const pass = String(c.password || "").trim();
      if (!user || !pass) { host.log("未配置用户名/密码,跳过私人歌单同步"); return null; }
      const force = !!(opts && opts.force);
      let cursor = null;
      try { cursor = await host.storage.get("gmdlMineCursor"); } catch { /* 忽略 */ }
      // 每日闸门(force 绕过):启动补跑+每日调度可能同日多次触发,避免重复推进同一批。
      if (!force && cursor && cursor.ts && Date.now() - cursor.ts < BATCH_GATE_MS) return null;
      const cookie = await ensureLogin(c);
      if (!cookie) { host.log("登录失败,本次跳过私人歌单同步"); return null; }
      const srcs = ((c.sources && c.sources.length) ? c.sources : PRIVATE_SOURCES).filter((s) => PRIVATE_SOURCES.includes(s));
      if (!srcs.length) return null;
      const t0 = Date.now();
      let srcIdx = (cursor && !cursor.done ? Number(cursor.srcIdx) || 0 : 0);
      let plIdx = (cursor && !cursor.done ? Number(cursor.plIdx) || 0 : 0);
      let processed = 0;
      let allDone = true;
      for (; srcIdx < srcs.length; srcIdx++) {
        const source = srcs[srcIdx];
        let pls = [];
        try { pls = await fetchUserPlaylists(c, source, cookie); }
        catch (e) { host.log("拉取我的歌单失败(" + source + "): " + (e && e.message ? e.message : e)); continue; }
        if (!pls.length) continue;
        // 窗口并行预取:歌单歌曲拉取互相独立,并发 PREFETCH_CONCURRENCY 个大幅提速
        // (串行 40+ 歌单 × 每单多页会轻易打爆调用配额——见「执行超时(> 240000ms)」事故)。
        // v1.7.47 起批量任务无墙钟(软看门狗只杀 CPU 空转)→ 不再按预算截断,
        // 一次跑完全部歌单(无限歌单/封面/歌词);游标仍逐歌单推进,意外中断可续传。
        while (plIdx < pls.length) {
          const window = pls.slice(plIdx, plIdx + PREFETCH_CONCURRENCY);
          const fetched = await Promise.all(window.map((pl) =>
            fetchPlaylistSongs(c, source, pl.id)
              .then((songs) => ({ pl, songs }))
              .catch((e) => ({ pl, error: (e && e.message) || e }))
          ));
          for (const f of fetched) {
            if (f.error) { host.log("拉取歌单歌曲失败 " + (f.pl.name || source) + ": " + f.error); plIdx++; continue; }
            try {
              const entries = [];
              var firstMatchId = null;
              for (const s of f.songs) {
                // 1) 本地曲库优先匹配(池内 O(1),池外回退搜索)→ 立即可播+封面正常
                const localId = matchInPool(pool, s.name, s.artist) || (await matchLocal(s.name, s.artist, matchCache));
                if (localId) { entries.push({ songId: localId }); if (!firstMatchId) firstMatchId = localId; continue; }
                // 2) 未命中:外部占位,由后台 auto-match 继续补全为可播(主进程不限时)
                entries.push({
                  externalSongId: source + ":" + s.id,
                  externalTitle: s.name,
                  externalArtist: s.artist,
                  externalAlbum: s.album,
                  externalDuration: (s.duration || 0) * 1000, // 秒 → 毫秒
                });
              }
              const pid = "pl-gmdl-mine-" + source + "-" + f.pl.id;
              await host.playlists.upsert(pid, {
                name: labelOf(source) + " · " + (f.pl.name || "我的歌单"),
                description: "go-music-dl 我的私人歌单(" + labelOf(source) + "),每日自动同步",
                entries,
                coverSongId: firstMatchId,
                // 平台标签:前端据此显示平台徽标(网易云/QQ/酷狗/汽水);sourceUrl 标识来源。
                sourcePlatform: source,
                sourceUrl: "gmdl://mine/" + source + "/" + f.pl.id,
              });
              processed++;
              // 每成功一个即推进并持久化游标:即便本次被沙箱强杀,进度也不丢
              try { await host.storage.set("gmdlMineCursor", { srcIdx, plIdx: plIdx + 1, done: false, ts: Date.now() }); } catch { /* 忽略 */ }
            } catch (e) { host.log("同步歌单失败 " + (f.pl.name || source) + ": " + (e && e.message ? e.message : e)); }
            plIdx++;
          }
        }
        if (!allDone) break;
        plIdx = 0; // 本平台处理完,进入下一平台
      }
      if (allDone) {
        try { await host.storage.set("gmdlMineCursor", { srcIdx: 0, plIdx: 0, done: true, ts: Date.now() }); } catch { /* 忽略 */ }
        host.log("私人歌单全部同步完成: " + processed + " 个");
        return "私人歌单全部同步完成: " + processed + " 个";
      }
      host.log("私人歌单批次同步完成: 本次 " + processed + " 个(进度 src=" + srcIdx + "/" + srcs.length + " pl=" + plIdx + "),继续推进中");
      return "批次完成: " + processed + " 个(继续推进中)";
    }

    // ===== playlistSearch:跨全部平台搜索歌单(结果可「加入库」) =====
    const searchPlaylistsImpl = async (config, params) => {
      const q = String((params && params.query) || "").trim();
      if (!q) return { playlists: [] };
      // 歌单搜索平台:调用方指定 → 插件声明的全部平台。不走歌曲搜索的
      // pickSearchSources(≤5 截断)——歌单搜索由 go-music-dl 后端自身多源并发聚合,
      // 一次请求即可带回全部平台结果;长耗时预算由 manifest.longRunning 声明兜底。
      let sources = Array.isArray(params && params.sources) && params.sources.length
        ? params.sources.filter((s) => typeof s === "string" && s)
        : (manifest.platforms || []);
      const qs = new URLSearchParams({ q, type: "playlist" });
      for (const s of sources) qs.append("sources", s);
      const html = await httpText(baseOf(config) + "/music/search?" + qs.toString(), 25000);
      return { playlists: parseSearchPlaylists(html) };
    };

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

      // ===== 健康自检(可选钩子,供 /v1/plugins/health 主动 ping) =====
      async health() {
        const base = baseOf(host.config || {});
        if (!base) return { status: "degraded", message: "未配置 go-music-dl 地址" };
        try {
          const html = await httpText(base + "/music/?type=song&sources=netease", 8000);
          if (!html.includes("music-dl") && !html.includes("聚合搜索")) {
            return { status: "down", message: "响应不是 go-music-dl 页面(地址可能指向了其他服务)" };
          }
          return { status: "ok", message: "服务可达" };
        } catch (e) {
          return { status: "down", message: String((e && e.message) || e) };
        }
      },

      async search(config, params) {
        const qs = new URLSearchParams({ q: params.query, type: "song" });
        for (const s of pickSearchSources(config, params)) qs.append("sources", s);
        const html = await httpText(baseOf(config) + "/music/search?" + qs.toString(), 12000);
        return { songs: parseSongCards(html) };
      },

      // ===== playlistSearch:跨全部平台搜索歌单(结果可「加入库」) =====
      async searchPlaylists(config, params) { return searchPlaylistsImpl(config, params); },

      // ===== songSearch:跨平台搜索单曲(结果可「加入库」为可播在线歌曲) =====
      // 与 search() 同源(/music/search?type=song),但按新契约暴露为独立能力,
      // 平台选择同样受 pickSearchSources(≤5) 截断防超时。
      async searchSongs(config, params) {
        const q = String((params && params.query) || "").trim();
        if (!q) return { songs: [] };
        const qs = new URLSearchParams({ q, type: "song" });
        for (const s of pickSearchSources(config, params)) qs.append("sources", s);
        const html = await httpText(baseOf(config) + "/music/search?" + qs.toString(), 15000);
        return { songs: parseSongCards(html) };
      },

      // ===== albumSearch:跨全部平台搜索专辑(结果可「加入库」为专辑歌单) =====
      // 专辑搜索与歌单搜索同策略:按全部平台聚合,go-music-dl 后端多源并发。
      async searchAlbums(config, params) {
        const q = String((params && params.query) || "").trim();
        if (!q) return { albums: [] };
        let sources = Array.isArray(params && params.sources) && params.sources.length
          ? params.sources.filter((s) => typeof s === "string" && s)
          : (manifest.platforms || []);
        const qs = new URLSearchParams({ q, type: "album" });
        for (const s of sources) qs.append("sources", s);
        const html = await httpText(baseOf(config) + "/music/search?" + qs.toString(), 30000);
        return { albums: parseSearchAlbums(html) };
      },

      async recommend(config) {
        // ================== 首页「平台精选」数据来源 ==================
        // 统一全平台走上游 go-music-dl /music/recommend(公开精选/榜单渠道)。
        // 说明:上游只有网易云每次返回个性化新歌单(自动刷新);QQ/酷狗/酷我等平台
        // 返回的是固定编辑精选/热门列表,这是上游真实数据,插件不做本地替换。
        // 首页的动态变化由前端「本地随机歌单」分区提供(见 Web / 客户端 / HA 卡片)。
        //
        // 快照兜底:按平台独立更新 + 12 分钟过期。过去「全部非空才写缓存」,
        // 一旦某平台某次空桶,旧快照被永久锁死;现在每平台带时间戳,空桶后
        // 新数据一到就覆盖,旧快照仅临时兜底且很快过期,打破「一空桶就显示旧」。
        const RECOMMEND_RETRIES = 2;         // 首抓 + 最多 2 次重试
        const RECOMMEND_TIMEOUT = 20000;     // 首抓 20s
        const RECOMMEND_RETRY_TIMEOUT = 15000; // 重试 15s(压住总墙钟,避开 60s 预算)
        const CACHE_KEY = "gmdlRecommendChannels";
        const SNAPSHOT_MAX_AGE_MS = 12 * 60 * 1000; // 快照兜底上限:12 分钟

        // 读取上次快照,按平台缓存带时间戳;兼容旧格式(无 ts 的纯数组)。
        let snapshot = [];
        try {
          const cached = await host.storage.get(CACHE_KEY);
          if (Array.isArray(cached)) snapshot = cached;
        } catch { /* 存储不可用则仅依赖本次实时结果 */ }
        const now = Date.now();
        const oldBySource = {};
        for (const c of snapshot) {
          if (!c || !c.source || !Array.isArray(c.playlists)) continue;
          const age = c.ts ? now - c.ts : Infinity; // 旧格式视为立即失效
          if (age <= SNAPSHOT_MAX_AGE_MS && c.playlists.length) oldBySource[c.source] = c.playlists;
        }

        // ---- 上游 /music/recommend 抓取(预热重试) ----
        // 防「酷狗精选栏消失」:go-music-dl 服务端对部分平台(典型是酷狗)的推荐
        // tab 常需「预热」几次才返回非空歌单,单次抓取常拿到空桶。这里做有界重试:
        // 全部分区非空即停;重试后仍空的分区用「上次成功」快照兜底。预算由
        // manifest.longRunning.recommend(60s)兜底。
        let channels = [];
        let upstreamError = null;
        try {
          for (let attempt = 0; attempt <= RECOMMEND_RETRIES; attempt++) {
            const html = await httpText(
              baseOf(config) + "/music/recommend",
              attempt === 0 ? RECOMMEND_TIMEOUT : RECOMMEND_RETRY_TIMEOUT
            );
            channels = parseRecommendPlaylists(html);
            // 全部分区都有歌单即视为预热完成;空数组(页面/网络异常)不再空转。
            if (channels.length > 0 && channels.every((c) => c.playlists.length > 0)) break;
          }
        } catch (e) {
          // 上游不可达:保留错误,走下方整份快照兜底,避免精选栏消失。
          upstreamError = e;
        }

        if (upstreamError) {
          // 网络失败 → 用未过期快照整份兜底;完全没有则返回空(后端会降级提示)。
          if (Object.keys(oldBySource).length > 0) {
            channels = Object.keys(oldBySource).map((src) => ({
              source: src,
              name: (manifest.platformLabels && manifest.platformLabels[src]) || src,
              count: oldBySource[src].length,
              playlists: oldBySource[src].slice(),
            }));
          } else {
            channels = [];
          }
        } else {
          // 兜底:仍有空分区 → 用「该平台」未过期快照补齐,避免精选栏消失。
          for (const ch of channels) {
            if (!ch.playlists.length && oldBySource[ch.source]) {
              ch.playlists = oldBySource[ch.source].slice();
              ch.count = ch.playlists.length;
            }
          }
          // 按平台独立更新快照 + 时间戳:只写本次有内容的平台;空桶不阻断其它平台更新。
          const fresh = channels
            .filter((ch) => (ch.playlists || []).length > 0)
            .map((ch) => ({
              source: ch.source,
              name: ch.name,
              count: ch.count,
              playlists: (ch.playlists || []).slice(),
              ts: now,
            }));
          if (fresh.length > 0) {
            try { await host.storage.set(CACHE_KEY, fresh); } catch { /* 忽略 */ }
          }
        }

        // 按 recommendPlatforms 配置过滤首页展示的平台。
        const recommendPlatforms = config.recommendPlatforms;
        if (Array.isArray(recommendPlatforms) && recommendPlatforms.length > 0) {
          channels = channels.filter((ch) => recommendPlatforms.includes(ch.source));
        }

        // 每平台歌单数由插件自身配置 homeCount 控制(默认 6,取值 1~50)。
        // 单一全局值 → 所有平台展示同样数量,首页「平台精选」数量随配置变化。
        const raw = parseInt(String((config && config.homeCount) != null ? config.homeCount : 6), 10);
        const homeCount = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 50) : 6;
        for (const ch of channels) {
          ch.playlists = ch.playlists.slice(0, homeCount);
          ch.count = ch.playlists.length;
        }
        return { channels };
      },

      async playlistSongs(config, source, id) {
        const songs = await fetchPlaylistSongs(config, source, id);
        return { songs, name: "" };
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

      // ===== 私人歌单每日同步(路径 B:持久不轮转,分批滚动) =====
      // 复用主项目既有「每日调度 + /v1/recommend/refresh?pluginId=go-music-dl 手动刷新」入口,
      // 无需改动主项目。歌单以固定 id(pl-gmdl-mine-<source>-<id>) upsert,持久存在、不参与轮转。
      // 沙箱单次调用 15s 硬配额 → syncMyPlaylists 每次只推进一批(预算/数量双闸),进度存
      // gmdlMineCursor 跨日滚动覆盖全部歌单;手动刷新(force)可立即推进下一批。
      //
      // ===== 关键词搜索入库(同入口) =====
      // 用户配置 keywords 后,每日自动搜索各平台匹配歌单,已入库(host.playlists.findBySource)
      // 的跳过,未入库的通过 host.playlists.upsert 写入本地库并标记 externalId。
      async runDailyJob(opts) {
        // 整个定时任务共享一份本地曲库池和搜索结果缓存,减少重复加载和搜索。
        var pool = null;
        var matchCache = null;
        try {
          pool = await loadLocalPool();
          matchCache = boundedCache(1000);
        } catch (e) {
          host.log("加载本地曲库池失败: " + (e && e.message ? e.message : e));
        }
        // 手动关键词搜索入库时跳过私人歌单同步
        if (!opts || !opts.keywordOnly) {
          // 1) 私人歌单同步
          try {
            await syncMyPlaylists(opts || {}, pool, matchCache);
          } catch (e) {
            host.log("私人歌单同步失败: " + (e && e.message ? e.message : e));
          }
        }
        // 2) 关键词搜索入库
        try {
          var configKeywordSearchPlatforms = (host.config && host.config.keywordSearchPlatforms) || null;
          var minSongs = parseInt(host.config && host.config.minSongs, 10) || 30;
          var kw = (host.config && host.config.keywords || "").split("\n").map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
          if (kw.length > 0) {
            for (var ki = 0; ki < kw.length; ki++) {
              var query = kw[ki];
              host.log("关键词搜索: " + query);
              var result = await searchPlaylistsImpl(host.config, { query: query, sources: configKeywordSearchPlatforms });
              var playlists = result && result.playlists || [];
              for (var pi = 0; pi < playlists.length; pi++) {
                var pl = playlists[pi];
                // 跳过已入库(按 sourcePlatform + externalId 查)
                var existing = await host.playlists.findBySource(pl.source, pl.id);
                if (existing) {
                  host.log("  跳过已入库: " + pl.source + "/" + pl.id + " " + (pl.name || ""));
                  continue;
                }
                // 拉取歌曲(fetchPlaylistSongs 返回歌曲数组,非 {songs:[]})
                var songs = await fetchPlaylistSongs(host.config, pl.source, pl.id);
                // 歌曲数量不足则跳过
                if (songs.length < minSongs) {
                  host.log("  跳过歌曲数不足: " + (pl.name || "") + " (" + pl.source + "/" + pl.id + ", " + songs.length + " 首, 阈值 " + minSongs + ")");
                  continue;
                }
                // 写入本地歌单(固定 id 保证 upsert 幂等)
                var localId = "pl-kw-" + pl.source + "-" + pl.id;
                // 复用顶层 pool 和 matchCache,不再重复加载
                var songEntries = [];
                var firstMatchId = null;
                for (var si = 0; si < songs.length; si++) {
                  var s = songs[si];
                  // 1) 本地曲库优先匹配(池内 O(1),池外回退搜索)→ 立即可播+封面正常
                  var matchedSongId = matchInPool(pool, s.name, s.artist) || (await matchLocal(s.name, s.artist, matchCache));
                  if (matchedSongId) {
                    songEntries.push({ songId: matchedSongId });
                    if (!firstMatchId) firstMatchId = matchedSongId;
                    continue;
                  }
                  // 2) 未命中:写外部占位(externalSongId = source:id),由后台自动匹配
                  //    upsertPluginPlaylist 会触发 matchPlaylistInBackground 补全为可播条目
                  songEntries.push({
                    externalSongId: pl.source + ":" + s.id,
                    externalTitle: s.name,
                    externalArtist: s.artist,
                    externalAlbum: s.album,
                    externalDuration: (s.duration || 0) * 1000,
                  });
                }
                await host.playlists.upsert(localId, {
                  name: pl.name || "",
                  sourcePlatform: pl.source,
                  sourceUrl: "gmdl://keyword/" + pl.source + "/" + pl.id,
                  externalId: pl.id,
                  entries: songEntries,
                  coverSongId: firstMatchId,
                });
                host.log("  已入库: " + (pl.name || "") + " (" + pl.source + "/" + pl.id + ", " + songs.length + " 首)");
              }
            }
          }
        } catch (e) {
          host.log("关键词搜索入库失败: " + (e && e.message ? e.message : e));
        }
        // 释放大对象,帮助 QuickJS GC 回收内存
        pool = null;
        if (matchCache) { matchCache.clear(); matchCache = null; }
        return null;
      },
    };
  },
};
