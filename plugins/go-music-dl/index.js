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
    version: "1.2.7",
    type: "source",
    description:
      "三合一官方外置插件:通过局域网已部署的 go-music-dl 服务搜索全网音乐、获取推荐歌单、流式播放,并为在线歌曲提供 LRC 歌词与封面。配置后台用户名/密码后,插件会每日自动登录,并把各平台「我的私人歌单」(网易云 / QQ / 酷狗 / 汽水)作为**持久歌单**同步到本地(不轮转、不被清理,歌单内歌曲每日自动刷新为可播条目)。源 / 歌词 / 封面共用同一份服务地址配置。运行于 QuickJS 沙箱。",
    capabilities: [
      "search",
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
    minAppVersion: "1.7.33", // health() 自检钩子需 1.7.33 沙箱透传
    permissions: ["net", "storage", "songs:read", "songs:write", "playlists:write"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl: "https://gitee.com/ray5378/music-flow-plugins/raw/master/dist/go-music-dl.tar.gz",
    configSchema: [
      { key: "baseUrl", label: "服务地址", type: "url", required: true, help: "填写你在局域网部署的 go-music-dl 网页服务地址(源 / 歌词 / 封面共用)" },
      { key: "username", label: "登录用户名", type: "text", help: "go-music-dl 网页后台登录用户名。留空则不登录,仅拉公开推荐歌单;填写后插件会登录并同步各平台「我的歌单」" },
      { key: "password", label: "登录密码", type: "password", help: "go-music-dl 网页后台登录密码(经系统代理/直连发送,仅存于插件配置,不对外暴露)" },
      { key: "importMyPlaylists", label: "同步我的私人歌单", type: "switch", default: true, help: "开启后,插件每日自动登录并同步各平台「我的歌单」(网易云 / QQ / 酷狗 / 汽水)为**持久本地歌单**:不轮转、不被清理,歌单内歌曲每日自动刷新(本地缺失的经 go-music-dl 在线补全为可播条目);关闭则只同步公开推荐" },
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
      { key: "homeCount", label: "平台首页歌单数", type: "number", help: "首页「平台精选」每个平台展示的歌单数量(1~50,默认 6)。所有平台取同一个值。" },
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
      if (!r.ok) {
        // 携带真实失败原因(r.error),避免盲报 "HTTP undefined" 无从排查。
        // 典型:net 权限未授予 → r.error.message="PERMISSION_DENIED: net";
        //       服务不可达 → r.error.message="fetch failed"/"ECONNREFUSED" 等。
        const detail = r.error ? " (" + (r.error.message || r.error) + ")" : "";
        throw new Error("HTTP " + (r.status == null ? "?" : r.status) + ": " + url + detail);
      }
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
          return a ? decodeAttr(a[1]) : "";
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
          name: params.get("name") || "",
          creator: params.get("creator") || "",
          trackCount: params.get("track_count") || "",
          link: params.get("link") || "",
        });
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
          timeout: 15000,
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
        return host.http(url, { method: "GET", headers: h, timeout: 20000 });
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
      let page = 1, total = 0;
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
      return all;
    };
    /** 本地曲库模糊匹配(与 ListenBrainz 插件同款打分),命中返回 songId。 */
    async function matchLocal(title, artist) {
      const norm = (s) => String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, "");
      const tNorm = norm(title);
      if (!tNorm) return null;
      const tryQuery = async (q) => {
        try { return (await host.songs.search(q, { limit: 10 })) || []; } catch { return []; }
      };
      let hits = await tryQuery([title, artist].filter(Boolean).join(" "));
      if (!hits.length) hits = await tryQuery(title);
      if (!hits.length) return null;
      let best = null, bestScore = -1;
      for (const h of hits) {
        const hTitle = norm(h.title);
        let score = 0;
        if (hTitle === tNorm) score += 100;
        else if (hTitle.includes(tNorm) || tNorm.includes(hTitle)) score += 60;
        if (artist) {
          const aNorm = norm(artist);
          const hArtist = norm(h.artist);
          if (aNorm && (hArtist.includes(aNorm) || aNorm.includes(hArtist))) score += 40;
        }
        if (score > bestScore) { bestScore = score; best = h; }
      }
      return best && bestScore >= 60 ? best.id : null;
    }
    /** 每日私人歌单自动同步(路径 B):登录 → 拉各平台我的歌单 → upsert 持久歌单。
     *  返回摘要串或 null(跳过/未配置)。永不抛错(调度器会 catch,手动刷新也需稳健)。 */
    async function syncMyPlaylists(opts) {
      const c = host.config || {};
      if (c.importMyPlaylists === false) return null;
      const user = String(c.username || "").trim();
      const pass = String(c.password || "").trim();
      if (!user || !pass) { host.log("未配置用户名/密码,跳过私人歌单同步"); return null; }
      // 每日闸门(force 绕过):启动补跑/6h 维护/调度可能一日内多次触发,避免重复全量同步。
      const force = !!(opts && opts.force);
      if (!force) {
        const last = Number(await host.storage.get("gmdlMineLastSync")) || 0;
        if (last && Date.now() - last < 20 * 3600e3) return null;
      }
      const cookie = await ensureLogin(c);
      const srcs = ((c.sources && c.sources.length) ? c.sources : PRIVATE_SOURCES).filter((s) => PRIVATE_SOURCES.includes(s));
      const t0 = Date.now();
      const BUDGET_MS = 12000; // 控制单次 runDailyJob 总耗时,避免超过沙箱 15s 调用配额
      let total = 0;
      for (const source of srcs) {
        let pls = [];
        try { pls = await fetchUserPlaylists(c, source, cookie); }
        catch (e) { host.log("拉取我的歌单失败(" + source + "): " + (e && e.message ? e.message : e)); continue; }
        for (const pl of pls) {
          try {
            const songs = await fetchPlaylistSongs(c, source, pl.id);
            const entries = [];
            const coverCandidates = [];
            for (const s of songs) {
              // 1) 本地曲库优先匹配(快,且立即可播+封面正常)
              const localId = await matchLocal(s.name, s.artist);
              if (localId) { entries.push({ songId: localId }); coverCandidates.push(localId); continue; }
              // 2) 预算内才做在线补全(网络较慢);超预算的歌留作外部条目,由后台 auto-match 补匹配
              let completedId = null;
              if (Date.now() - t0 < BUDGET_MS) {
                try {
                  const res = await host.sources.complete({ artist: s.artist, title: s.name });
                  if (res && res.songId) completedId = res.songId;
                } catch (e2) { host.log("在线补全失败 " + s.name + ": " + (e2 && e2.message ? e2.message : e2)); }
              }
              if (completedId) { entries.push({ songId: completedId }); coverCandidates.push(completedId); continue; }
              // 3) 都失败:外部占位(后台 auto-match 经 go-music-dl 补全为可播)
              entries.push({
                externalSongId: source + ":" + s.id,
                externalTitle: s.name,
                externalArtist: s.artist,
                externalAlbum: s.album,
                externalDuration: (s.duration || 0) * 1000, // 秒 → 毫秒
              });
            }
            const pid = "pl-gmdl-mine-" + source + "-" + pl.id;
            await host.playlists.upsert(pid, {
              name: labelOf(source) + " · " + (pl.name || "我的歌单"),
              description: "go-music-dl 我的私人歌单(" + labelOf(source) + "),每日自动同步",
              entries,
              coverSongId: coverCandidates[0] || null,
            });
            total++;
          } catch (e) { host.log("同步歌单失败 " + (pl.name || source) + ": " + (e && e.message ? e.message : e)); }
        }
      }
      await host.storage.set("gmdlMineLastSync", Date.now());
      if (total) host.log("已同步 " + total + " 个私人歌单");
      return total ? ("私人歌单: " + total + " 个已同步") : null;
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
        for (const s of params.sources || []) qs.append("sources", s);
        const html = await httpText(baseOf(config) + "/music/search?" + qs.toString(), 15000);
        return { songs: parseSongCards(html) };
      },

      async recommend(config) {
        // 公开推荐歌单(路径 A,轮转清理) —— 仅返回公开「平台精选」频道。
        // 「我的私人歌单」改走路径 B(持久歌单,每日自动同步),见 runDailyJob(),
        // 不再经推荐频道,因此不会被每日轮转清理。
        const html = await httpText(baseOf(config) + "/music/recommend", 20000);
        const channels = parseRecommendPlaylists(html);
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

      // ===== 私人歌单每日同步(路径 B:持久不轮转) =====
      // 复用主项目既有「每日调度 + /v1/recommend/refresh?pluginId=go-music-dl 手动刷新」入口,
      // 无需改动主项目。歌单以固定 id(pl-gmdl-mine-<source>-<id>) upsert,持久存在、不参与轮转。
      async runDailyJob(opts) {
        try {
          return await syncMyPlaylists(opts || {});
        } catch (e) {
          host.log("私人歌单同步失败: " + (e && e.message ? e.message : e));
          return null;
        }
      },
    };
  },
};
