// ==================== ListenBrainz 播放记录上报 + 推荐歌单（scrobbler + recommendPlaylist） ====================
//
// MusicFlow V2 官方外置插件。双功能:
//   1) scrobbler:把播放事件上报到 ListenBrainz(或自建实例);
//   2) recommendPlaylist:每天按「协同过滤推荐」拉取歌单,生成为一张
//      固定合并歌单「ListenBrainz」(id: pl-lb-recommend)。无法匹配本地的
//      曲目,经在线源(go-music-dl 等)补全为可播条目;都没有则保留为外部不可播条目。
//
// 沙箱契约(QuickJS VM 内运行,拿不到 Node 能力):
//   - 纯 JS 脚本:globalThis.__mfPlugin = { manifest, create(host) };
//   - 网络走 host.http(url, { method, headers, body, timeout}),返回
//     { ok, status, headers, body(text) };
//   - host.config 每次调用前刷新,调用时实时读取(cfg());
//   - host.storage 持久化小键值(间隔闸门 lastRun);
//   - host.songs.search(query, {limit}) 本地曲库模糊匹配(title/artist/album);
//   - host.sources.complete({artist, title}) 经已启用在线源补全为可播本地 songId;
//   - host.playlists.upsert(id, {name, description, entries, coverSongId}) 写合并歌单。
//
// scrobbler 契约(见 backend/src/plugins/scrobblers.ts):
//   onPlay(host, event)      — 开始播放 → 上报「正在播放」(playing_now)
//   onScrobble(host, event)  — 播放超阈值 → 记一条正式收听(single)
//
// recommendPlaylist 契约(见 backend/src/plugins/sandbox.ts CAP_METHODS):
//   runDailyJob(opts)        — 每日调度 + 手动刷新(opts.force 时无视间隔闸门强制重生成)

