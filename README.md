# MusicFlow-plugins

MusicFlow V2（插件化重构分支 [MusicFlow-V2](https://github.com/ray5378/MusicFlow-V2)）的**官方插件分发仓库**。

本仓库托管以「外置 drop-in 插件」形式分发的官方插件，通过 V2 后端的**插件市场**一键安装，
不再随后端二进制内置。

> **先决条件**：需要先部署 [MusicFlow-V2](https://github.com/ray5378/MusicFlow-V2)（≥ 1.3.0，
> 沙箱运行时；推荐用最新版）。部署方式（docker compose / HA 加载项 / 裸跑）、版本配套表、
> 环境变量与 HA 生态见**主项目 README**：
> [`MusicFlow-V2/README.md`](https://github.com/ray5378/MusicFlow-V2/blob/master/README.md)。
> 本仓库的插件通过 V2「插件」页的市场一键安装，**不需要手动下载/解压**。

> 说明：V2 的「核心插件」（QQ/网易云/本地歌单导入、每日推荐、本地推荐、歌单同步、DLNA 投屏）
> 仍随后端内置，开箱即用。与 go-music-dl 相关的官方能力（源 / 歌词 / 封面）全部合并为
> **单个**外置插件 `go-music-dl`，不再随后端内置，也不再拆成三个插件。

## 当前托管的插件

| 插件 | 版本 | 类型 | 说明 |
| --- | --- | --- | --- |
| [`go-music-dl`](plugins/go-music-dl) | 1.2.0 | source（含 lyricProvider + coverProvider） | 三合一：通过局域网已部署的 [go-music-dl](https://github.com/gogodjzhu/go-music-dl) 服务搜索全网音乐、获取推荐歌单、流式播放，并为在线歌曲提供 LRC 歌词与封面。源 / 歌词 / 封面共用同一份服务地址配置 |
| [`listenbrainz`](plugins/listenbrainz) | 1.1.0 | scrobbler | 把播放记录上报到 [ListenBrainz](https://listenbrainz.org)（开源的 Last.fm 替代品）。支持「正在播放」实时状态与正式收听记录，可指向自建实例。不用这类服务的话无需安装 |

> 两个插件均运行于 **QuickJS 沙箱**（需要 V2 ≥ 1.3.0 的沙箱运行时，见 manifest 的 `minAppVersion`）。

> 2026-08-12 起，`go-music-dl-lyrics` 与 `go-music-dl-cover` 两个独立插件已合并进
> `go-music-dl`（单个 manifest 声明全部能力，单个 impl 实现全部方法）。如果你之前分别安装了
> 这三个插件，建议卸载 `go-music-dl-lyrics` / `go-music-dl-cover`，只保留 `go-music-dl` 即可。

## 在 MusicFlow V2 中安装

1. 打开 V2 后台 → **插件** → **插件市场** 标签页。
2. 官方注册表**已由 V2 首次启动时自动添加**，无需手动粘贴：
   ```
   https://raw.githubusercontent.com/ray5378/MusicFlow-plugins/master/registry.json
   ```
   如果你删掉过它（V2 不会自动加回，这是刻意设计），在「注册表」里手动添加上面的地址即可。
   离线 / 内网部署可用环境变量 `MUSICFLOW_OFFICIAL_REGISTRY` 换成自建镜像，或置空以完全关闭自动添加。
3. 市场列表会出现 `go-music-dl 全网聚合`，点击 **安装**。
4. 安装后在「已安装」里填入你的 go-music-dl 服务地址（`baseUrl`）并启用即可。源 / 歌词 / 封面
   共用这一个地址，无需重复填写。

> 安装走的是 V2 的 `installPlugin`：下载 `plugin.json` 里的 `downloadUrl` 压缩包 → 解压到
> `data/plugins/<id>/` → 自动发现、免重启生效。

## 插件目录结构

每个插件一个目录，约定如下：

```
plugins/<id>/
  plugin.json     # 插件清单(manifest),市场只读它来展示元数据
  index.js        # 沙箱契约: 纯 JS,globalThis.__mfPlugin = { manifest, create(host) }
  package.json    # {"type":"module"},兼容性保留(沙箱加载实际不读它)
```

分发用的 `<id>.tar.gz` **不入库**：它由 `scripts/pack.sh` 生成到 `dist/`（已 gitignore），
作为 GitHub Release 资产分发。这样全仓库只有一个权威副本，不会出现「仓库内 tar 比 Release
资产旧」的版本漂移。

## 分发方式

| 内容 | 位置 | 原因 |
| --- | --- | --- |
| `registry.json`、`plugin.json` | raw.githubusercontent.com | 体积小、需要稳定不变的 URL 作为市场入口 |
| `<id>.tar.gz` | GitHub Release 资产 | 体积大，Release CDN 无 raw 的速率限制 |

## 发布新版本

1. 更新插件 `plugin.json` 的 `version`（遵循 semver），并把 `downloadUrl` 里的 tag 改成新版本。
2. 校验契约：`node scripts/check.mjs`（**必做**，见下）。
3. 打包：`bash scripts/pack.sh <id>`（产物在 `dist/<id>.tar.gz`，脚本会打印建议的 Release tag）。
4. 提交并推送源码到本仓库 `master`。
5. 在 GitHub 建 Release，tag 用 `<id>-v<version>`，把 `dist/<id>.tar.gz` 作为资产上传。
   `downloadUrl` 必须与该 tag 一致，否则市场安装会 404。
6. 新插件还要把它的 `plugin.json` raw 地址加进 `registry.json`，否则不会出现在市场里。

## 契约校验（scripts/check.mjs）

```
node scripts/check.mjs            # 全部插件
node scripts/check.mjs <id>       # 指定插件
```

校验四件事，专门防住那些「装进 V2 才发现」的坑：

1. `plugin.json` 能否通过 V2 的 `validateManifest`（字段 / 类型 / 能力 / 权限白名单）。
2. `index.js` 是否定义了 `globalThis.__mfPlugin`（沙箱契约），`manifest` 与 `plugin.json` 的
   id / version / capabilities 是否一致，`create(host)` 能否在 dummy host 下产出 impl。
3. **声明的每项能力都有对应实现方法**。V2 核心「只按 `capabilities` 分发」，
   声明缺失不会报错、只会**静默失效**——脚本还会反向提醒「有方法但没声明能力」的情况。
4. `downloadUrl` 的 Release tag 与 `version` 是否匹配（不匹配就会在市场安装时 404）。

## 沙箱安全模型（V2 ≥ 1.3.0）

外置插件运行在 **QuickJS 虚拟机**（WASM）里，与主进程完全隔离：

- **拿不到 Node 任何能力**：没有 `import` / `require` / `fetch` / `fs` / `process` / `child_process`；
- 网络只能走 `host.http(url, { timeout })`——在宿主侧执行、自带超时，且**必须声明 `permissions: ["net"]`**，否则请求在权限执行点被直接拒绝；
- 配置经 `host.config` 实时读取、存储走 `host.storage`（按插件隔离的 KV）；
- 单插件内存 256MB / 栈 1MB / 单次调用超时 15s，卡死可杀、崩溃不拖垮主进程；
- 沙箱内注入 `URL` / `URLSearchParams` 兼容层；**禁止使用 `eval` / `new Function`**（QuickJS 下即使用到也碰不到宿主）。

> 写插件前先读 [docs/PLUGIN_DEV.md](https://github.com/ray5378/MusicFlow-V2/blob/master/docs/PLUGIN_DEV.md)（沙箱契约完整开发指南）。

## 第三方插件风险

本仓库的官方插件经过了完整契约校验（`check.mjs`）与测试；**第三方 / 未校验插件仍要警惕**——
沙箱隔离了运行时能力（无 Node 权限、网络经 host 执行点强制），但「插件访问的**外部服务**（如
go-music-dl 服务地址）仍由你配置」，网络行为本身不在沙箱范围内。只安装你信任来源的插件。
