#!/usr/bin/env node
// daily-rec-platform §4b CryptoOrchestrator KAT 对拍(零依赖 node 脚本)。
//
// oracle = tests/ref/ne-crypto.js / qq-crypto.js(上游参考件,node crypto 版)。
// 插件编排(经 host.crypto 十原语 shim,语义与主仓 pluginCrypto.ts 严格一致)
// 的 weapi / ag-1 / zzcSign 输出必须与 oracle **逐字节一致**:
//   - weapi:随机 secretKey 用同起点 LCG 种子 Math.random 分别驱动两侧,产出
//     相同 16 位密钥后逐字节比对 params/encSecKey(RSA padding:'none' hex);
//   - ag-1:固定 IV(12B utf8)下 encryptRequest 逐字节比对;响应 XOR 链 roundtrip;
//   - zzcSign:多载荷(含中文)逐字节比对 + 钉死固定向量(tests/zzc-fixtures.json,
//     首跑生成、入库,此后任何漂移即红)。
// 沙箱等价性:插件 index.js 在 node:vm(无 atob/btoa/TextDecoder/require)中加载,
// 证明编排不依赖沙箱缺失能力。
//
// 用法:node tests/crypto-kat.mjs   (退出码 0=全过)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

// ---------------- host.crypto shim(与主仓 pluginCrypto.ts 语义一致) ----------------
function makeHostCrypto() {
  const encErr = (m) => ({ error: m });
  return {
    md5: (s) => crypto.createHash("md5").update(String(s ?? ""), "utf8").digest("hex"),
    sha1: (s) => crypto.createHash("sha1").update(String(s ?? ""), "utf8").digest("hex"),
    sha256: (s) => crypto.createHash("sha256").update(String(s ?? ""), "utf8").digest("hex"),
    randomBytes: (n) => crypto.randomBytes(Number(n)).toString("hex"),
    aesEncrypt: (o) => {
      try {
        const dec = (v, e) => e === "hex" ? Buffer.from(String(v), "hex") : Buffer.from(String(v), "utf8");
        const data = dec(o.data, o?.dataEncoding ?? "utf8");
        const key = dec(o.key, o?.keyEncoding ?? "utf8");
        if (key.length !== 16) return encErr(`aes key 必须 16 字节(实际 ${key.length})`);
        if (o.mode === "gcm") {
          const iv = o.iv ? dec(o.iv, o?.ivEncoding ?? "utf8") : crypto.randomBytes(12);
          if (iv.length !== 12) return encErr(`gcm iv 必须 12 字节(实际 ${iv.length})`);
          const c = crypto.createCipheriv("aes-128-gcm", key, iv, { authTagLength: 16 });
          const ct = Buffer.concat([c.update(data), c.final()]);
          return Buffer.concat([iv, ct, c.getAuthTag()]).toString(o.outputEncoding ?? "base64");
        }
        if (o.mode === "cbc") {
          const iv = o.iv ? dec(o.iv, o?.ivEncoding ?? "utf8") : null;
          const c = crypto.createCipheriv("aes-128-cbc", key, iv);
          const out = Buffer.concat([c.update(data), c.final()]);
          return (o.outputEncoding ?? "hex") === "base64" ? out.toString("base64") : out.toString("hex");
        }
        if (o.mode === "ecb") {
          const c = crypto.createCipheriv("aes-128-ecb", key, null);
          const out = Buffer.concat([c.update(data), c.final()]);
          return (o.outputEncoding ?? "hex") === "base64" ? out.toString("base64") : out.toString("hex");
        }
        return encErr("未知 mode");
      } catch (e) { return encErr("aesEncrypt 失败: " + (e?.message || e)); }
    },
    rsaEncrypt: (o) => {
      try {
        const data = Buffer.from(String(o.data ?? ""), "utf8");
        let padded = data;
        if ((o.padding ?? "pkcs1") === "none") {
          padded = Buffer.alloc(128);
          data.copy(padded, 128 - data.length);
        }
        const out = crypto.publicEncrypt({ key: String(o.publicKey), padding: crypto.constants.RSA_NO_PADDING }, padded);
        return (o.outputEncoding ?? "hex") === "base64" ? out.toString("base64") : out.toString("hex");
      } catch (e) { return encErr("rsaEncrypt 失败: " + (e?.message || e)); }
    },
    base64Encode: (s, o) => {
      const e = o?.inputEncoding ?? "utf8";
      let buf;
      if (e === "latin1") {
        buf = Buffer.alloc(s.length);
        for (let i = 0; i < s.length; i++) { const cp = s.charCodeAt(i); if (cp > 0xff) return encErr("latin1 含 >0xFF 码点"); buf[i] = cp; }
      } else if (e === "hex") {
        if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) return encErr("非法 hex");
        buf = Buffer.from(s, "hex");
      } else buf = Buffer.from(String(s), "utf8");
      return buf.toString("base64");
    },
    base64Decode: (s) => {
      const compact = String(s).replace(/[ \t\r\n\f\v]/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) return encErr("不是合法的 base64 字符串");
      return Buffer.from(compact, "base64").toString("latin1");
    },
    utf8Decode: (s, o) => {
      const buf = (o?.inputEncoding ?? "latin1") === "hex" ? Buffer.from(String(s), "hex") : Buffer.from(String(s), "latin1");
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf); }
      catch { return encErr("不是合法的 UTF-8 序列"); }
    },
  };
}

