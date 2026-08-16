// 插件契约校验：在推送/发版前跑一遍，把「装进 MusicFlow 才发现不对」的问题提前暴露。
//
// 校验三层：
//   1. plugin.json 是否能通过 validateManifest(字段/类型/能力/权限白名单)
//   2. index.js 是否定义 globalThis.__mfPlugin(沙箱契约),且 manifest 与 plugin.json
//      id/version/capabilities 一致;create(dummyHost) 能否返回 impl
//   3. manifest 声明的每项能力，impl 是否真有对应方法
//      —— 这一层最关键：核心「只按 capabilities 分发」，声明缺失就永不被调用，
//         而这不会报错，只会静默失效(合并三插件前踩过的坑)。
//   4. downloadUrl 的 tag 是否与 version 一致(指错 tag 会在市场安装时 404)
//
// 用法：node scripts/check.mjs [插件id...]   (不传则校验全部)
//
// 沙箱契约说明：插件不再用 ESM export,而是在 QuickJS 沙箱里定义
// globalThis.__mfPlugin = { manifest, create(host) }。本脚本用 node:vm 模拟
// 沙箱环境(无 Node 能力,仅标准 JS + URL/URLSearchParams 兼容层),create(host)
// 用 dummy host 真实调用,校验 impl 方法存在性。

import fs from "fs";
import path from "path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

// 与 MusicFlow backend/src/plugins/discovery.ts 的白名单保持一致。
const VALID_TYPES = ["source", "importer", "recommender", "sync", "lyrics", "cover", "renderer", "scrobbler", "artist"];
const VALID_CAPS = [
  "search", "playlistSearch", "recommend", "playlistSongs", "stream", "lyrics", "webRotation",
  "playlistImport", "playlistFile", "dailyPlaylist", "localPlaylist",
  "recommendPlaylist",
  "playlistSync", "autoMatch",
  "lyricProvider", "coverProvider", "renderer", "scrobbler",
  "artistInfo",
];
// 与 backend/src/plugins/host.ts 的 KNOWN_PERMISSIONS 保持一致。
const KNOWN_PERMISSIONS = [
  "log", "storage", "net", "crypto", "command", "fs", "fs:music", "fs:external",
  "websocket", "jsenv",
  "songs:read", "songs:write", "playlists:read", "playlists:write", "inter-plugin",
];

// 能力 → impl 必须提供的方法(方法名取自核心的真实调用点)。
// anyOf 表示满足其一即可；未列出的能力由核心用配置驱动，不要求方法。
const CAP_METHODS = {
  search: ["search"],
  playlistSearch: ["searchPlaylists"],
  recommend: ["recommend"],
  playlistSongs: ["playlistSongs"],
  stream: ["streamUrl"],
  lyrics: ["lyricUrl"],
  lyricProvider: ["searchLyrics"],
  coverProvider: ["searchCover"],
  renderer: ["discover"],
  autoMatch: ["search"],
  scrobbler: { anyOf: ["onPlay", "onScrobble"] },
  // 与backend/src/plugins/sandbox.ts 的 CAP_METHODS 保持同步
  playlistImport: ["canHandle", "fetchPlaylist"],
  playlistFile: ["canHandleFile", "parseFile"],
  dailyPlaylist: ["runDailyJob"],
  localPlaylist: ["runDailyJob"],
  recommendPlaylist: ["runDailyJob"],
  playlistSync: ["runSyncJob"],
  // webRotation 无对应方法（核心 purge 逻辑触发，无需 impl 方法）
};

const errors = [];
const warnings = [];

function fail(id, msg) { errors.push(`[${id}] ${msg}`); }
function warn(id, msg) { warnings.push(`[${id}] ${msg}`); }

/** 复刻 validateManifest。返回错误字符串或 null。 */
function validateManifest(m) {
  if (!m || typeof m !== "object") return "manifest 必须是对象";
  if (typeof m.id !== "string" || !m.id) return "manifest.id 缺失";
  if (typeof m.name !== "string" || !m.name) return "manifest.name 缺失";
  if (typeof m.version !== "string" || !m.version) return "manifest.version 缺失";
  if (!VALID_TYPES.includes(m.type)) return `manifest.type 非法: ${m.type}`;
  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) return "manifest.capabilities 必须是非空数组";
  for (const c of m.capabilities) if (!VALID_CAPS.includes(c)) return `含非法能力: ${c}`;
  if (!Array.isArray(m.configSchema)) return "manifest.configSchema 必须是数组";
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) return "permissions 必须是数组";
    for (const p of m.permissions) {
      if (KNOWN_PERMISSIONS.includes(p) || p === "*") continue;
      if (p.endsWith(".*") && KNOWN_PERMISSIONS.some((k) => k.startsWith(p.slice(0, -2) + ":"))) continue;
      return `未知权限: ${p}`;
    }
  }
  return null;
}

