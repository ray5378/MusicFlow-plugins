// ==================== Last.fm 播放记录上报 + 推荐歌单（scrobbler + recommender） ====================
//
// MusicFlow 官方外置插件。双功能,全面对标 listenbrainz 插件:
//   1) scrobbler:把播放事件上报到 Last.fm(官方 Web API,MD5 签名鉴权);
//   2) recommender(recommendPlaylist):每天按「用户收听数据」组装一张固定合并
//      歌单「Last.fm 推荐」(id: pl-lf-recommend)。来源 = 用户 TopTracks(多周期
//      合并) + LovedTracks + 相似艺人热门曲(artist.getSimilar → artist.getTopTracks),
//      合并去重。无法匹配本地的曲目,经在线源(go-music-dl 等)补全为可播条目;
//      都没有则保留为外部不可播条目。
//
// 沙箱契约(QuickJS VM 内运行,拿不到 Node 能力):
//   - 纯 JS 脚本:globalThis.__mfPlugin = { manifest, create(host) };
//   - 网络走 host.http(url, { method, headers, body, timeout}),返回 { ok, status, headers, body(text) };
//   - host.config 每次调用前刷新,调用时实时读取(cfg());
//   - host.crypto.md5(str) 纯同步 MD5(Last.fm api_sig 签名需要,需 crypto 权限);
//   - host.storage 持久化小键值(间隔闸门 lastRun);
//   - host.songs.search(query, {limit}) 本地曲库模糊匹配(title/artist/album);
//   - host.sources.complete({artist, title}) 经已启用在线源补全为可播本地 songId;
//   - host.playlists.upsert(id, {name, description, entries, coverSongId}) 写合并歌单。
//
// scrobbler 契约(见 backend/src/plugins/scrobblers.ts):
//   onPlay(host, event)      — 开始播放 → 上报「正在播放」(track.updateNowPlaying)
//   onScrobble(host, event)  — 播放超阈值 → 记一条正式收听(track.scrobble)
//
// recommender 契约(见 backend/src/plugins/sandbox.ts CAP_METHODS):
//   runDailyJob(opts)        — 每日调度(opts.force 时无视间隔闸门强制重生成)

// Last.fm 鉴权说明(与 ListenBrainz 的裸 token 完全不同):
//   - 读接口(user.getTopTracks 等):只需 api_key;
//   - 写接口(track.scrobble / track.updateNowPlaying):需要 api_key + sk(session key)
//     + api_sig。api_sig = MD5( 按字母序排列的「除 format 外所有参数」key+value 拼接 + secret )。
//   - session key 获取:浏览器访问 http://www.last.fm/api/auth?api_key=XXX 授权后拿到 token,
//     再经 auth.getSession(token) 换取;用户把最终 session key 填进插件配置即可。

