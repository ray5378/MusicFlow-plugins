#!/usr/bin/env bash
#
# 把 plugins/<id>/ 打包成可分发的 <id>.tar.gz，输出到 dist/。
#
# 产物是构建结果，不入库（见 .gitignore）：仓库只保留插件源码，
# tar 包作为 GitHub Release 资产分发。这样避免「仓库内 tar 与 Release
# 资产版本漂移」——只有一个权威副本。
#
# 用法：
#   bash scripts/pack.sh              # 打包全部插件
#   bash scripts/pack.sh go-music-dl  # 只打包指定插件
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/dist"
mkdir -p "$OUT"

# Windows 自带的是 BSD tar：`C:\...` 会被当成远程主机，反斜杠会被当成
# 转义符。用相对路径 + --force-local 规避（Linux/macOS 上同样能跑）。
TAR_OPTS=()
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) TAR_OPTS+=(--force-local) ;;
esac

pack_one() {
  local id="$1"
  local dir="plugins/$id"
  [ -f "$dir/plugin.json" ] || { echo "跳过 $id：缺少 plugin.json"; return; }

  local version
  version="$(node -e "process.stdout.write(require('./$dir/plugin.json').version)")"

  # 只打包运行时需要的文件；显式列出，避免把 dist/ 或临时文件裹进去。
  local files=(plugin.json index.js)
  [ -f "$dir/package.json" ] && files+=(package.json)

  rm -f "$OUT/$id.tar.gz"
  tar "${TAR_OPTS[@]}" -czf "dist/$id.tar.gz" -C "$dir" "${files[@]}"

  echo "打包完成: dist/$id.tar.gz  (v$version)"
  echo "  建议 Release tag: $id-v$version"
  tar -tzf "dist/$id.tar.gz" | sed 's/^/    /'
}

if [ $# -gt 0 ]; then
  for id in "$@"; do pack_one "$id"; done
else
  for dir in plugins/*/; do pack_one "$(basename "$dir")"; done
fi
