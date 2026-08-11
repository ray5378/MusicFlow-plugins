# MusicFlow-plugins

MusicFlow V2（插件化重构分支 [MusicFlow-V2](https://github.com/ray5378/MusicFlow-V2)）的**官方插件分发仓库**。

本仓库托管以「外置 drop-in 插件」形式分发的官方插件，通过 V2 后端的**插件市场**一键安装，
不再随后端二进制内置。

> 说明：V2 的「核心插件」（QQ/网易云/本地歌单导入、每日推荐、本地推荐、歌单同步、DLNA 投屏）
> 仍随后端内置，开箱即用。与 go-music-dl 相关的官方能力（源 / 歌词 / 封面）全部合并为
> **单个**外置插件 `go-music-dl`，不再随后端内置，也不再拆成三个插件。

## 当前托管的插件

| 插件 | 类型 | 说明 |
| --- | --- | --- |
| [`go-music-dl`](plugins/go-music-dl) | source（含 lyricProvider + coverProvider） | 三合一：通过局域网已部署的 [go-music-dl](https://github.com/gogodjzhu/go-music-dl) 服务搜索全网音乐、获取推荐歌单、流式播放，并为在线歌曲提供 LRC 歌词与封面。源 / 歌词 / 封面共用同一份服务地址配置 |

> 2026-08-12 起，`go-music-dl-lyrics` 与 `go-music-dl-cover` 两个独立插件已合并进
> `go-music-dl`（单个 manifest 声明全部能力，单个 impl 实现全部方法）。如果你之前分别安装了
> 这三个插件，建议卸载 `go-music-dl-lyrics` / `go-music-dl-cover`，只保留 `go-music-dl` 即可。

## 在 MusicFlow V2 中安装

1. 打开 V2 后台 → **插件** → **插件市场** 标签页。
2. 在「注册表」里添加官方注册表地址：
   ```
   https://raw.githubusercontent.com/ray5378/MusicFlow-plugins/master/registry.json
   ```
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
  index.js        # ESM: export const manifest / export const impl(自包含,只用全局 fetch)
  package.json     # {"type":"module"},保证在任意 data/plugins 位置都以 ESM 加载
  <id>.tar.gz      # 分发包(含上面三个文件),供 downloadUrl 下载
```

## 发布新版本

1. 更新插件 `plugin.json` 的 `version`（遵循 semver）。
2. 重新打包：`tar --force-local -czf <id>.tar.gz -C plugins/<id> index.js plugin.json package.json`
   （Windows 上需 `--force-local`，否则 `C:\` 会被当成远程主机）。
3. 提交并推送到本仓库 `master`。
4. （可选）在 GitHub 打 Release，把 `*.tar.gz` 作为 Release 资产，并把 `downloadUrl` 指向 Release 资产地址。

## 安全提示

V2 的插件是 **in-process** 加载（无 QuickJS 沙箱），因此「权限」只是契约级而非运行时隔离。
安装第三方 / 外部插件等同于授予其本机执行权。官方插件均只用全局 `fetch` 访问你自托管的服务，
不触碰后端内部模块。
