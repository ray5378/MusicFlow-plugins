// 导入命中门禁契约校验(与 scripts/check.mjs 配套,发版前必须通过):
//
//   宿主(host.sources.complete)是所有在线补全的唯一咽喉——后端在该入口强制执行
//   「规范化标题 + 歌手 + 专辑(开关) + 时长容差」四维核实(SPEC §1.6.2)。插件侧的
//   契约是:调用 host.sources.complete 时必须透传 album 与 duration(秒,ms 需换算),
//   让宿主门禁有料可核。漏传 album/duration 的调用点在 albumRequired=true(默认开)
//   时会被门禁整批拒绝(候选缺字段 = 无法核实 = 宁可拒导)——线上表现是「补全全部
//   失败且无报错」,极难排查,故在此静态拦截。
//
// 校验规则:
//   1. index.js 中每一处 host.sources.complete({...}) 调用点,实参对象必须同时包含
//      album 与 duration 属性(缺一即失败,列出行号)。
//   2. 从未调用 host.sources.complete 的插件跳过(go-music-dl 等纯 source 型插件的
//      导入由宿主 importOnlineSong 驱动,门禁在宿主侧强制,插件无需调用)。
//
// 实现说明:先剥离注释与字符串字面量再扫描——documentation 字段里大量
// 「host.sources.complete({artist, title})」示例文本,不剥离会全部误报。
//
// 用法:node scripts/gate-check.mjs [插件id...]   (不传则校验全部)

import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

/** 剥离 JS 注释与字符串字面量,保留其余代码与换行(换行保留以维持行号)。 */
function stripCommentsAndStrings(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const d = i + 1 < n ? code[i + 1] : "";
    // 注释
    if (c === "/" && d === "/") {
      while (i < n && code[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && d === "*") {
      out += "  "; i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
        out += code[i] === "\n" ? "\n" : " "; i++;
      }
      if (i < n) { out += "  "; i += 2; }
      continue;
    }
    // 字符串字面量(单/双引号/模板串;沙箱插件代码不用正则字面量包这些标记)
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " "; i++;
      while (i < n) {
        if (code[i] === "\\") { out += "  "; i += 2; continue; }
        if (code[i] === quote) { out += " "; i++; break; }
        out += code[i] === "\n" ? "\n" : " "; i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** 从 stripped 的 start(指向 '{')开始取平衡花括号文本。失败返回 null。 */
function balancedBraces(text, start) {
  if (text[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const errors = [];
const checked = [];

const argIds = process.argv.slice(2);
const ids = argIds.length
  ? argIds
  : fs.readdirSync(path.join(ROOT, "plugins"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

for (const id of ids) {
  const file = path.join(ROOT, "plugins", id, "index.js");
  if (!fs.existsSync(file)) { errors.push(`[${id}] 缺少 index.js`); continue; }
  const stripped = stripCommentsAndStrings(fs.readFileSync(file, "utf8"));
  const callSites = [];
  const re = /host\s*\.\s*sources\s*\.\s*complete\s*\(/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    // 跳过紧跟 '{' 的不是对象实参的写法(如 host.sources.complete 被当值引用——
    // 后随 '(' 之后若无 '{' 也记为调用点并要求人工确认,按缺字段报错)。
    let j = m.index + m[0].length;
    while (j < stripped.length && /\s/.test(stripped[j])) j++;
    const braceIdx = stripped[j] === "{" ? j : -1;
    if (braceIdx === -1) {
      const line = stripped.slice(0, m.index).split("\n").length;
      errors.push(`[${id}] 第 ${line} 行 host.sources.complete 调用未使用对象字面量实参,无法核验门禁字段,请改为 complete({ title, artist, album, duration }) 形式`);
      continue;
    }
    const obj = balancedBraces(stripped, braceIdx);
    const line = stripped.slice(0, m.index).split("\n").length;
    const hasAlbum = /\balbum\s*:/.test(obj);
    const hasDuration = /\bduration\s*:/.test(obj);
    if (!hasAlbum || !hasDuration) {
      const missing = [!hasAlbum && "album", !hasDuration && "duration"].filter(Boolean).join(" 与 ");
      errors.push(`[${id}] 第 ${line} 行 host.sources.complete 调用缺少 ${missing} 透传——门禁(albumRequired 默认开)将无法核实该候选,整批拒绝。请参照: complete({ artist, title, album: album || "", duration: durationMs > 0 ? Math.round(durationMs / 1000) : 0 })`);
    } else {
      callSites.push(line);
    }
  }
  if (callSites.length) checked.push(`${id}(${callSites.length} 处调用点: L${callSites.join(", L")})`);
  else console.log(`  - ${id}: 无 host.sources.complete 调用点(纯 source 型或导入由宿主驱动,跳过)`);
}

if (checked.length) {
  console.log(`门禁契约校验 ${ids.length} 个插件:`);
  for (const c of checked) console.log(`  ✓ ${c} — album + duration 透传齐备`);
}

if (errors.length) {
  console.error("\n门禁契约校验失败:");
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error("\n插件侧门禁契约:所有 host.sources.complete 调用必须透传 album 与 duration(秒),否则宿主四维门禁无法核实,线上将整批拒导且无报错。");
  process.exit(1);
}
console.log("\n门禁契约全部通过。");
