# lx-source

LX Music (LuoXue) source runner plugin for MusicFlow.

Loads user-provided LX Music source scripts (.js) inside the MusicFlow QuickJS
sandbox, parses the @name/@version header, and registers the declared sources
with stream URL resolving, search (when the source declares musicSearch/search),
lyrics and covers.

## Highlights

- No LX client, no LX server, no external baseUrl required.
- Single audited network exit: source scripts reach the network only through
  the host-injected jsenv HTTP bridge (requires backend >= v4.0.74).
- Source-level auto fallback: when one source errors or returns nothing, the
  next configured source is tried automatically (trace goes into the result
  message). If the whole plugin is unusable, the core stream-fallback chain
  takes over (go-music-dl and other enabled source plugins).
- Stream URLs are prefetched during search and cached; the sync `streamUrl`
  contract returns the cached URL string, or "" to let the core resolve it.

## Warning

This plugin executes third-party scripts inside your MusicFlow server process.
It ships no sources. Add only sources you trust and keep it LAN-only.
Disabled by default.
