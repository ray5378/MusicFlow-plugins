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
> 仍随后端内置，开箱即用。**go-music-dl（源 / 歌词 / 封面三合一）是外置插件**——自本仓库
> 分发、市场一键安装，配置方式为「已安装」里填 `baseUrl` 并启用。

## 当前托管的插件

| 插件 | 版本 | 类型 | 说明 |
| --- | --- | --- | --- |
| [`go-music-dl`](plugins/go-music-dl) | 1.2.16 | source | 在线源三合一（搜索匹配 / 歌词 / 封面）：对接自建 go-music-dl 服务，为歌单未匹配曲目提供在线补全、播放时单曲匹配，并为本地库补歌词/封面。v1.2.14：窗口预取并发降至 **3 路**(配合主项目 1.7.48 批量任务限速档位,CPU 占用平缓);v1.2.13：批量任务**无预算闸**(配合主项目 1.7.47 软看门狗,无限歌单/封面/歌词一次跑完);v1.2.12：全量同步**窗口并行拉取**(6 并发,提速约 6 倍)+ 长耗时预算 10 分钟;v1.2.11：私人歌单带**平台标签**(sourcePlatform,前端显示网易云/QQ/酷狗/汽水徽标);v1.2.10：搜索自动限制平台（调用方指定 → 配置 `sources` → 国内快速默认，国内优先 ≤5 平台），杜绝「无 sources 全平台搜索（含 bilibili/JOOX/Apple 外网）单次超时」——修复交互搜索与后台 auto-match 的 `search() 执行超时` 与 `host.http timeout`。配置页填**后台用户名/密码**并启用后，插件每日自动登录，把各平台**我的私人歌单**（网易云/QQ/酷狗/汽水）以**路径 B 持久本地歌单**（`pl-gmdl-mine-<平台>-<歌单id>`，不轮转、不被清理）同步到本地：经 manifest `longRunning` 声明长耗时预算（需后端 ≥ 1.7.39），配合后端**异步任务通道**，**一次「手动刷新」即可全量同步**（约 1~2 分钟），歌单内歌曲自动刷新为可播条目（本地曲库池优先匹配、未命中的由后台 auto-match 补全）。手动刷新 `POST /rest/api/v1/recommend/refresh {"pluginId":"go-music-dl"}` 异步启动，轮询 `GET /rest/api/v1/plugins/go-music-dl/job` 查进度。不部署该服务则无需安装 |
| [`listenbrainz`](plugins/listenbrainz) | 1.5.6 | scrobbler | 播放记录上报 + 推荐歌单：把播放事件上报到 [ListenBrainz](https://listenbrainz.org)（开源的 Last.fm 替代品），并按协同过滤推荐生成「ListenBrainz」歌单（可固定首页、每日调度 + 手动刷新，本地/在线源补全）。v1.5.5：经 manifest `longRunning` 声明 `runDailyJob` 120s 长耗时预算（需后端 ≥ 1.7.39），配合后端异步任务通道一次任务完成生成，不再被沙箱/前端 15s 卡死。v1.5.4 起：在线补全加预算闸，超预算的歌留外部占位由后台 auto-match 补全。v1.5.3 起：换名优先用「收听历史 + LB 元数据」（直连可达、不依赖 MB），MusicBrainz 仅兜底且带重试/预算/快速降级；配置页新增「走系统网络代理」开关（需后端 1.7.38+）与「排除已听过的推荐」开关。不用这类服务的话无需安装 |
| [`lastfm`](plugins/lastfm) | 1.0.1 | scrobbler | 播放记录上报 + 推荐歌单：把播放事件上报到 [Last.fm](https://www.last.fm)（MD5 签名鉴权），并按收听数据组装「Last.fm 推荐」歌单（Top 多周期 + 喜欢的歌 + 相似艺人，可固定首页、每日调度 + 手动刷新，本地/在线源补全）。需要申请 Last.fm API Key 并在浏览器授权一次拿 Session Key（插件配置页各输入框下方已附「获取链接」，可一键跳到申请 / 授权页）。不用这类服务的话无需安装 |

> 插件运行于 **QuickJS 沙箱**（需要 V2 ≥ 1.3.0 的沙箱运行时，见 manifest 的 `minAppVersion`）。

> 历史：go-music-dl 曾在早期版本随后端内置，V2 插件化改造后外置化，并合并为**单插件多能力**
> （source 的 capabilities 含 lyricProvider/coverProvider），随本仓库分发。

## 在 MusicFlow V2 中安装

1. 打开 V2 后台 → **插件** → **插件市场** 标签页。
2. 官方注册表**已由 V2 首次启动时自动添加**，无需手动粘贴：
   ```
   https://raw.githubusercontent.com/ray5378/MusicFlow-plugins/master/registry.json
   ```
   如果你删掉过它（V2 不会自动加回，这是刻意设计），在「注册表」里手动添加上面的地址即可。
   离线 / 内网部署可用环境变量 `MUSICFLOW_OFFICIAL_REGISTRY` 换成自建镜像，或置空以完全关闭自动添加。
3. 市场列出的是本仓库托管的**外置插件**：`go-music-dl`、`listenbrainz`、`lastfm`（均为外置，从市场一键安装）。V2 的「核心插件」（QQ / 网易云 / 本地歌单导入、每日推荐、本地推荐、歌单同步、DLNA 投屏）仍随后端内置，开箱即用。

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
