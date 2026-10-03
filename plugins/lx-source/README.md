# lx-source (v1.1.1, pure stream resolver)

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

## Warning

This plugin executes third-party scripts inside your MusicFlow server
process. It ships no sources. Add only sources you trust and keep it
LAN-only. Disabled by default.
