# 插件发版流程

## 核心原则

- **发版必须是 CI 全绿后自动触发**，禁止手动打包和创建 Release
- 推送代码到 master → CI 自动校验 → 校验通过后自动发版
- 发版流程由 `.github/workflows/release.yml` 自动完成

## 前置要求

- 代码通过 CI 校验（`node scripts/check.mjs <插件id>`）
- 确保以下文件版本号**一致**：
  - `plugins/<id>/index.js` 中的 `manifest.version`
  - `plugins/<id>/plugin.json` 中的 `version`
- 确保 `downloadUrl` 与版本号匹配：
  - `https://github.com/ray5378/MusicFlow-plugins/releases/download/<id>-v<版本号>/<id>.tar.gz`

**关键字段一致性检查清单：**

| 字段 | 必须一致的文件 |
|------|--------------|
| `version` | `index.js` manifest ↔ `plugin.json` |
| `downloadUrl` | `plugin.json` → tag 必须为 `<id>-v<version>` |
| `capabilities` | `index.js` manifest ↔ `plugin.json` |
| `platforms` | `index.js` manifest ↔ `plugin.json` |
| `platformLabels` | `index.js` manifest ↔ `plugin.json` |
| `sourcePreference` | `index.js` manifest ↔ `plugin.json` |
| `recommendPrefix` | `index.js` manifest ↔ `plugin.json` |

## 发版步骤

### 1. 本地校验

```bash
node scripts/check.mjs <id>
```

**必须本地校验通过才能提交**，避免 CI 失败。

### 2. 提交并推送代码

```bash
git add plugins/<id>/
git commit -m "feat(<id>): 变更描述 (v<版本号>)"
git push origin master
```

### 3. ✅ CI 自动校验 → 自动发版

推送后，GitHub Actions 自动执行：

1. **plugin-spec**（`ci.yml`）：运行 `node scripts/check.mjs` 校验插件契约
2. **auto-release**（`release.yml`）：plugin-spec 通过后，自动：
   - 读取 `plugin.json` 中的 `version`
   - 检查该版本 Release 是否已存在（防重复）
   - 打包为 `tar.gz`
   - 创建 Git Tag（`<id>-v<版本号>`）
   - 创建 GitHub Release 并上传资产

**无需手动执行打包、打 Tag、创建 Release 等操作。**

### 4. 验证

在 GitHub Releases 页面检查：
- Release 名称和版本号是否正确
- 资产文件（`<id>.tar.gz`）是否已上传

## 完整示例（go-music-dl v1.2.36）

```bash
# 1. 本地校验（必须通过）
node scripts/check.mjs go-music-dl

# 2. 提交并推送（后续由 CI 自动完成）
git add plugins/go-music-dl/
git commit -m "feat(go-music-dl): 变更描述 (v1.2.36)"
git push origin master
```

## 常见问题

### CI 校验失败怎么办？

```bash
# 本地复现
node scripts/check.mjs <id>

# 修复错误后重新提交，CI 会重新运行
git add plugins/<id>/
git commit -m "fix(<id>): 修复描述"
git push origin master
```

### 安装后版本号不对

检查 `index.js` 的 `manifest.version` 是否与 `plugin.json` 一致。插件系统加载时以 `index.js` 的 manifest 为准。

### 安装提示 HTTP 404

检查 `downloadUrl` 中的 tag 是否与 Release tag 一致。例如 `plugin.json` 中 version 为 `1.2.36`，则 downloadUrl 应为：
```
https://github.com/ray5378/MusicFlow-plugins/releases/download/go-music-dl-v1.2.36/go-music-dl.tar.gz
```
且 Release tag 必须为 `go-music-dl-v1.2.36`。

### 配置项不显示

检查 `index.js` 的 `manifest.configSchema` 中是否包含该配置项。前端配置页由 `index.js` 的 manifest 驱动，`plugin.json` 仅用于市场展示。

### 重复发版

如果对同一版本多次推送，release.yml 会检测到 Release 已存在并自动跳过，不会重复创建。