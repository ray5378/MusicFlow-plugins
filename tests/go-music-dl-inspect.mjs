#!/usr/bin/env node
// go-music-dl inspectSong(音质预探)离线契约测试(零依赖 node 脚本)。
//
// 覆盖:
//   1) 纯解析函数 parseSizeToBytes / parseBitrateKbps 对 /music/inspect 真实文本的换算
//      (服务端 core.FormatSize 恒产出 "%.1f MB";bitrate 为 "%d kbps" 或 "-");
//   2) inspectSong 的失败语义:网络失败 / 非 200 / JSON 解析失败 → null;
//      valid!=true 或缺 url → { valid:false };成功 → { valid:true, url, bytes, bitrateKbps };
//   3) 请求 URL 拼接:/music/inspect + id/source/duration(必带)+ extra 透传。
//
// 沙箱等价性:插件 index.js 在 node:vm(无 require/fs)中加载,证明逻辑不依赖沙箱缺失能力。
//
// 用法:node tests/go-music-dl-inspect.mjs   (退出码 0=全过)
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
  return plugin.create(host);
}

/** 构造一个可捕获请求 URL / 可编排响应的假 host。 */
function makeHost(responder) {
  const calls = [];
  const host = {
    config: {},
    http: async (url, opts) => {
      calls.push({ url, opts });
      return responder(url, opts);
    },
    storage: { get: async () => null, set: async () => {}, delete: async () => {} },
    log: () => {},
    songs: { list: async () => [] },
  };
  return { host, calls };
}

// ---------------- 1) 纯解析函数 ----------------
{
  const impl = loadPlugin(makeHost(() => ({ ok: true, status: 200, body: "{}" })).host);
  ok(typeof impl.parseSizeToBytes === "function", "impl 暴露 parseSizeToBytes()");
  ok(typeof impl.parseBitrateKbps === "function", "impl 暴露 parseBitrateKbps()");

  const sz = impl.parseSizeToBytes;
  ok(sz("2.0 MB") === 2097152, 'parseSizeToBytes("2.0 MB") === 2097152');
  ok(sz("51.9 MB") === 54421094, 'parseSizeToBytes("51.9 MB") === 54421094');
  ok(sz("1.5 GB") === 1610612736, 'parseSizeToBytes("1.5 GB") === 1610612736');
  ok(sz("1024 KB") === 1048576, 'parseSizeToBytes("1024 KB") === 1048576');
  ok(sz("512 B") === 512, 'parseSizeToBytes("512 B") === 512');
  ok(sz("2.0MB") === 2097152, "无空格也解析(2.0MB)");
  ok(sz(" 3.0 MB ") === 3145728, "首尾空白被 trim");
  ok(sz("0.5 MB") === 524288, 'parseSizeToBytes("0.5 MB") === 524288');
  ok(sz("-") === null, '解析不到("-")→ null');
  ok(sz("") === null, "空串 → null");
  ok(sz(null) === null, "null → null");
  ok(sz("abc") === null, "非法文本 → null");
  ok(sz("2.0 XB") === null, "未知单位 → null");

  const br = impl.parseBitrateKbps;
  ok(br("128 kbps") === 128, 'parseBitrateKbps("128 kbps") === 128');
  ok(br("1749 kbps") === 1749, 'parseBitrateKbps("1749 kbps") === 1749');
  ok(br("320 kbps") === 320, 'parseBitrateKbps("320 kbps") === 320');
  ok(br("-") === null, '解析不到("-")→ null');
  ok(br("0 kbps") === null, "0 kbps → null");
  ok(br("") === null, "空串 → null");
  ok(br(null) === null, "null → null");
  ok(br("unknown") === null, "非法文本 → null");
}

