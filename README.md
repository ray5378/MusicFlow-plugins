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
> 仍随后端内置，开箱即用。**go-music-dl 三合一（源 / 歌词 / 封面）自 V2 1.3.0 起改回内置**——
> 不再随后端外置分发，也不再出现在本市场，配置方式不变（「已安装」里填 `baseUrl` 并启用）。

## 当前托管的插件

| 插件 | 版本 | 类型 | 说明 |
| --- | --- | --- | --- |
| [`listenbrainz`](plugins/listenbrainz) | 1.4.0 | scrobbler | 播放记录上报 + 推荐歌单：把播放事件上报到 [ListenBrainz](https://listenbrainz.org)（开源的 Last.fm 替代品），并按协同过滤推荐生成「ListenBrainz」歌单（可固定首页、每日调度 + 手动刷新，本地/在线源补全）。不用这类服务的话无需安装 |

> 插件运行于 **QuickJS 沙箱**（需要 V2 ≥ 1.3.0 的沙箱运行时，见 manifest 的 `minAppVersion`）。

> 历史：go-music-dl 曾作为外置插件（1.2.x）分发自本仓库；自 V2 1.3.0 起合并为内置
> source 插件（`goMusicDlBuiltin.ts`，capabilities 含 lyricProvider/coverProvider），
> 随镜像发行。若你的环境里残留外置版本的 `data/plugins/go-music-dl` 目录，可删除（内置
> 插件优先注册，同名外置会被自动跳过）。

## 在 MusicFlow V2 中安装

1. 打开 V2 后台 → **插件** → **插件市场** 标签页。
2. 官方注册表**已由 V2 首次启动时自动添加**，无需手动粘贴：
   ```
   https://raw.githubusercontent.com/ray5378/MusicFlow-plugins/master/registry.json
   ```
   如果你删掉过它（V2 不会自动加回，这是刻意设计），在「注册表」里手动添加上面的地址即可。
   离线 / 内网部署可用环境变量 `MUSICFLOW_OFFICIAL_REGISTRY` 换成自建镜像，或置空以完全关闭自动添加。
3. 市场列出的是本仓库托管的插件（当前为 `listenbrainz`）。`go-music-dl` 已内置，
   直接在「已安装」标签页里填服务地址（`baseUrl`）并启用即可，无需安装。

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

分发用的 `<id>.tar.gz` **入库**（`dist/`，已由 `.gitignore` 放行）：它是**唯一权威副本**，
GitHub / Gitee 双端 raw 均可直接下载，避免「Release 附件在 Gitee 不可用 / 仓库内 tar 与
Release 资产漂移」的坑（Gitee 的 Release 附件 API 已废弃，无法自动传附件）。

## 分发方式

| 内容 | 位置 | 原因 |
| --- | --- | --- |
| `registry.json`、`plugin.json` | raw.githubusercontent.com（raw 回退 gitee.com/.../raw/） | 体积小、需要稳定不变的 URL 作为市场入口 |
| `<id>.tar.gz` | **仓库 `dist/`（入库）**，downloadUrl 指向 raw | 国内网络下 GitHub raw 失败可自动回退 Gitee raw，双端直下；Gitee Release 附件 API 已废弃，不依赖附件 |

## 发布新版本

1. 更新插件 `plugin.json` 的 `version`（遵循 semver）；`downloadUrl` 保持
   `https://raw.githubusercontent.com/ray5378/MusicFlow-plugins/master/dist/<id>.tar.gz` 不变
   （raw 地址不随版本变化，避免手工改 tag 出错）。
2. 校验契约：`node scripts/check.mjs`（**必做**，见下）。
3. 打包：`bash scripts/pack.sh <id>`（产物在 `dist/<id>.tar.gz`，**必须提交入库**——这是权威副本）。
4. 提交并推送源码到本仓库 `master`（GitHub + Gitee 镜像同步）。
5. 如需 Release 可照旧创建（tag `<id>-v<version>`），但**不再依赖附件**：raw 分发已覆盖安装链路。
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
