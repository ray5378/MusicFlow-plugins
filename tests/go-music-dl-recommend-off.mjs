#!/usr/bin/env node
// go-music-dl「关闭首页推荐」离线契约测试(零依赖 node 脚本)。
//
// 覆盖:
//   1) configSchema 里「首页推荐平台」(recommendPlatforms)下拉第一项是哨兵值 __off__,
//      中英文案都在(前端配置页由 index.js manifest 驱动,plugin.json 仅市场展示);
//   2) 勾选 __off__ → recommend() 直接返回 { channels: [] },且**一次网络请求都不发**
//      (不发 /music/recommend、不读写快照缓存);
//   3) 未勾选(未配置 / 空数组 / 只勾平台)保持历史语义:继续走上游抓取。
//
// 用法:node tests/go-music-dl-recommend-off.mjs   (退出码 0=全过)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/** 在 node:vm 中加载插件(模拟 QuickJS 沙箱环境,无 Node 能力)。 */
function loadPlugin(host) {
  const code = fs.readFileSync(path.join(ROOT, "plugins", "go-music-dl", "index.js"), "utf8");
  const ctx = {
    console, JSON, Math, Date, Promise, Symbol, RegExp, Map, Set, Error, TypeError,
    String, Number, Boolean, Array, Object, parseInt, parseFloat, isFinite, isNaN,
    encodeURIComponent, decodeURIComponent, URLSearchParams, URL,
  };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx, { filename: "go-music-dl/index.js" });
  const plugin = ctx.__mfPlugin;
  if (!plugin || typeof plugin.create !== "function") throw new Error("插件未定义 __mfPlugin.create");
  return { manifest: plugin.manifest, impl: plugin.create(host) };
}

/** 假 host:任何 http 都计数并抛错(代表「上游不可达」)。 */
function makeHost() {
  const calls = [];
  const storageOps = [];
  const host = {
    config: {},
    http: async (url, opts) => {
      calls.push({ url, opts });
      throw new Error("NETWORK-DISABLED");
    },
    storage: {
      get: async (k) => { storageOps.push(["get", k]); return null; },
      set: async (k) => { storageOps.push(["set", k]); },
      delete: async (k) => { storageOps.push(["delete", k]); },
    },
    log: () => {},
    songs: { list: async () => [] },
  };
  return { host, calls, storageOps };
}

const OFF = "__off__";

// ---------------- 1) configSchema 第一项 ----------------
{
  const { manifest } = loadPlugin(makeHost().host);
  const field = (manifest.configSchema || []).find((f) => f.key === "recommendPlatforms");
  ok(!!field, "configSchema 存在 recommendPlatforms 字段");
  const opts = field && field.options;
  ok(Array.isArray(opts) && opts.length > 0, "recommendPlatforms 有 options");
  ok(opts[0].value === OFF, "第一项是哨兵值 __off__(下拉第一位)");
  ok(opts[0].label === "关闭首页推荐", "第一项中文文案为「关闭首页推荐」");
  const en = manifest.i18n && manifest.i18n.en && manifest.i18n.en.fields
    && manifest.i18n.en.fields.recommendPlatforms;
  ok(!!en && en.options && en.options[OFF] === "Disable home recommendations",
    "英文 i18n 含 __off__ 文案");
  // 哨兵值不得与任何真实平台 id 冲突(否则会被当作平台过滤条件命中)
  ok(!(manifest.platforms || []).includes(OFF), "__off__ 不与真实平台 id 冲突");
}

// ---------------- 2) 勾选 __off__ → 不发请求、直接空频道 ----------------
{
  const { host, calls, storageOps } = makeHost();
  const { impl } = loadPlugin(host);
  const out = await impl.recommend({ baseUrl: "http://h:1", recommendPlatforms: [OFF] });
  ok(out && Array.isArray(out.channels) && out.channels.length === 0,
    "勾选 __off__ → { channels: [] }");
  ok(calls.length === 0, "勾选 __off__ → 零网络请求(不再请求 /music/recommend)");
  ok(storageOps.length === 0, "勾选 __off__ → 不读写快照缓存");
}
{
  // 同时勾了平台和 __off__:__off__ 优先级最高
  const { host, calls } = makeHost();
  const { impl } = loadPlugin(host);
  const out = await impl.recommend({ baseUrl: "http://h:1", recommendPlatforms: ["netease", OFF] });
  ok(out && out.channels.length === 0, "__off__ 与其它平台同时勾选 → 仍关闭(优先级最高)");
  ok(calls.length === 0, "__off__ 与其它平台同时勾选 → 零网络请求");
}

// ---------------- 3) 未勾选 → 保持历史语义(继续走上游) ----------------
for (const [name, cfg] of [
  ["未配置 recommendPlatforms", { baseUrl: "http://h:1" }],
  ["空数组(历史语义 = 全平台)", { baseUrl: "http://h:1", recommendPlatforms: [] }],
  ["只勾平台", { baseUrl: "http://h:1", recommendPlatforms: ["netease"] }],
  ["非数组(脏数据兜底)", { baseUrl: "http://h:1", recommendPlatforms: OFF }],
]) {
  const { host, calls } = makeHost();
  const { impl } = loadPlugin(host);
  const out = await impl.recommend(cfg);
  ok(Array.isArray(out.channels), name + " → 返回 channels 数组");
  ok(calls.length > 0, name + " → 仍走上游抓取(未被误关闭)");
}

if (failures) {
  console.error(`\n共 ${failures} 项失败。`);
  process.exit(1);
}
console.log("\n全部通过。");