// ---------------- 载入插件(node:vm,无 atob/btoa/TextDecoder/require) ----------------
const pluginCode = fs.readFileSync(path.join(ROOT, "plugins", "daily-rec-platform", "index.js"), "utf8");
const ctx = {
  console, JSON, Math, Date, Promise, Symbol, RegExp, Map, Set, Error, TypeError,
  String, Number, Boolean, Array, Object, parseInt, parseFloat, isFinite, isNaN,
  encodeURIComponent, decodeURIComponent, URLSearchParams, URL,
};
ctx.globalThis = ctx;
vm.runInNewContext(pluginCode, ctx, { filename: "daily-rec-platform/index.js" });

const storageMap = new Map();
const hostShim = {
  config: {},
  version: "4.3.1",
  log: () => {},
  crypto: makeHostCrypto(),
  storage: {
    get: async (k) => storageMap.get(k) ?? null,
    set: async (k, v) => void storageMap.set(k, v),
    delete: async (k) => void storageMap.delete(k),
    keys: async () => [...storageMap.keys()],
  },
  http: async () => ({ ok: false, status: 0, headers: {}, body: "", error: "KAT: no network" }),
  songs: {}, playlists: {}, sources: {}, comm: { on: () => {} },
};
const impl = ctx.__mfPlugin.create(hostShim);
const orch = new ctx.CryptoOrchestrator(hostShim); // 复用插件自己的编排器类

// ---------------- 上游参考件(oracle) ----------------
const ne = require(path.join(HERE, "ref", "ne-crypto.js"));
const qq = require(path.join(HERE, "ref", "qq-crypto.js"));

// 同起点 LCG:两侧各自重放同一 Math.random 序列 → 相同 secretKey。
function runWithLCG(fn) {
  let s = 42;
  const orig = Math.random;
  Math.random = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  try { return fn(); } finally { Math.random = orig; }
}

const SAMPLES = [
  { foo: "bar" },
  { csrf_token: "", limit: 30, total: true },
  { key: "abc123", type: 1 },
  { msg: "你好,世界 — MusicFlow" },
];
const IV12 = "123456789012"; // 12B utf8 固定 IV(KAT)
const ZZC_PAYLOADS = [
  JSON.stringify({ Comm: { ct: 19, cv: 1873 } }),
  JSON.stringify({ req_0: { module: "music.search.SearchCgiService", param: { query: "周杰伦 晴天" } } }),
  "plain-payload-42",
];

console.log("CryptoOrchestrator KAT 对拍(oracle = tests/ref/*.js):");

// (1) weapi:同 LCG 种子 secretKey 下逐字节一致。
for (const obj of SAMPLES) {
  const mine = await runWithLCG(() => orch.weapi(obj));
  const ref = runWithLCG(() => ne.weapi(obj));
  ok(mine.params === ref.params, `weapi params 一致 ${JSON.stringify(obj).slice(0, 30)}`);
  ok(mine.encSecKey === ref.encSecKey, `weapi encSecKey(RSA none/hex) 一致 ${JSON.stringify(obj).slice(0, 30)}`);
}