globalThis.__mfPlugin = {
  manifest: {
    id: "lastfm",
    name: "Last.fm 播放记录 + 推荐",
    version: "1.0.6",
    type: "scrobbler",
    schedules: true,
    description:
      "把播放记录上报到 Last.fm(经典 Last.fm 官方服务),并每天按收听数据组装「Last.fm 推荐」歌单(Top + Loved + 相似艺人)。运行于 QuickJS 沙箱。",
    capabilities: ["scrobbler", "recommendPlaylist"],
    defaultEnabled: false,
    minAppVersion: "1.7.39", // longRunning 方法级长耗时预算需 1.7.39 沙箱
    // 方法级长耗时预算:onPlay/onScrobble 上报声明预算(软看门狗,无 15s 墙钟硬杀),
    // 慢网络下上报不再被沙箱超时中断;runDailyJob 组装推荐歌单也需要长预算。
    longRunning: { onPlay: 25000, onScrobble: 25000, runDailyJob: 120000 },
    permissions: ["net", "storage", "crypto", "songs:read", "songs:write", "playlists:write"],
    author: "ray5378",
    homepage: "https://github.com/ray5378/MusicFlow-plugins",
    downloadUrl: "https://github.com/ray5378/MusicFlow-plugins/releases/download/lastfm-v1.0.4/lastfm.tar.gz",
    // 首页固定卡:核心按此聚合(manifest.homePlaylistId 指向本插件生成的固定歌单)。
    homePlaylistId: "pl-lf-recommend",
    configSchema: [
      // —— 账号 / 鉴权 ——
      {
        key: "username",
        label: "Last.fm 用户名",
        type: "text",
        required: true,
        help: "你的 Last.fm 用户名(用于拉取 Top/Loved/相似艺人)",
      },
      {
        key: "apiKey",
        label: "API Key",
        type: "text",
        required: true,
        help: "在 https://www.last.fm/api/account/create 申请应用后获得(读接口用)",
      },
      {
        key: "apiSecret",
        label: "API Secret",
        type: "password",
        required: true,
        help: "与 API Key 同页的共享密钥(写接口签名用,不会对外泄露)",
      },
      {
        key: "sessionKey",
        label: "Session Key",
        type: "password",
        required: true,
        help: "写接口(上报播放)需要。获取:浏览器打开 https://www.last.fm/api/auth?api_key=你的Key 授权后拿到 token,再到 https://ws.audioscrobbler.com/2.0/?method=auth.getSession&api_key=你的Key&token=你的token&format=json 换 session key,把返回的 key 填这里",
      },
      // —— 上报行为 ——
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
        help: "短于该时长的曲目不记录正式收听(Last.fm 官方建议忽略 30 秒以下)",
      },
      // —— 推荐歌单 ——
      {
        key: "periods",
        label: "统计周期",
        type: "multi-select",
        default: ["overall", "7day"],
        options: [
          { value: "overall", label: "全部时间" },
          { value: "7day", label: "近 7 天" },
          { value: "1month", label: "近 1 个月" },
          { value: "3month", label: "近 3 个月" },
          { value: "6month", label: "近 6 个月" },
          { value: "12month", label: "近 12 个月" },
        ],
        help: "拉取哪些周期的 TopTracks(可多选);合并去重后生成一张歌单",
      },
      {
        key: "includeLoved",
        label: "包含喜欢的歌",
        type: "switch",
        default: true,
        help: "是否把 user.getLovedTracks 的「喜欢的歌曲」并入推荐歌单",
      },
      {
        key: "includeSimilar",
        label: "包含相似艺人",
        type: "switch",
        default: true,
        help: "是否基于常听艺人扩展相似艺人的热门曲(artist.getSimilar → artist.getTopTracks),更像「推荐」但拉取请求更多",
      },
      {
        key: "perPeriodCount",
        label: "每周期候选数",
        type: "number",
        default: 25,
        help: "每个周期/每类来源拉取的候选曲目数(1~100,默认 25)",
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
        help: "是否把「Last.fm 推荐」歌单固定在首页顶部展示(按下方位次排序)",
      },
      {
        key: "homePosition",
        label: "首页显示位次",
        type: "number",
        default: 3,
        help: "首页固定卡的展示位次(数字越小越靠前,不能与其它固定卡重复)",
      },
    ],
  },

  create(host) {
    const API_ROOT = "https://ws.audioscrobbler.com/2.0/";
    const REC_PLAYLIST_ID = "pl-lf-recommend";
    const cfg = () => host.config || {};

    // ---------- 通用工具 ----------
    /** 忙等 sleep(沙箱无 setTimeout);Last.fm 限流 ~5 req/s,节奏留余量。 */
    function rateSleep(ms) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { /* spin */ }
    }

    function requireKey() {
      const k = String(cfg().apiKey || "").trim();
      if (!k) throw new Error("未配置 Last.fm API Key(apiKey)");
      return k;
    }

    function requireSession() {
      const sk = String(cfg().sessionKey || "").trim();
      if (!sk) throw new Error("未配置 Last.fm Session Key(sessionKey),无法上报播放");
      return sk;
    }

    function trackFields(event) {
      const artist = String(event.artist || "").trim();
      const title = String(event.title || "").trim();
      if (!artist || !title) return null;
      const out = { artist, track: title };
      const album = String(event.album || "").trim();
      if (album) out.album = album;
      const secs = Number(event.duration);
      if (Number.isFinite(secs) && secs > 0) out.duration = Math.round(secs);
      return out;
    }

    /** api_sig = MD5( 除 format 外所有参数按 key 字母序 k+v 拼接 + secret )。 */
    function signParams(params, secret) {
      const keys = Object.keys(params).filter((k) => k !== "format").sort();
      const str = keys.map((k) => k + String(params[k])).join("") + secret;
      return host.crypto.md5(str);
    }

    /** Last.fm 返回体里带 error 字段即失败(HTTP 200 但业务错误),统一抛可读错误。 */
    function throwIfError(d, method) {
      if (d && Number(d.error)) {
        const code = Number(d.error);
        const msg = String((d && d.message) || "未知错误");
        if (code === 9) throw new Error("Last.fm Session Key 无效或已失效(错误 9),请重新获取后更新插件配置");
        if (code === 13) throw new Error("Last.fm 签名校验失败(错误 13),请检查 apiSecret 是否填错");
        if (code === 29) throw new Error("Last.fm 限流(错误 29),稍后重试");
        if (code === 26) throw new Error("Last.fm API Key 已被暂停(错误 26),请联系 Last.fm");
        throw new Error("Last.fm " + method + " 失败(错误 " + code + "): " + msg);
      }
    }

    /** 读接口:只需 api_key,无需签名。GET + query。 */
    async function apiGet(method, params) {
      const p = { method, api_key: requireKey(), format: "json", ...(params || {}) };
      const qs = Object.keys(p).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(p[k]))).join("&");
      const r = await host.http(API_ROOT + "?" + qs, { method: "GET", headers: { Accept: "application/json" }, timeout: 20000 });
      if (!r.ok) throw new Error("Last.fm 请求失败 HTTP " + r.status + " " + String(r.body || "").slice(0, 200));
      let d = {};
      try { d = JSON.parse(r.body || "{}"); } catch { throw new Error("Last.fm 响应不是 JSON"); }
      throwIfError(d, method);
      return d;
    }

    /** 写接口:api_key + sk + api_sig。POST form。 */
    async function apiWrite(method, params) {
      const secret = String(cfg().apiSecret || "").trim();
      if (!secret) throw new Error("未配置 Last.fm API Secret(apiSecret),无法签名上报");
      const p = { method, api_key: requireKey(), sk: requireSession(), format: "json", ...(params || {}) };
      p.api_sig = signParams(p, secret);
      const body = Object.keys(p).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(p[k]))).join("&");
      const r = await host.http(API_ROOT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
        timeout: 20000, // 软看门狗预算内放宽:Last.fm 偶发慢,15s 容易被掐断
      });
      let d = {};
      try { d = JSON.parse(r.body || "{}"); } catch { /* 下面统一按 !ok 处理 */ }
      if (!r.ok && !Number(d.error)) throw new Error("Last.fm 上报失败 HTTP " + r.status + " " + String(r.body || "").slice(0, 200));
      throwIfError(d, method);
      return d;
    }

    // ---------- scrobbler 部分 ----------
    async function updateNowPlaying(fields) {
      const params = { ...fields };
      delete params.duration; // updateNowPlaying 支持 duration,但部分客户端会 400;保留也无妨 → 保守去掉
      await apiWrite("track.updateNowPlaying", params);
    }

    async function scrobble(fields) {
      const parsed = Date.parse(fields.playedAt);
      const start = Number.isFinite(parsed) ? parsed : Date.now();
      const durMs = Number(fields.durationSec) > 0 ? Number(fields.durationSec) * 1000 : 0;
      const timestamp = Math.floor((start + durMs) / 1000); // 结束时刻,符合 Last.fm 语义
      const params = { artist: fields.artist, track: fields.track, timestamp };
      if (fields.album) params.album = fields.album;
      await apiWrite("track.scrobble", params);
    }

    // ---------- recommender 部分 ----------
    const norm = (s) => String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, "");
    const keyOf = (artist, title) => norm(artist) + "|" + norm(title);

    /** 把一首 Last.fm track 合并进 Map(同曲保留 playcount 高者,来源优先级 tag 高者胜)。 */
    function mergeTrack(out, t, tag, priority) {
      const artist = String((t && t.artist && (t.artist.name || t.artist["#text"])) || (t && t.artist) || "").trim();
      const title = String((t && t.name) || "").trim();
      if (!artist || !title) return;
      const key = keyOf(artist, title);
      const playcount = Number(t.playcount) || 0;
      const prev = out.get(key);
      if (!prev || playcount > prev.playcount || (playcount === prev.playcount && priority < prev.priority)) {
        out.set(key, {
          artist, title,
          album: String((t && t.album && (t.album["#text"] || t.album.name)) || "").trim(),
          playcount,
          mbid: String((t && t.mbid) || "").trim(),
          tag, priority,
        });
      }
    }

    /** 拉取各周期 TopTracks。 */
    async function fetchTopTracks(username, periods, limit) {
      const out = new Map();
      for (const period of periods) {
        try {
          const d = await apiGet("user.getTopTracks", { user: username, period, limit });
          const tracks = (d.toptracks && d.toptracks.track) || [];
          for (const t of tracks) mergeTrack(out, t, "top:" + period, 0);
        } catch (e) {
          host.log("周期 " + period + " TopTracks 拉取失败: " + e.message);
        }
        rateSleep(250); // ≤4 req/s,留余量
      }
      return out;
    }

    /** 拉取喜欢的歌曲。 */
    async function fetchLovedTracks(username, limit) {
      const out = new Map();
      try {
        const d = await apiGet("user.getLovedTracks", { user: username, limit });
        const tracks = (d.lovedtracks && d.lovedtracks.track) || [];
        for (const t of tracks) mergeTrack(out, t, "loved", 1);
      } catch (e) {
        host.log("LovedTracks 拉取失败: " + e.message);
      }
      rateSleep(250);
      return out;
    }

    /** 相似艺人扩展:常听 top 艺人的相似艺人的热门曲。 */
    async function fetchSimilarTracks(username, limit) {
      const out = new Map();
      try {
        const top = await apiGet("user.getTopArtists", { user: username, period: "overall", limit: 5 });
        const topArtists = (top.topartists && top.topartists.artist) || [];
        rateSleep(250);
        const seen = new Set();
        for (const a of topArtists.slice(0, 5)) {
          const an = String(a && a.name || "").trim();
          if (!an || seen.has(norm(an))) continue;
          seen.add(norm(an));
          try {
            const sim = await apiGet("artist.getSimilar", { artist: an, limit: 2 });
            const similar = (sim.similarartists && sim.similarartists.artist) || [];
            rateSleep(250);
            for (const s of similar.slice(0, 2)) {
              const sn = String(s && s.name || "").trim();
              if (!sn || seen.has(norm(sn))) continue;
              seen.add(norm(sn));
              try {
                const tt = await apiGet("artist.getTopTracks", { artist: sn, limit });
                const tracks = (tt.toptracks && tt.toptracks.track) || [];
                for (const t of tracks) mergeTrack(out, t, "similar:" + sn, 2);
              } catch (e) { host.log("相似艺人 " + sn + " 热门曲失败: " + e.message); }
              rateSleep(250);
            }
          } catch (e) { host.log("相似艺人扩展失败(" + an + "): " + e.message); }
        }
      } catch (e) {
        host.log("相似艺人扩展整体失败: " + e.message);
      }
      return out;
    }

    /** 本地曲库匹配(歌名+歌手硬,专辑软性择优),命中返回 songId。 */
    async function matchLocal(title, artist, album, durationMs) {
      const tNorm = norm(title);
      if (!tNorm) return null;
      const aNorm = norm(artist);
      const tryQuery = async (q) => {
        try { return (await host.songs.search(q, { limit: 50 })) || []; } catch { return []; }
      };
      // 首轮带歌手搜(宿主已支持分词 AND);0 条才回退裸歌名并拉大候选量,
      // 避免同名多版本被截断漏掉正确歌手。
      let hits = await tryQuery([title, artist].filter(Boolean).join(" "));
      if (!hits.length) hits = await tryQuery(title);
      if (!hits.length) return null;
      let best = null, bestScore = -1;
      for (const h of hits) {
        const hTitle = norm(h.title);
        const hArtist = norm(h.artist);
        // 歌名硬:必须精确相等(不再收 60 包含分——同名单曲不得绑到 Live/Remix 变体)。
        if (hTitle !== tNorm) continue;
        // 歌手硬:期望歌手非空时必须互相包含;歌手不符 = 同名异曲,直接排除。
        if (aNorm) {
          if (!(hArtist && (hArtist.includes(aNorm) || aNorm.includes(hArtist)))) continue;
        }
        let score = aNorm ? 140 : 100;
        // 时长软:双方均可比且差 ≤5s 加分(Last.fm 无时长来源时该维自动跳过)。
        // 本地库 duration 存秒(songs.duration 由 scanner 写入,music-metadata 单位秒),
        // 调用方传毫秒 → 本地值 <1000 视为秒先转毫秒再比较。
        if (durationMs > 0) {
          const rawDur = Number(h.duration) || 0;
          const hDurMs = rawDur > 0 && rawDur < 1000 ? rawDur * 1000 : rawDur;
          if (hDurMs > 0 && Math.abs(hDurMs - durationMs) <= 5000) score += 10;
        }
        // 专辑软:归一后一致加分(仅用于同歌名同歌手多版本择优)。
        if (album && h.album && norm(album) === norm(h.album)) score += 5;
        if (score > bestScore) { bestScore = score; best = h; }
      }
      return best && ((aNorm && bestScore >= 140) || (!aNorm && bestScore >= 100)) ? best.id : null;
    }

    /**
     * 生成合并推荐歌单。流程:间隔闸门 → TopTracks(多周期) + Loved + 相似艺人 →
     * 合并去重 → 逐曲本地匹配/在线补全/外部占位 → upsert 固定歌单。
     * @param {{force?:boolean}} opts
     */
    async function generateRecommendPlaylist(opts) {
      const force = !!(opts && opts.force);
      const c = cfg();
      const username = String(c.username || "").trim();
      if (!username) {
        host.log("未配置 Last.fm 用户名(username),跳过推荐歌单生成");
        return null;
      }

      // 间隔闸门:非强制刷新时,距上次生成不足 refreshIntervalDays 天则跳过。
      const intervalDays = Math.max(1, Number(c.refreshIntervalDays) || 1);
      if (!force) {
        const last = Number(await host.storage.get("lastRun")) || 0;
        if (last && Date.now() - last < intervalDays * 86400000) {
          host.log("距上次生成不足 " + intervalDays + " 天,跳过(可手动刷新强制)");
          return null;
        }
      }

      const periods = Array.isArray(c.periods) && c.periods.length
        ? c.periods.filter((p) => ["overall", "7day", "1month", "3month", "6month", "12month"].includes(p))
        : ["overall", "7day"];
      const perPeriod = Math.min(100, Math.max(1, Number(c.perPeriodCount) || 25));
      const includeLoved = c.includeLoved !== false;
      const includeSimilar = c.includeSimilar === true;

      // 合并所有来源(优先级:top=0 < loved=1 < similar=2;同分时更高优先级即更小 priority 胜出)。
      const merged = new Map();
      const topMap = await fetchTopTracks(username, periods, perPeriod);
      for (const [k, v] of topMap) mergeTrack(merged, { name: v.title, artist: v.artist, album: { "#text": v.album }, playcount: v.playcount, mbid: v.mbid }, v.tag, 0);
      if (includeLoved) {
        const loved = await fetchLovedTracks(username, perPeriod);
        for (const [k, v] of loved) mergeTrack(merged, { name: v.title, artist: v.artist, album: { "#text": v.album }, playcount: v.playcount }, v.tag, 1);
      }
      if (includeSimilar) {
        const sim = await fetchSimilarTracks(username, Math.min(perPeriod, 5));
        for (const [k, v] of sim) mergeTrack(merged, { name: v.title, artist: v.artist, playcount: v.playcount }, v.tag, 2);
      }

      const items = [...merged.values()];
      if (!items.length) {
        host.log("Last.fm 未取到任何候选曲目(检查用户名/Key 是否配置正确)");
        return null;
      }

      const entries = [];
      const coverCandidates = [];
      let externalCount = 0;
      for (const it of items) {
        // 1) 本地曲库匹配
        const localId = await matchLocal(it.title, it.artist, it.album);
        if (localId) {
          entries.push({ songId: localId });
          coverCandidates.push(localId);
          continue;
        }
        // 2) 在线源补全(go-music-dl 等已启用 source)
        let completedId = null;
        try {
          const res = await host.sources.complete({ artist: it.artist, title: it.title });
          if (res && res.songId) completedId = res.songId;
        } catch (e) { host.log("在线补全失败 " + it.title + ": " + e.message); }
        if (completedId) {
          entries.push({ songId: completedId });
          coverCandidates.push(completedId);
          continue;
        }
        // 3) 都失败:保留为外部不可播条目(仅展示用)
        externalCount++;
        entries.push({
          externalSongId: it.mbid || (it.artist + " - " + it.title),
          externalTitle: it.title,
          externalArtist: it.artist,
          externalAlbum: it.album || "",
        });
      }

      await host.playlists.upsert(REC_PLAYLIST_ID, {
        name: "Last.fm 推荐",
        description: "由 Last.fm 收听数据组装(Top 多周期 + 喜欢的歌 + 相似艺人,本地缺失的经在线源补全)",
        entries,
        coverSongId: coverCandidates[0] || null,
      });
      await host.storage.set("lastRun", Date.now());
      host.log("已生成「Last.fm 推荐」共 " + entries.length + " 首(其中外部占位 " + externalCount + " 首)");
      return "Last.fm 推荐: " + entries.length + " 首(外部 " + externalCount + ")";
    }

    return {
      // ===== scrobbler =====
      async onPlay(event) {
        if (cfg().submitPlayingNow === false) return;
        const f = trackFields(event);
        if (!f) return;
        await updateNowPlaying(f);
        try { host.log("已上报正在播放: " + f.artist + " - " + f.track); } catch { /* ignore */ }
      },
      async onScrobble(event) {
        const f = trackFields(event);
        if (!f) return;
        const min = Number(cfg().minDuration);
        const secs = Number(event.duration);
        const threshold = Number.isFinite(min) ? min : 30;
        if (Number.isFinite(secs) && secs > 0 && secs < threshold) {
          try { host.log("跳过过短曲目(" + secs + "s < " + threshold + "s): " + f.artist + " - " + f.track); } catch { /* ignore */ }
          return;
        }
        await scrobble({ ...f, playedAt: event.playedAt, durationSec: secs });
        try { host.log("已记录收听: " + f.artist + " - " + f.track); } catch { /* ignore */ }
      },

      // ===== recommender (recommendPlaylist) =====
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
        if (!String(c.apiKey || "").trim() || !String(c.apiSecret || "").trim()) {
          return { status: "degraded", message: "未配置 API Key 或 Secret" };
        }
        if (!String(c.sessionKey || "").trim()) {
          return { status: "degraded", message: "未配置 Session Key(无法上报播放)" };
        }
        try {
          const d = await apiGet("user.getInfo", { user: String(c.username || "").trim() || "rj" });
          if (d && d.user) return { status: "ok", message: "API 可达" };
          return { status: "down", message: "API 返回异常" };
        } catch (e) {
          return { status: "down", message: String((e && e.message) || e) };
        }
      },
    };
  },
};