globalThis.__mfPlugin = {
  manifest: {
    id: "listenbrainz",
    name: "ListenBrainz 播放记录 + 推荐",
    version: "1.5.0",
    type: "scrobbler",
    description:
      "把播放记录上报到 ListenBrainz(开源 Last.fm 替代品),并每天按协同过滤推荐生成「ListenBrainz」推荐歌单(艺人/专辑经 MusicBrainz 补全)。运行于 QuickJS 沙箱。",
    capabilities: ["scrobbler", "recommendPlaylist"],
    defaultEnabled: false,
    minAppVersion: "1.7.33", // health() 自检钩子需 1.7.33 沙箱透传
    permissions: ["net", "storage", "songs:read", "songs:write", "playlists:write"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl: "https://gitee.com/ray5378/music-flow-plugins/raw/master/dist/listenbrainz.tar.gz",
    // 首页固定卡:核心按此聚合(manifest.homePlaylistId 指向本插件生成的固定歌单)。
    homePlaylistId: "pl-lb-recommend",
    configSchema: [
      // —— 推荐功能配置 ——
      {
        key: "username",
        label: "ListenBrainz 用户名",
        type: "text",
        required: true,
        help: "用于拉取协同过滤推荐歌单的 ListenBrainz 用户名(在 listenbrainz.org/settings 查看)",
      },
      {
        key: "playlistModes",
        label: "推荐类型",
        type: "multi-select",
        default: ["top", "similar"],
        options: [
          { value: "top", label: "常听艺人" },
          { value: "similar", label: "相似艺人" },
          { value: "raw", label: "原始模型" },
        ],
        help: "拉取哪些协同过滤推荐(可多选);合并去重后生成一张歌单",
      },
      {
        key: "perModeCount",
        label: "每类候选数",
        type: "number",
        default: 25,
        help: "每种推荐类型拉取的候选曲目数(1~100,默认 25)",
      },
      {
        key: "refreshIntervalDays",
        label: "刷新间隔(天)",
        type: "number",
        default: 1,
        help: "距上次生成不足该天数时,每日调度会自动跳过(手动刷新仍会强制重生成)。默认 1 天。",
      },
      {
        key: "showOnHome",
        label: "在首页显示",
        type: "switch",
        default: false,
        help: "是否把「ListenBrainz」歌单固定在首页顶部展示(按下方位次排序)",
      },
      {
        key: "homePosition",
        label: "首页显示位次",
        type: "number",
        default: 0,
        help: "首页顶部固定展示的第几张(1 起)。0 = 未固定。与其它开了「在首页显示」的插件位次不能重复,保存时会自动校验。",
      },
      // —— 上报功能配置(旧版 scrobbler 保留) ——
      {
        key: "userToken",
        label: "用户令牌",
        type: "text",
        required: true,
        help: "在 https://listenbrainz.org/settings/ 页面获取 User token(用于上报播放记录)",
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
  },

  create(host) {
    const DEFAULT_API = "https://api.listenbrainz.org";
    const REC_PLAYLIST_ID = "pl-lb-recommend";
    const cfg = () => host.config || {};

    // ---------- 通用 HTTP ----------
    /** 归一化 API 根地址：去掉结尾斜杠，空值回落到官方实例。 */
    function apiBase() {
      const raw = String(cfg().apiUrl || "").trim();
      return (raw || DEFAULT_API).replace(/\/+$/, "");
    }

    /** GET 一个 JSON 接口，返回解析后的对象；非 2xx 抛可读错误。 */
    async function httpGetJson(url) {
      const r = await host.http(url, { method: "GET", headers: { Accept: "application/json" }, timeout: 20000 });
      if (!r.ok) {
        if (r.status === 204) return null; // 推荐尚未生成(空响应)
        let detail = "";
        try { detail = (JSON.parse(r.body || "{}") || {}).error || r.body || ""; } catch { detail = r.body || ""; }
        throw new Error("ListenBrainz 请求失败 HTTP " + r.status + (detail ? ": " + String(detail).slice(0, 200) : ""));
      }
      try { return JSON.parse(r.body || "{}"); } catch { return {}; }
    }

    // ---------- scrobbler 部分 ----------
    function requireToken() {
      const token = String(cfg().userToken || "").trim();
      if (!token) throw new Error("未配置 ListenBrainz 用户令牌(userToken)");
      return token;
    }

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
      try { detail = (JSON.parse(r.body || "{}") || {}).error || r.body || ""; } catch { detail = r.body || ""; }
      if (r.status === 401) throw new Error("令牌无效或已失效(HTTP 401),请到 ListenBrainz 设置页重新获取");
      if (r.status === 429) {
        const retry = r.headers && (r.headers["retry-after"] || r.headers["Retry-After"]);
        throw new Error("触发限流(HTTP 429)" + (retry ? ",建议 " + retry + "s 后重试" : ""));
      }
      throw new Error("上报失败: HTTP " + r.status + (detail ? " - " + String(detail).slice(0, 200) : ""));
    }

    // ---------- recommender 部分 ----------
    /**
     * 拉取协同过滤推荐 MBID。遍历选中的 artist_type,合并去重(同 MBID 取最高分)。
     * @returns {Promise<Array<{mbid:string, score:number}>>}
     */
    async function fetchRecommendations(username, modes, perMode) {
      const out = new Map();
      for (const mode of modes) {
        const url =
          apiBase() +
          `/1/cf/recommendation/user/${encodeURIComponent(username)}/recording` +
          `?artist_type=${encodeURIComponent(mode)}&count=${perMode}&offset=0`;
        let data = null;
        try {
          data = await httpGetJson(url);
        } catch (e) {
          host.log(`推荐类型 ${mode} 拉取失败: ${e.message}`);
          continue; // 单类型失败不阻断其它类型
        }
        if (!data || !data.payload || !Array.isArray(data.payload.mbids)) continue;
        for (const item of data.payload.mbids) {
          const mbid = item.recording_mbid;
          if (!mbid) continue;
          const score = Number(item.score) || 0;
          const prev = out.get(mbid);
          if (!prev || score > prev.score) out.set(mbid, { mbid, score });
        }
      }
      // 按分数降序,保证「更相似」的排在前面
      return [...out.values()].sort((a, b) => b.score - a.score);
    }

    /** 从 metadata 的 artist rels 里挑主艺人:优先 vocal 类,去重保序。 */
    function extractArtist(rec) {
      const rels = (rec && rec.rels) || [];
      const vocal = rels.filter((r) => String(r.type || "").includes("vocal"));
      const pick = (vocal.length ? vocal : rels).map((r) => r.artist_name).filter(Boolean);
      const seen = {};
      const out = [];
      pick.forEach((n) => { if (!seen[n]) { seen[n] = 1; out.push(n); } });
      return out.join(", ");
    }

    /**
     * 批量换 MBID → 曲目信息。按传入 mbid 顺序返回 {mbid,title,artist,album,duration}。
     * metadata 接口单次最多约 50 个较稳,分批请求。
     */
    async function fetchMetadata(mbids) {
      const byMbid = new Map();
      const BATCH = 50;
      for (let i = 0; i < mbids.length; i += BATCH) {
        const batch = mbids.slice(i, i + BATCH);
        const params = new URLSearchParams();
        for (const m of batch) params.append("recording_mbids", m.mbid);
        const url = apiBase() + "/1/metadata/recording/?" + params.toString();
        let data = null;
        try { data = await httpGetJson(url); } catch (e) { host.log("元数据批量获取失败: " + e.message); continue; }
        if (!data || typeof data !== "object") continue;
        for (const m of batch) {
          const node = data[m.mbid];
          const rec = node && node.recording;
          if (!rec || !rec.name) continue;
          byMbid.set(m.mbid, {
            mbid: m.mbid,
            title: rec.name,
            artist: extractArtist(rec),
            album: rec.release_name || "",
            duration: Number(rec.length) > 0 ? Number(rec.length) : null, // ms
          });
        }
      }

      // 补艺人/专辑:ListenBrainz metadata 不返回 artist / release(rels 常为空),
      // 经 MusicBrainz 单曲接口补全(带 UA + 限流,只处理前 MAX_MB 首)。MB 结果覆盖
      // LB 的解析结果(更可靠),失败则保留原值(可能为空,标题仍可参与匹配)。
      const mb = await fetchMusicBrainzMeta([...byMbid.values()].slice(0, MAX_MB));

      // 按原始推荐顺序回填(只保留有元数据的)
      const result = [];
      for (const m of mbids) {
        const meta = byMbid.get(m.mbid);
        if (!meta) continue;
        const extra = mb.get(m.mbid);
        if (extra) {
          if (extra.artist) meta.artist = extra.artist;
          if (extra.album) meta.album = extra.album;
        }
        result.push(meta);
      }
      return result;
    }

    // MusicBrainz 批量查询上限(限流 1 req/s,避免生成太久;推荐按分排序,前 40 足够)。
    const MAX_MB = 40;
    const MB_RECORDING = "https://musicbrainz.org/ws/2/recording";

    /** 忙等 sleep(沙箱无 setTimeout):MusicBrainz 要求 ≤1 req/s,请求间间隔 1.1s。 */
    function mbSleep() {
      const t0 = Date.now();
      while (Date.now() - t0 < 1100) { /* spin */ }
    }

    /** 从 releases 里挑专辑名:优先 official + 专辑类型,否则取第一条。 */
    function pickAlbumTitle(releases) {
      if (!Array.isArray(releases) || !releases.length) return "";
      const album = releases.find((r) => {
        const pt = String((r && r["primary-type"]) || "").toLowerCase();
        return pt === "album" && ((r && r.status === "official") || !(r && r.status));
      });
      return (album && album.title) || (releases[0] && releases[0].title) || "";
    }

    /**
     * 逐曲调 MusicBrainz 拿 artist-credit 与 releases(专辑)。
     * @returns {Promise<Map<string,{artist:string,album:string}>>}
     */
    async function fetchMusicBrainzMeta(items) {
      const out = new Map();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (i > 0) mbSleep(); // 首请求前不等待;之后每次间隔 1.1s(≤1 req/s)
        const url = MB_RECORDING + "/" + encodeURIComponent(it.mbid) + "?inc=artist-credits+releases&fmt=json";
        try {
          const r = await host.http(url, {
            method: "GET",
            headers: { Accept: "application/json", "User-Agent": "MusicFlow-V2/1.0 (listenbrainz plugin; https://github.com/ray5378/MusicFlow-V2)" },
            timeout: 15000,
          });
          if (r.ok) {
            const d = JSON.parse(r.body || "{}");
            const ac = Array.isArray(d["artist-credit"]) ? d["artist-credit"] : [];
            const names = [];
            for (const a of ac) {
              const n = String((a && (a.name || (a.artist && a.artist.name))) || "").trim();
              if (n) names.push(n);
            }
            const album = pickAlbumTitle(d.releases);
            if (names.length || album) out.set(it.mbid, { artist: names.join(" / "), album });
          }
        } catch (e) { /* 单曲失败跳过,保留 LB 解析结果 */ }
      }
      return out;
    }

    /** 本地曲库模糊匹配:优先「标题+艺人」,再退化「仅标题」,挑标题最相似者。 */
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

    /**
     * 生成合并推荐歌单。流程:间隔闸门 → 拉推荐 MBID → 元数据换名 →
     * 逐曲本地匹配/在线补全/外部占位 → upsert 固定歌单 + 随机封面。
     * @param {{force?:boolean}} opts
     */
    async function generateRecommendPlaylist(opts) {
      const force = !!(opts && opts.force);
      const c = cfg();
      const username = String(c.username || "").trim();
      if (!username) {
        host.log("未配置 ListenBrainz 用户名(username),跳过推荐歌单生成");
        return null;
      }

      // 间隔闸门:非强制刷新时,距上次生成不足 refreshIntervalDays 天则跳过。
      const intervalDays = Math.max(1, Number(c.refreshIntervalDays) || 1);
      if (!force) {
        const last = Number(await host.storage.get("lastRun")) || 0;
        if (last && Date.now() - last < intervalDays * 86400000) {
          host.log(`距上次生成不足 ${intervalDays} 天,跳过(可手动刷新强制)`);
          return null;
        }
      }

      const modes = Array.isArray(c.playlistModes) && c.playlistModes.length
        ? c.playlistModes.filter((m) => ["top", "similar", "raw"].includes(m))
        : ["top", "similar"];
      const perMode = Math.min(100, Math.max(1, Number(c.perModeCount) || 25));

      const mbids = await fetchRecommendations(username, modes, perMode);
      if (!mbids.length) {
        host.log("ListenBrainz 暂无可用的协同过滤推荐(可能听歌记录太少)");
        return null;
      }

      const meta = await fetchMetadata(mbids);
      if (!meta.length) {
        host.log("推荐 MBID 未能换出曲目信息,跳过本次生成");
        return null;
      }

      const entries = [];
      const coverCandidates = [];
      let externalCount = 0;
      for (const m of meta) {
        // 1) 本地曲库匹配
        const localId = await matchLocal(m.title, m.artist);
        if (localId) {
          entries.push({ songId: localId });
          coverCandidates.push(localId);
          continue;
        }
        // 2) 在线源补全(go-music-dl 等已启用 source)
        let completedId = null;
        try {
          const res = await host.sources.complete({ artist: m.artist, title: m.title });
          if (res && res.songId) completedId = res.songId;
        } catch (e) { host.log(`在线补全失败 ${m.title}: ${e.message}`); }
        if (completedId) {
          entries.push({ songId: completedId });
          coverCandidates.push(completedId);
          continue;
        }
        // 3) 都失败:保留为外部不可播条目(仅展示用)
        externalCount++;
        entries.push({
          externalSongId: m.mbid,
          externalTitle: m.title,
          externalArtist: m.artist,
          externalAlbum: m.album,
          externalDuration: m.duration, // ms
        });
      }

      await host.playlists.upsert(REC_PLAYLIST_ID, {
        name: "ListenBrainz",
        description: "由 ListenBrainz 协同过滤推荐生成(每日更新,本地缺失的经在线源补全)",
        entries,
        coverSongId: coverCandidates[0] || null,
      });
      await host.storage.set("lastRun", Date.now());
      host.log(`已生成「ListenBrainz」共 ${entries.length} 首(其中外部占位 ${externalCount} 首)`);
      return `ListenBrainz: ${entries.length} 首(外部 ${externalCount})`;
    }

    return {
      // ===== scrobbler =====
      async onPlay(event) {
        if (cfg().submitPlayingNow === false) return;
        const meta = trackMetadata(event);
        if (!meta) return;
        await submit({ listen_type: "playing_now", payload: [{ track_metadata: meta }] });
        try { host.log("已上报正在播放: " + meta.artist_name + " - " + meta.track_name); } catch { /* ignore */ }
      },
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
        await submit({ listen_type: "single", payload: [{ listened_at: listenedAt, track_metadata: meta }] });
        try { host.log("已记录收听: " + meta.artist_name + " - " + meta.track_name); } catch { /* ignore */ }
      },

      // ===== recommender (dailyPlaylist) =====
      async runDailyJob(opts) {
        try {
          return await generateRecommendPlaylist(opts || {});
        } catch (e) {
          host.log("推荐歌单生成失败: " + (e.message || e));
          return null;
        }
      },

      // ===== 健康自检(可选钩子,供 /v1/plugins/health 主动 ping) =====
      async health() {
        const c = cfg();
        const username = String(c.username || "").trim();
        const token = String(c.userToken || "").trim();
        if (!username || !token) {
          return { status: "degraded", message: "未配置用户名或 Token" };
        }
        const base = apiBase();
        try {
          const r = await host.http(base + "/1/", {
            method: "GET",
            headers: { Accept: "application/json" },
            timeout: 10000,
          });
          if (r && r.ok) return { status: "ok", message: "API 可达" };
          return { status: "down", message: "API 返回 HTTP " + (r && r.status) };
        } catch (e) {
          return { status: "down", message: String((e && e.message) || e) };
        }
      },
    };
  },
};
