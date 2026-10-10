# lx-source (v1.2.0, pure stream resolver)

> **v1.2.1**: 默认列表收敛为 6 个实测可注册音源（sixyin/flower/grass/lx 在沙箱内无法注册源，已移出默认；脚本保留可手动启用）
>
> **v1.2.0**: 内置音源脚本（lx-sources/，安装即用）；
> 音质默认 320k + flac + flac24bit。音源脚本版权归原作者，请自行评估使用风险。

Inlines LX Music source scripts into the MusicFlow QuickJS sandbox and
resolves playable URLs **by the song's platform ID** via the LX musicUrl
action, with automatic multi-source rotation. Consumed by the core
stream-fallback: when the owning provider (go-music-dl etc.) fails on every
platform, the core calls `resolveStream(config, song)` with the song's
`sourceData` (native platform IDs) - no search involved.

## Why no search

The LX official protocol defines only `musicUrl` (online sources) /
`musicUrl+lyric+pic` (local). There is no `musicSearch` action - search was
never part of the LX ecosystem (measured search self-answer rate: 0/12).
This plugin therefore declares only the `stream` capability; search,
playlists, recommendations, lyrics and covers belong to go-music-dl and
friends.

## Highlights

- No LX client, no LX server, no external baseUrl required.
- Single audited network exit: source scripts reach the network only through
  the host-injected jsenv HTTP bridge (requires backend >= v4.0.74).
- Source-level auto fallback: when one source errors or returns no URL, the
  next configured source is tried automatically (trace goes into the log).
- Verified live (2026-10): kuwo (qdy source) and netease (tongyi/xinghai,
  flac capable) resolve real playable URLs by ID; qq/kugou/migu upstreams
  are currently dead and simply fail over.
- musicInfo carries the LX platform key (`source`: wy/kg/kw/tx/mg) as
  required by aggregate sources (tongyi/xinghai read it to route upstream).

## Config

- `sources` - one row per LX source (URL or local file name); the legacy
  semicolon-separated format is still accepted.
- `sourceDir` - root dir for local `.js` sources (default `lx-sources`).
- `quality` - preferred quality tier when fetching a playable URL.
- `sourcePreference` - one LX platform key per row (`wy/kg/kw/tx/mg`);
  earlier rows are tried first. Unlisted platforms are tried last. Sets the
  source rotation order once the sources are loaded. Empty = source list
  order.
- `concurrency` - how many sources load in parallel during
  resolve/self-check (1-8).
- `cacheTtlHours` - how long a downloaded source script stays cached
  (0 = never expire).
- `timeoutMs` - per-fetch network timeout in ms.
- `maxSources` - 0 = load every row; >0 caps how many scripts load.
- `fallbackOnError` / `fallbackOnEmpty` - auto-switch to the next working
  source on error / empty result.

## Warning

This plugin executes third-party scripts inside your MusicFlow server
process. It ships no sources. Add only sources you trust and keep it
LAN-only. Disabled by default.
