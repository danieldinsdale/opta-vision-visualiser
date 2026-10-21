# Opta Vision Visualiser

An interactive, browser-based visualiser for Opta Vision tracking data (EPTS), with optional event, phase, run and pressure overlays. It runs **entirely in your browser from local files**; fetching from the Stats Perform SDAPI is optional and needs a small local server. Video-on-demand (VOD) is an optional plugin point.

Everything lives in [`web/`](web/): static files, no build step, no runtime dependencies.

## Quick start

Needs Node 20+ only for the optional local server and the tests.

```bash
cd web
npm start        # http://127.0.0.1:8765
```

Open the page, choose an EPTS dataset in the sidebar and click **Load data**.

You can also serve the `web` folder with any static web server, or publish it on GitHub Pages (see below). Files are parsed in a Web Worker in your browser and **never uploaded**.

### SDAPI (optional, needs the local server)

Run `npm start` in `web/`. The sidebar then offers **Local files** or **SDAPI**. For SDAPI, enter three values: your **SDAPI key**, an optional **SDAPI referral** (only if the API answers HTTP 403) and the **Opta Game UUID**, then click **Fetch from SDAPI**.

The key and referral are held in the page only (nothing is saved to disk, browser storage or the repository, and they are not read from files or environment variables). The page sends them to the local server on `127.0.0.1`, which calls the API; they are never written to logs. On a static host there is no server, so the SDAPI option does not appear. If a request fails, the message shows the URL with the key masked as `<API_OUTLET_KEY>`.

Server safety: binds to `127.0.0.1` only, checks `Host` and `Origin` (DNS-rebinding and cross-site protection), serves an allow-list of files, HTTPS-only outbound requests with no redirects, validated game ids and download hosts, size caps.

### Hosting on GitHub Pages

`.github/workflows/pages.yml` tests and publishes the public files in `web/`. One-off setup: repository **Settings > Pages > Source: GitHub Actions**. The hosted page works with local files only.

## Input files

| Input | Required | Format |
|-------|----------|--------|
| EPTS tracking | Yes | `*_epts_raw_data.txt` plus `*_epts_format_specification.xml` (25 Hz), chosen separately **or** as one `.tar.gz` / `.tar` / `.zip` bundle containing both |
| Events | No | `remoteevents` JSON feed. Events are placed on the tracking timeline by event id (carried on EPTS ball rows), falling back to video time, then match clock |
| Match stats | No | `matchstats` JSON feed: team names, score, competition, kit colours, player names |
| Phases of play | No | `remotephasesofplay` JSON feed (or the extracted `phase` list) |
| Player runs | No | `remoteplayerruns` JSON feed (or the extracted `run` list) |

The events feed gives every event from the acting team's point of view (each team attacks left-to-right). The page rotates events (and pressure positions) for teams attacking right-to-left, using the direction of play in the EPTS XML. Events in non-playing periods (pre- and post-match) are ignored.

Pressure arrows come from the events feed. Without a match stats file, team names are generic and player names come from the events feed where available.

### Local cache (SDAPI)

By default each downloaded feed is saved under `data/sdapi_cache/<game id>/`, so the API is called once per match; later fetches read from disk and rows show "cached". Tick **Re-download even if cached** for live or recently finished matches, and use **Delete cached files for this game** to remove them.

* `data/` is git-ignored, so cached match data cannot be committed by accident. Never remove it from `.gitignore`.
* Set `OPTA_VISUALISER_CACHE_DIR` to store the cache elsewhere.
* Folders are created `0700` and files `0600`. Only feed contents are stored, never the key. If the folder cannot be written, fetching carries on without caching.

Cached files are match and player data: treat them under your own data-protection and licence terms, and delete them when no longer needed.

## VOD plugin

No video service is bundled. Out of the box, the **VOD video** panel lets you paste a direct `https` MP4 or HLS (`.m3u8`) URL per period; the animation syncs the video to the current frame with a manual offset control. To integrate your own service, implement `getVodUrls` in [`web/vod-provider.js`](web/vod-provider.js). URLs are validated (https only, no embedded credentials) before reaching the `<video>` element. Keep credentials server-side.

## Project layout

```
web/index.html, style.css, main.js, worker.js   the page
web/lib/                                        parsers (EPTS, events, feeds, lineup, payload) - run in browser and Node
web/animation/                                  the pitch animation (canvas + optional 3D), shown in an iframe
web/server/                                     optional local server for SDAPI
web/vendor/                                     vendored three.js, gif.js, hls.js (see its README)
web/test/                                       tests and synthetic fixtures
```

## Development

```bash
cd web
npm install      # dev dependency only: jsdom, used by the UI tests
npm test         # parsers, input safety, direction of play, SDAPI/cache, server and UI
```

Tests use fully synthetic data (`web/test/fixtures`); no real match data is, or should be, committed to this repository.

## Credits

Ball graphic: OpenClipart-Vectors (via Pixabay), free to use. Bundled libraries and their licences are listed in `web/vendor/README.md`.

## Known limitations
* Event type and qualifier names cover the common Opta ids; others display as `type_<id>` / the numeric id.
* Extra time is untested; the app assumes up to 2 periods per match.
* Memory use on very large tracking files depends on the browser (about 700 MB peak for a 150 MB file in Node).
