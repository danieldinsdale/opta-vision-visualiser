# Opta Vision Visualiser

An interactive, browser-based visualiser for Opta Vision tracking data (EPTS), with optional event, phase, run and pressure overlays. It runs **entirely in your browser from local files**; fetching from the Stats Perform SDAPI is optional and needs a small local server. Video-on-demand (VOD) is an optional plugin point.

Everything lives in [`web/`](web/): static files, no build step, no runtime dependencies.

## Quick start

Needs Node 20+ only for the optional local server and the tests.

```bash
cd web
npm start        # http://127.0.0.1:8765
```

Open the page and drop your data package (the `.zip` you were sent) onto the sidebar. The tracking data and any events, match stats, phases and runs are found automatically and the match loads straight away. If you have your own files instead, use the **My own files** tab.

You can also serve the `web` folder with any static web server. Files are parsed in a Web Worker in your browser and **never uploaded**.

### SDAPI (optional, needs local server)

Run `npm start` in `web/` and open `http://127.0.0.1:8765`. The sidebar then also offers an **SDAPI** tab next to **Data package** and **My own files**. For SDAPI, enter your **SDAPI key**, an optional **SDAPI referral** (only if the API answers HTTP 403) and the **Opta Game UUID**, then click **Fetch from SDAPI**.

## Input files

The easiest route is a **data package**: one `.zip` holding the EPTS data and any of the optional feeds, in any folder layout. Files are recognised **by name**, so none of them has to be picked one by one. The same rules apply to loose files and folders dropped on **My own files**.

| Input | Required | Name it is matched by | What it adds |
|-------|----------|-----------------------|--------------|
| EPTS tracking | Yes | `<id>_epts_raw_data.txt` and `<id>_epts_format_specification.xml` (25 Hz), loose or inside a `.tar.gz` / `.tar` / `.zip` within the package | Player and ball positions |
| Events | No | `remoteevents_<id>.json` (or `remoteevents.json`) | Event labels and the live score. Events are placed on the tracking timeline by event id (carried on EPTS ball rows), falling back to video time, then match clock |
| Match stats | No | `matchstats_<id>.json` | Team names and codes, score, competition, venue, kit colours, player names |
| Phases of play | No | `remotephasesofplay_<id>.json` (`phases_<id>.json` also accepted) | Phase overlay and panel (the feed, or the extracted `phase` list) |
| Player runs | No | `remoteplayerruns_<id>.json` (`runs_<id>.json` also accepted) | Run highlights and panel (the feed, or the extracted `run` list) |

Names ignore letter case and macOS junk (`__MACOSX`, `._*`, `.DS_Store`). The sidebar lists what was found and what was left out. A feed whose game id differs from the tracking data's is flagged and not used, and missing optional files only switch off the overlays that need them. Archives may be nested two deep (a `.zip` containing a `.tar.gz`), and limits on file count and unpacked size apply.

### Local cache (SDAPI)

By default each downloaded feed is saved under `data/sdapi_cache/<game id>/`, so the API is called once per match; later fetches read from disk and rows show "cached". Tick **Re-download even if cached** for live or recently finished matches, and use **Delete cached files for this game** to remove them.

* `data/` is git-ignored, so cached match data cannot be committed by accident. Never remove it from `.gitignore`.
* Set `OPTA_VISUALISER_CACHE_DIR` to store the cache elsewhere.
* Folders are created `0700` and files `0600`. Only feed contents are stored, never the key. If the folder cannot be written, fetching carries on without caching.

Cached files are match and player data: treat them under your own data-protection and licence terms, and delete them when no longer needed.

## VOD plugin

No video service is bundled. Out of the box, the **VOD video** panel lets you paste a direct `https` MP4 or HLS (`.m3u8`) URL per period; the animation syncs the video to the current frame with a manual offset control. To integrate your own service, implement `getVodUrls` in [`web/vod-provider.js`](web/vod-provider.js). URLs are validated (https only, no embedded credentials) before reaching the `<video>` element. Keep credentials server-side.

## Credits

Ball graphic: OpenClipart-Vectors (via Pixabay), free to use. Grass texture (`web/assets/grass-texture.jpg`): derived from a photograph by Boldizsár Bednárik on Unsplash, used under the Unsplash licence (cropped, converted to greyscale, made seamless and downsized). Bundled libraries and fonts, with their licences, are listed in `web/vendor/README.md`. Typeface: Roboto (SIL OFL 1.1), bundled.

## Known limitations
* Event type and qualifier names cover the common Opta ids; others display as `type_<id>` / the numeric id.
* Extra time is untested; the app assumes up to 2 periods per match.
* Memory use on very large tracking files depends on the browser (about 700 MB peak for a 150 MB file in Node).