// (2) ag-1 encrypt:固定 IV 逐字节一致。
for (const obj of SAMPLES) {
  const mine = await orch.ag1Encrypt(obj, IV12);
  const ref = qq.encryptRequest(obj, IV12);
  ok(mine === ref, `ag1Encrypt(固定IV) 逐字节一致 ${JSON.stringify(obj).slice(0, 30)}`);
}

// (3) 响应 XOR 解密:decryptResponse = latin1 XOR(21B 响应密钥)。构造方式:
//     明文 UTF-8 字节 ⊕ 密钥 → base64 → 两侧解密都应还原原文(mine === ref === 明文)。
//     (encryptRequest 的 GCM 输出与 XOR 链无关——请求/响应是两套独立方案。)
const QQ_RESPONSE_KEY_HEX = "7a3f8c1d5e9b2f0a6c4d7e8b1f3a5c9d0e2b6f4a81"; // = ref RESPONSE_KEY_HEX
const respKeyBuf = Buffer.from(QQ_RESPONSE_KEY_HEX, "hex");
function xorToB64(text) {
  const pt = Buffer.from(text, "utf8");
  const xored = Buffer.alloc(pt.length);
  for (let i = 0; i < pt.length; i++) xored[i] = pt[i] ^ respKeyBuf[i % respKeyBuf.length];
  return xored.toString("base64");
}
for (const obj of SAMPLES) {
  const xoredB64 = xorToB64(JSON.stringify(obj));
  const mine = orch.ag1DecryptResponse(xoredB64);
  const refOut = qq.decryptResponse(xoredB64);
  ok(mine === refOut, `ag1DecryptResponse 与 ref 解密一致 ${JSON.stringify(obj).slice(0, 30)}`);
  ok(mine === JSON.stringify(obj), `ag1DecryptResponse 还原原文 ${JSON.stringify(obj).slice(0, 30)}`);
}

// (4) zzcSign:与 ref 逐字节一致。
for (const p of ZZC_PAYLOADS) {
  const mine = await orch.zzcSign(p);
  const ref = qq.zzcSign(p);
  ok(mine === ref, `zzcSign 一致 payload=${p.slice(0, 40)}`);
  ok(/^zzc[0-9a-z]+$/.test(mine), `zzcSign 形态合法(zzc 前缀小写) payload=${p.slice(0, 40)}`);
}

// (5) zzcSign 钉死向量:首跑生成入库,此后任何漂移即红。
{
  const fixturesPath = path.join(HERE, "zzc-fixtures.json");
  const fresh = {};
  for (const p of ZZC_PAYLOADS) fresh[p] = await orch.zzcSign(p);
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(fixturesPath, "utf8")); } catch {}
  if (existing) {
    for (const [p, v] of Object.entries(existing)) {
      ok(fresh[p] === v, `zzcSign 钉死向量稳定 ${p.slice(0, 40)}`);
    }
  } else {
    fs.writeFileSync(fixturesPath, JSON.stringify(fresh, null, 2) + "\n");
    console.log("  · 已生成钉死向量 tests/zzc-fixtures.json(入库,后续漂移即红)");
  }
}

// (6) 沙箱等价性 + impl 表面。
ok(typeof impl.startBind === "function" && typeof impl.pollBind === "function" && typeof impl.cancelBind === "function", "impl 暴露 startBind/pollBind/cancelBind");
ok(typeof impl.runDailyJob === "function" && typeof impl.search === "function", "impl 暴露 runDailyJob/search");

// (7) 跨桥铁律自证:插件**代码**(去注释后)不出现 require/import/atob/btoa/TextDecoder 等。
const pluginCodeStripped = pluginCode
  .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释剥离
  .split("\n").map((l) => {
    const i = l.indexOf("//");
    return i === -1 ? l : l.slice(0, i); // 行注释剥离(代码内不含字符串 "//")
  }).join("\n");
for (const token of ["require(", "import ", "atob(", "btoa(", "TextDecoder", "fetch(", "eval(", "new Function", "setTimeout", "setInterval"]) {
  ok(!pluginCodeStripped.includes(token), `index.js 无沙箱禁区字样「${token}」`);
}

if (failures) { console.error(`\nKAT 失败: ${failures} 项`); process.exit(1); }
console.log("\nKAT 全部通过。");
