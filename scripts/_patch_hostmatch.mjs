// 一次性迁移脚本:6 个插件的 matchLocal 前插 host.songs.match 快速路径 +
// 版本/downloadUrl 升级。行尾无关(\r?\n),带断言。
import fs from "node:fs";

const FASTPATH =
  '\n      // 快速路径:宿主统一匹配器(host.songs.match,核心 v2.3.9+;与「加入库」导入前\n' +
  '      // 匹配同源同语义,四维评分由核心统一维护)。宿主侧带索引缓存,逐首调用开销低;\n' +
  '      // 旧宿主无此 API 时回退下方本地实现,行为不变。\n' +
  '      try {\n' +
  '        if (host.songs && typeof host.songs.match === "function") {\n' +
  '          var hostHit = await host.songs.match([{ title: title, artist: artist, album: album, duration: durationMs > 0 ? Math.round(durationMs / 1000) : 0 }]);\n' +
  '          if (Array.isArray(hostHit)) return hostHit[0] || null;\n' +
  '        }\n' +
  '      } catch (e) { /* 回退本地匹配 */ }';

const PLUGINS = [
  { id: "kugou-chart", from: "1.6.9", to: "1.7.0" },
  { id: "netease-chart", from: "1.6.9", to: "1.7.0" },
  { id: "qq-chart", from: "1.6.9", to: "1.7.0" },
  { id: "lastfm", from: "1.0.8", to: "1.0.9" },
  { id: "listenbrainz", from: "1.5.13", to: "1.5.14" },
  { id: "go-music-dl", from: "1.6.5", to: "1.6.6" },
];

for (const p of PLUGINS) {
  const idxPath = "plugins/" + p.id + "/index.js";
  const pjPath = "plugins/" + p.id + "/plugin.json";
  let idx = fs.readFileSync(idxPath, "utf-8");
  if (idx.includes("host.songs.match")) { console.log(p.id, "already patched"); continue; }
  const sigRe = /(    async function matchLocal\([^)]*\) \{)/g;
  const sigs = [...idx.matchAll(sigRe)];
  if (sigs.length !== 1) throw new Error(p.id + ": expect exactly 1 matchLocal signature, got " + sigs.length);
  idx = idx.replace(sigRe, "$1" + FASTPATH);
  if (!idx.includes('version: "' + p.from + '"')) throw new Error(p.id + " index.js missing version " + p.from);
  idx = idx.split('version: "' + p.from + '"').join('version: "' + p.to + '"');
  // downloadUrl 版本一律重写为目标版本(历史漂移的旧版本号也一并修正)
  idx = idx.replace(new RegExp("(" + p.id + "-v)[0-9.]+(/)"), "$1" + p.to + "$2");
  fs.writeFileSync(idxPath, idx);

  let pj = fs.readFileSync(pjPath, "utf-8");
  if (!pj.includes('"version": "' + p.from + '"')) throw new Error(p.id + " plugin.json missing version " + p.from);
  pj = pj.split('"version": "' + p.from + '"').join('"version": "' + p.to + '"');
  pj = pj.replace(new RegExp("(" + p.id + "-v)[0-9.]+(/)"), "$1" + p.to + "$2");
  fs.writeFileSync(pjPath, pj);
  console.log(p.id, p.from, "->", p.to, "patched");
}
console.log("ALL DONE");
