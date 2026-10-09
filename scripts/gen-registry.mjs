#!/usr/bin/env node
/**
 * registry.json 自动生成器(CI 权威,手工编辑会被覆盖):
 *   - 扫描 plugins 下每个目录的 plugin.json,生成市场清单,按 id 字典序排序(稳定输出防 churn);
 *   - 无 plugin.json 的目录跳过并 warn;id 与目录名不一致 → 报错退出 1;
 *   - **删除的插件目录自动从清单消失**(自动生成的天然性质,无需手工清理条目);
 *   - URL/homepage base 优先取 process.env.GITHUB_REPOSITORY(CI 环境自带),
 *     本地缺省回落 ray5378/MusicFlow-plugins;
 *   - 输出 2 空格缩进 + LF + 末尾换行;重复运行零 diff(幂等)。
 * 用法:node scripts/gen-registry.mjs   (可在仓库根任意 cwd 下运行)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url)); // scripts/ 上一级 = 仓库根
const PLUGINS_DIR = join(ROOT, "plugins");
const OUT = join(ROOT, "registry.json");
const FALLBACK_REPO = "ray5378/MusicFlow-plugins";

// GITHUB_REPOSITORY 形如 "owner/repo";本地/非 CI 环境无此变量或缺斜杠 → 回落。
const repo =
  typeof process.env.GITHUB_REPOSITORY === "string" &&
  process.env.GITHUB_REPOSITORY.includes("/")
    ? process.env.GITHUB_REPOSITORY
    : FALLBACK_REPO;

// 收集合法插件 id:目录名即 id(与 plugin.json.id 强一致,不一致直接失败)。
const ids = [];
for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(PLUGINS_DIR, entry.name, "plugin.json");
  if (!existsSync(manifestPath)) {
    console.warn(`WARN: plugins/${entry.name}/ 无 plugin.json,跳过`);
    continue;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error(`FAIL: plugins/${entry.name}/plugin.json 解析失败: ${e.message}`);
    process.exit(1);
  }
  if (manifest.id !== entry.name) {
    console.error(
      `FAIL: plugins/${entry.name}/plugin.json id="${manifest.id}" 与目录名不一致`
    );
    process.exit(1);
  }
  ids.push(manifest.id);
}

// 字典序:用默认 UTF-16 码元排序(不用 localeCompare,跨机器稳定)。
ids.sort();

const registry = {
  name: "MusicFlow 官方插件市场",
  homepage: `https://github.com/${repo}`,
  plugins: ids.map(
    (id) => `https://raw.githubusercontent.com/${repo}/master/plugins/${id}/plugin.json`
  ),
};

writeFileSync(OUT, JSON.stringify(registry, null, 2) + "\n", "utf8");
console.log(`OK registry.json: ${ids.length} 个插件 [${ids.join(", ")}]`);