// ---------------- 2) inspectSong:成功路径 + 请求拼接 ----------------
{
  const body = JSON.stringify({ valid: true, url: "http://fs.example/x.mp3", size: "2.0 MB", bitrate: "128 kbps" });
  const { host, calls } = makeHost(() => ({ ok: true, status: 200, body }));
  const impl = loadPlugin(host);
  const cfg = { baseUrl: "http://192.168.10.240:18180/" }; // 带尾斜杠,应被 baseOf 去掉
  const song = { id: "abc123", source: "kugou", duration: 245, extra: { hash: "deadbeef" } };
  const out = await impl.inspectSong(cfg, song);
  ok(out && out.valid === true, "成功:valid === true");
  ok(out.url === "http://fs.example/x.mp3", "成功:返回 url");
  ok(out.bytes === 2097152, "成功:bytes 由 size 文本换算(2.0 MB → 2097152)");
  ok(out.bitrateKbps === 128, "成功:bitrateKbps 由 bitrate 文本换算(128 kbps → 128)");
  ok(calls.length === 1, "仅发起一次 host.http 调用");
  const u = calls[0].url;
  ok(u.startsWith("http://192.168.10.240:18180/music/inspect?"), "URL 前缀为 baseOf(config) + /music/inspect");
  ok(u.includes("id=abc123"), "URL 带 id");
  ok(u.includes("source=kugou"), "URL 带 source");
  ok(u.includes("duration=245"), "URL 带 duration(必带)");
  ok(u.includes("extra=") && decodeURIComponent(u.split("extra=")[1]) === '{"hash":"deadbeef"}', "URL extra 透传 JSON");
  ok(calls[0].opts && calls[0].opts.method === "GET", "GET 方法");
  ok(calls[0].opts && calls[0].opts.timeout === 8000, "timeout=8000");
}

// ---------------- 3) inspectSong:缺失 duration 也必传 0 ----------------
{
  const body = JSON.stringify({ valid: true, url: "http://x/y.mp3", size: "-", bitrate: "-" });
  const { host, calls } = makeHost(() => ({ ok: true, status: 200, body }));
  const impl = loadPlugin(host);
  const out = await impl.inspectSong({ baseUrl: "http://h:1" }, { id: "1", source: "netease" });
  ok(calls[0].url.includes("duration=0"), "缺失 duration → 传 duration=0");
  ok(out && out.valid === true, "valid 为 true");
  ok(!("bytes" in out), 'size "-" 解析不到 → 省略 bytes 键(不编造 0)');
  ok(!("bitrateKbps" in out), 'bitrate "-" 解析不到 → 省略 bitrateKbps 键');
}

// ---------------- 4) inspectSong:失败语义 ----------------
{
  // valid:false
  let { host } = makeHost(() => ({ ok: true, status: 200, body: JSON.stringify({ valid: false }) }));
  let impl = loadPlugin(host);
  let out = await impl.inspectSong({ baseUrl: "http://h:1" }, { id: "1", source: "qq" });
  ok(out && out.valid === false, '服务端 {"valid":false} → { valid:false }');

  // valid:true 但无 url
  ({ host } = makeHost(() => ({ ok: true, status: 200, body: JSON.stringify({ valid: true, size: "2.0 MB", bitrate: "128 kbps" }) })));
  impl = loadPlugin(host);
  out = await impl.inspectSong({ baseUrl: "http://h:1" }, { id: "1", source: "qq" });
  ok(out && out.valid === false, "valid:true 但缺 url → { valid:false }");

  // 非 200
  ({ host } = makeHost(() => ({ ok: false, status: 500, body: "err" })));
  impl = loadPlugin(host);
  out = await impl.inspectSong({ baseUrl: "http://h:1" }, { id: "1", source: "qq" });
  ok(out === null, "非 200 → null");

  // 网络失败(host.http 抛错)
  ({ host } = makeHost(() => { throw new Error("ECONNREFUSED"); }));
  impl = loadPlugin(host);
  out = await impl.inspectSong({ baseUrl: "http://h:1" }, { id: "1", source: "qq" });
  ok(out === null, "host.http 抛错 → null(不外抛)");

  // JSON 解析失败
  ({ host } = makeHost(() => ({ ok: true, status: 200, body: "<html>not json</html>" })));
  impl = loadPlugin(host);
  out = await impl.inspectSong({ baseUrl: "http://h:1" }, { id: "1", source: "qq" });
  ok(out === null, "JSON 解析失败 → null");

  // 缺 baseUrl
  ({ host } = makeHost(() => ({ ok: true, status: 200, body: "{}" })));
  impl = loadPlugin(host);
  out = await impl.inspectSong({}, { id: "1", source: "qq" });
  ok(out === null, "未配置 baseUrl → null");

  // 缺 id/source
  ({ host } = makeHost(() => ({ ok: true, status: 200, body: "{}" })));
  impl = loadPlugin(host);
  out = await impl.inspectSong({ baseUrl: "http://h:1" }, { source: "qq" });
  ok(out && out.valid === false, "缺 id → { valid:false }");
}

if (failures) {
  console.error(`\n共 ${failures} 项失败。`);
  process.exit(1);
}
console.log("\n全部通过。");