async function checkOne(id) {
  const dir = path.join(ROOT, "plugins", id);
  const manifestPath = path.join(dir, "plugin.json");
  if (!fs.existsSync(manifestPath)) return fail(id, "缺少 plugin.json");
  if (!fs.existsSync(path.join(dir, "index.js"))) return fail(id, "缺少 index.js");

  let pj;
  try {
    pj = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return fail(id, `plugin.json 不是合法 JSON: ${e.message}`);
  }

  // 1) 清单本身
  const err = validateManifest(pj);
  if (err) fail(id, `plugin.json 校验失败: ${err}`);
  if (pj.id !== id) fail(id, `plugin.json 的 id(${pj.id}) 与目录名(${id}) 不一致`);
  if (!pj.downloadUrl) fail(id, "plugin.json 缺少 downloadUrl(市场无法安装)");

  // 2) downloadUrl 的 Release tag 必须跟 version 对得上，否则安装时 404
  if (pj.downloadUrl?.includes("/releases/download/")) {
    const expected = `${id}-v${pj.version}`;
    const tag = pj.downloadUrl.split("/releases/download/")[1]?.split("/")[0];
    if (tag !== expected) fail(id, `downloadUrl 的 tag(${tag}) 与版本不匹配,应为 ${expected}`);
  } else {
    warn(id, "downloadUrl 未指向 Release 资产(raw 有速率限制)");
  }

  // 3) index.js:在 node:vm 沙箱里执行(模拟 QuickJS 环境),读 __mfPlugin,调 create 拿 impl
  let manifest, impl;
  try {
    const code = fs.readFileSync(path.join(dir, "index.js"), "utf8");
    const ctx = {
      console, JSON, Math, Date, Promise, Symbol, RegExp, Map, Set, Error, TypeError,
      String, Number, Boolean, Array, Object, parseInt, parseFloat, isFinite, isNaN,
      encodeURIComponent, decodeURIComponent, URLSearchParams, URL,
    };
    ctx.globalThis = ctx;
    vm.runInNewContext(code, ctx, { filename: `${id}/index.js` });
    const plugin = ctx.__mfPlugin;
    if (!plugin || typeof plugin !== "object") {
      return fail(id, "index.js 未定义 globalThis.__mfPlugin(沙箱契约)");
    }
    manifest = plugin.manifest;
    const dummyHost = {
      config: {}, version: "1.3.0",
      http: async () => ({ ok: true, status: 200, headers: {}, body: "" }),
      storage: { get: async () => null, set: async () => {}, delete: async () => {}, keys: async () => [] },
      log: () => {}, comm: { send: () => {}, broadcast: () => {}, on: () => {} },
    };
    if (typeof plugin.create !== "function") return fail(id, "index.js 的 __mfPlugin 缺少 create(host)");
    impl = plugin.create(dummyHost);
    if (!impl || typeof impl !== "object") return fail(id, "create(host) 未返回 impl 对象");
  } catch (e) {
    return fail(id, `index.js 无法在沙箱中加载: ${e.message}`);
  }
  if (!manifest) return fail(id, "index.js 的 __mfPlugin 缺少 manifest");

  if (manifest.id !== pj.id) fail(id, `index.js 的 manifest.id(${manifest.id}) 与 plugin.json(${pj.id}) 不一致`);
  if (manifest.version !== pj.version) {
    fail(id, `index.js 的 version(${manifest.version}) 与 plugin.json(${pj.version}) 不一致`);
  }
  const capsA = [...(manifest.capabilities || [])].sort().join(",");
  const capsB = [...(pj.capabilities || [])].sort().join(",");
  if (capsA !== capsB) fail(id, `两处 capabilities 不一致:\n    index.js:    ${capsA}\n    plugin.json: ${capsB}`);

  // 4) 源插件平台类字段双处一致性(核心动态读 platformLabels/sourcePreference/recommendPrefix,
  //    两处不一致会导致「配置了但核心读到旧的」)
  for (const field of ["platforms", "platformLabels", "sourcePreference", "recommendPrefix"]) {
    const a = manifest[field];
    const b = pj[field];
    const na = JSON.stringify(a ?? null);
    const nb = JSON.stringify(b ?? null);
    if (na !== nb) fail(id, `两处 ${field} 不一致:\n    index.js:    ${na}\n    plugin.json: ${nb}`);
  }

  // 4) 每项能力都要有对应实现
  for (const cap of manifest.capabilities || []) {
    const need = CAP_METHODS[cap];
    if (!need) continue; // 该能力由核心用配置驱动，无需方法
    if (Array.isArray(need)) {
      for (const fn of need) {
        if (typeof impl[fn] !== "function") fail(id, `声明了能力 ${cap} 但 impl 缺少方法 ${fn}()`);
      }
    } else if (need.anyOf) {
      if (!need.anyOf.some((fn) => typeof impl[fn] === "function")) {
        fail(id, `声明了能力 ${cap} 但 impl 未提供 ${need.anyOf.join(" / ")} 中的任何一个`);
      }
    }
  }

  // 4.5) 冒烟调用：对「空参可安全跑」的方法实际调用一次(假 config + dummy host)。
  //      抓「方法存在但一调用就炸」的运行时错误——如 create 作用域里引用了未定义
  //      变量(ReferenceError)、解构错误等。纯存在性检查抓不到这类问题(go-music-dl
  //      v1.2.15 的 searchPlaylists 引用 manifest 未定义即为此类)。
  const SMOKE_SAFE = new Set([
    "search", "searchPlaylists", "recommend", "playlistSongs",
    "streamUrl", "lyricUrl", "searchLyrics", "searchCover", "test",
  ]);
  for (const cap of manifest.capabilities || []) {
    const need = CAP_METHODS[cap];
    const fns = need ? (Array.isArray(need) ? need : need.anyOf || []) : [];
    for (const fn of fns) {
      if (!SMOKE_SAFE.has(fn) || typeof impl[fn] !== "function") continue;
      try {
        const args = fn === "streamUrl" || fn === "lyricUrl" ? [{}, {}] : [{}, { query: "" }];
        await impl[fn](...args);
      } catch (e) {
        fail(id, `冒烟调用 ${fn}() 失败(方法存在但运行报错): ${e.message || e}`);
      }
    }
  }

  // 反向提醒：impl 有方法却没声明对应能力 → 核心永不会调用它（静默失效）
  const declared = new Set(manifest.capabilities || []);
  // 多个能力可能共享同一组方法(如 dailyPlaylist / localPlaylist / recommendPlaylist
  // 都要求 runDailyJob)——只要已声明其中一个,不再对同方法集的能力发反向提醒。
  const declaredMethodKeys = new Set();
  for (const cap of declared) {
    const need = CAP_METHODS[cap];
    const fns = need ? (Array.isArray(need) ? need : need.anyOf) : null;
    if (fns && fns.length) declaredMethodKeys.add([...fns].sort().join(","));
  }
  for (const [cap, need] of Object.entries(CAP_METHODS)) {
    if (declared.has(cap)) continue;
    const fns = Array.isArray(need) ? need : need.anyOf;
    // search 同时对应 search / autoMatch 两种能力，声明任一即可，避免误报
    if (cap === "autoMatch" && declared.has("search")) continue;
    if (cap === "search" && declared.has("autoMatch")) continue;
    if (fns && fns.length && declaredMethodKeys.has([...fns].sort().join(","))) continue;
    if (fns && fns.every((fn) => typeof impl[fn] === "function")) {
      warn(id, `impl 提供了 ${fns.join("/")}() 但未声明能力 ${cap},核心不会调用它`);
    }
  }

  console.log(`  ✓ ${id} v${pj.version} (${pj.type}) — ${(pj.capabilities || []).length} 项能力`);
}

const ids = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(path.join(ROOT, "plugins"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

console.log(`校验 ${ids.length} 个插件:`);
for (const id of ids) await checkOne(id);

if (warnings.length) {
  console.log("\n提醒:");
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (errors.length) {
  console.error("\n校验失败:");
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log("\n全部通过。");
