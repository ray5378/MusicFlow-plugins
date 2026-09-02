// ==================== ListenBrainz 播放记录上报 + 推荐歌单（scrobbler + recommendPlaylist） ====================
//
// MusicFlow 官方外置插件。双功能:
//   1) scrobbler:把播放事件上报到 ListenBrainz(或自建实例);
//   2) recommendPlaylist:每天按「协同过滤推荐」拉取歌单,生成为一张
//      固定合并歌单「ListenBrainz」(id: pl-lb-recommend)。无法匹配本地的
//      曲目,经在线源(go-music-dl 等)补全为可播条目;都没有则保留为外部不可播条目。
//
// 沙箱契约(QuickJS VM 内运行,拿不到 Node 能力):
//   - 纯 JS 脚本:globalThis.__mfPlugin = { manifest, create(host) };
//   - 网络走 host.http(url, { method, headers, body, timeout, proxy }),返回
//     { ok, status, headers, body(text) };proxy=true 强制走系统代理,false 直连,
//     缺省跟随系统设置(需宿主 1.7.38+,旧宿主忽略该字段直连);
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
    version: "1.5.8",
    type: "scrobbler",
    description:
      "把播放记录上报到 ListenBrainz(开源 Last.fm 替代品),并每天按协同过滤推荐生成「ListenBrainz」推荐歌单(换名优先用收听历史 + LB 元数据,MusicBrainz 仅兜底且带重试/预算,直连不可达时自动降级;经 manifest.longRunning 声明长耗时预算,配合后端异步任务通道一次任务即可完成生成)。运行于 QuickJS 沙箱。",
    capabilities: ["scrobbler", "recommendPlaylist"],
    defaultEnabled: false,
    minAppVersion: "1.7.39", // longRunning 方法级长耗时预算需 1.7.39 沙箱
    // 方法级长耗时预算:拉取 listenbrainz.org(外网)推荐 + MusicBrainz 兜底,声明 120s;
    // onPlay/onScrobble 上报同样声明预算(软看门狗,无 15s 墙钟硬杀)——慢网络/代理下
    // 上报不再被沙箱超时中断成 "HTTP 0"(此前超时失败还可能诱发客户端重试,加剧重复收听)。
    longRunning: { runDailyJob: 120000, onPlay: 25000, onScrobble: 25000 },
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
        key: "useProxy",
        label: "走系统网络代理",
        type: "switch",
        default: true,
        help: "开:经系统设置里的「网络代理」访问第三方 API(容器直连 musicbrainz.org 等被墙域名不通时建议开启);关:直连(直连可达时更快,且本插件已内置重试/收听历史兜底)",
      },
      {
        key: "excludeListened",
        label: "排除已听过的推荐",
        type: "switch",
        default: false,
        help: "开:推荐歌单里跳过你已听过(收听历史命中)的曲目,只留新歌。注意:MusicBrainz 不可达时换名受限,开启后推荐数量可能明显变少;推荐本身可能含已听过(尤其「常听艺人」类型),可改用「相似艺人/原始模型」类型或开启此项",
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
    /** 插件级代理开关:true 强制走系统代理,false 强制直连(供 host.http 的 proxy 字段)。 */
    function proxyFlag() {
      return { proxy: cfg().useProxy !== false };
    }

    /** 归一化 API 根地址：去掉结尾斜杠，空值回落到官方实例。 */
    function apiBase() {
      const raw = String(cfg().apiUrl || "").trim();
      return (raw || DEFAULT_API).replace(/\/+$/, "");
    }

    /** GET 一个 JSON 接口，返回解析后的对象；非 2xx 抛可读错误。 */
    async function httpGetJson(url) {
      const r = await host.http(url, { method: "GET", headers: { Accept: "application/json" }, timeout: 10000, ...proxyFlag() });
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
      const info = { media_player: "MusicFlow", submission_client: "MusicFlow", ...(extra || {}) };
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
        timeout: 20000, // 软看门狗预算内放宽:ListenBrainz 偶发慢(尤其走代理),15s 容易被掐断
        ...proxyFlag(),
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
    /**
     * 拉取用户最近收听历史,建 recording_mbid → 曲目信息映射(直连 LB,不依赖 MusicBrainz)。
     * ListenBrainz 对 scrobble 过的曲目会回填 track_metadata.mbid_mapping.recording_mbid,
     * 因此「推荐里正好听过的歌」无需 MB 也能换出曲名。最多 3 页 × 100 条,上限 100 个映射。
     */
    async function fetchListenMapping() {
      const out = new Map();
      const user = String(cfg().username || "").trim();
      if (!user) return out;
      for (let offset = 0; offset < 300 && out.size < 100; offset += 100) {
        let data = null;
        try {
          data = await httpGetJson(`${apiBase()}/1/user/${encodeURIComponent(user)}/listens?count=100&offset=${offset}`);
        } catch (e) { break; } // 拉取失败即停,不阻断主流程
        const arr = (data && data.payload && Array.isArray(data.payload.listens)) ? data.payload.listens : [];
        if (!arr.length) break;
        for (const l of arr) {
          const tm = (l && l.track_metadata) || {};
          const mbid = (tm.mbid_mapping && tm.mbid_mapping.recording_mbid) ||
            (tm.additional_info && tm.additional_info.recording_mbid);
          if (!mbid || out.has(mbid)) continue;
          const title = String(tm.track_name || "").trim();
          const artist = String(tm.artist_name || "").trim();
          if (!title || !artist) continue;
          const dur = Number((tm.additional_info && tm.additional_info.duration_ms) || 0);
          out.set(mbid, {
            mbid,
            title,
            artist,
            album: String(tm.release_name || "").trim(),
            duration: dur > 0 ? dur : null,
          });
        }
      }
      return out;
    }

    /**
     * 批量换 MBID → 曲目信息。按传入 mbid 顺序返回 {mbid,title,artist,album,duration}。
     * 三级换名(前两级直连可达,不依赖 MusicBrainz 也有保底):
     *   1) 用户收听历史 listens 的 recording_mbid 映射(本插件 scrobble 过的歌,LB 会回填
     *      mbid_mapping;覆盖「推荐里正好听过的歌」);
     *   2) LB metadata 批量换名(精确);
     *   3) 仍未换出的按推荐序取前 N 个走 MusicBrainz 单曲接口兜底(带预算+fail-fast)。
     */
    async function fetchMetadata(mbids) {
      const byMbid = new Map();
      const excludeListened = cfg().excludeListened === true;

      // 1) 先建收听历史映射(直连,1~3 个请求):命中即补进 byMbid;
      //    excludeListened 开启时,命中历史 = 已听过 → 不放进歌单(只留新歌)。
      const listenMap = await fetchListenMapping();
      for (const [mbid, meta] of listenMap) {
        if (excludeListened) continue;
        if (!byMbid.has(mbid)) byMbid.set(mbid, meta);
      }

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

      // 前两级换出名 → byMbid;仍未换出 → unnamed(按推荐顺序)。只对 unnamed 走 MusicBrainz
      // 兜底(用 MB 的 title 使推荐条目不被丢弃);named 的 LB 结果已含 title/artist/album,
      // 不再调 MB 覆盖(收益低,且串行请求会拖爆 15s 调用超时)。
      // excludeListened 开启时,收听历史命中的 MBID(已听过)不参与兜底,同样排除。
      const unnamed = mbids
        .filter((m) => !byMbid.has(m.mbid) && !(excludeListened && listenMap.has(m.mbid)))
        .map((m) => ({ mbid: m.mbid }));
      // 兜底带预算(10s)+ maxItems(12) + fail-fast + 单曲重试,保证 runDailyJob 整体在 15s 内返回。
      const mbUnnamed = await fetchMusicBrainzMeta(unnamed, { maxItems: 12, budgetMs: 10000 });

      const result = [];
      for (const m of mbids) {
        const lb = byMbid.get(m.mbid);
        if (lb) {
          // LB 已换出完整 title/artist/album,直接采用(不再经 MB 覆盖)。
          result.push(lb);
          continue;
        }
        const mb = mbUnnamed.get(m.mbid);
        if (mb && mb.title) {
          result.push({
            mbid: m.mbid,
            title: mb.title,
            artist: mb.artist || "",
            album: mb.album || "",
            duration: null,
          });
        }
      }
      return result;
    }

    const MB_RECORDING = "https://musicbrainz.org/ws/2/recording";

    /** 忙等 sleep(沙箱无 setTimeout):MusicBrainz 要求 ≤1 req/s,请求间间隔 1.1s。
     *  仅在上一次请求成功后才等待(失败的请求没打到 MB 配额,不浪费限流间隔)。 */
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
     * 对 LB 元数据换不出名的推荐 MBID,逐曲调 MusicBrainz 拿 title + artist-credit + releases。
     * title 用于兜底;artist/album 一并带回。
     * 保护(否则 runDailyJob 整体超 15s 被宿主中断,手动刷新报 500):
     *   - maxItems:只兜底推荐分最高的前 N 个;
     *   - budgetMs:总时间预算,超时立即收手;
     *   - 单曲失败重试 1 次(网络抖动/5xx 可救回;4xx 不重试);
     *   - 连续失败 ≥3 次视为 MusicBrainz 不可达,整体放弃(fail-fast);
     *   - 单请求 timeout 6s;仅成功请求后限流 sleep,失败不等待。
     * @returns {Promise<Map<string,{title:string,artist:string,album:string}>>}
     */
    async function fetchMusicBrainzMeta(items, { maxItems = 12, budgetMs = 10000 } = {}) {
      const out = new Map();
      const list = (items || []).slice(0, maxItems);
      const t0 = Date.now();
      let lastOk = false;       // 上一次请求是否成功(成功后才限流 sleep)
      let consecutiveFails = 0; // 连续失败计数(fail-fast)
      for (let i = 0; i < list.length; i++) {
        if (Date.now() - t0 >= budgetMs) break; // 预算闸:超时立即收手
        if (consecutiveFails >= 3) break;       // fail-fast:MB 不可达时快速放弃
        const it = list[i];
        if (i > 0 && lastOk) mbSleep(); // 首请求前不等待;仅成功后间隔 1.1s(≤1 req/s)
        const url = MB_RECORDING + "/" + encodeURIComponent(it.mbid) + "?inc=artist-credits+releases&fmt=json";
        let ok = false;
        // 单曲最多 2 次尝试:4xx 立即放弃(改错名重试无意义);网络失败(status:0)/5xx 重试 1 次。
        for (let attempt = 0; attempt < 2 && !ok && Date.now() - t0 < budgetMs; attempt++) {
          try {
            const r = await host.http(url, {
              method: "GET",
              headers: { Accept: "application/json", "User-Agent": "MusicFlow/1.0 (listenbrainz plugin; https://github.com/ray5378/MusicFlow)" },
              timeout: 6000,
              ...proxyFlag(),
            });
            if (r && r.ok) {
              const d = JSON.parse(r.body || "{}");
              const ac = Array.isArray(d["artist-credit"]) ? d["artist-credit"] : [];
              const names = [];
              for (const a of ac) {
                const n = String((a && (a.name || (a.artist && a.artist.name))) || "").trim();
                if (n) names.push(n);
              }
              const album = pickAlbumTitle(d.releases);
              const title = String(d.title || "").trim();
              // MB 单曲接口本身返回 title;署名名/专辑/曲名任一有值即纳入(供 LB 无名项兜底)。
              if (title || names.length || album) out.set(it.mbid, { title, artist: names.join(" / "), album });
              ok = true;
            } else {
              const status = r && r.status;
              if (typeof status === "number" && status >= 400 && status < 500) break; // 4xx 不重试
              // 网络失败(status:0)或 5xx:进入下一次尝试
            }
          } catch (e) { /* 网络异常:进入下一次尝试 */ }
        }
        lastOk = ok;
        if (ok) consecutiveFails = 0;
        else consecutiveFails++;
      }
      return out;
    }

    /** 本地曲库匹配(歌名+歌手硬,时长/专辑软性择优),命中返回 songId。 */
    async function matchLocal(title, artist, album, durationMs) {
      const norm = (s) => String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, "");
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
        // 时长软:双方均可比且差 ≤5s 加分(元数据无时长时自动跳过)。
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
      // 在线补全:配合 manifest.longRunning + 主项目 v1.7.47 软看门狗(批量任务无墙钟,
      // 等网络/DB 无限合法)→ 不再设预算闸,一次任务尽量把所有推荐歌在线补全完
      // (无限封面/歌词);仍失败的歌改外部占位,由 upsert 后自动触发的后台
      // auto-match(主进程)继续补全为可播条目 → 零质量损失。
      for (const m of meta) {
        // 1) 本地曲库匹配
        const localId = await matchLocal(m.title, m.artist, m.album, m.duration);
        if (localId) {
          entries.push({ songId: localId });
          coverCandidates.push(localId);
          continue;
        }
        // 2) 在线源补全(go-music-dl 等已启用 source);失败走外部占位
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
        // 3) 都失败/超预算:保留为外部不可播条目(由后台 auto-match 补全为可播)
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
            ...proxyFlag(),
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
