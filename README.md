# Opta Vision Visualiser

An interactive, browser-based visualiser for Opta Vision tracking data, with optional event and tracking metric overlays. It can run **entirely from local files** if required, otherwise requires fetching from the Stats Perform SDAPI. Video-on-demand (VOD) is an optional plugin point (see below).

## Quick start

```bash
uv sync   # creates .venv with Python 3.12 and installs everything
uv run streamlit run app.py
```
### Local input data
Open <http://localhost:8501>, upload an EPTS dataset in the sidebar and click **Load data**.

### SDAPI input data
Add your outlet key to `.streamlit/secrets.toml` (an empty, git-ignored file is provided; `.streamlit/secrets.toml.example` shows the format). The SDAPI option then appears in the sidebar:

```toml
API_OUTLET_KEY = "<your outlet key>"
```

Credentials are read from this file only, not from environment variables. When running in a container, mount the file read-only, e.g. `-v ./.streamlit/secrets.toml:/app/.streamlit/secrets.toml:ro`.

If a request fails, the error shows the URL that was called with the key masked as `<API_OUTLET_KEY>`.

If the API answers **HTTP 403**, your account may need a `Referer` header. Add it to the same file:

```toml
API_REFERER = "www.performfeeds.com"
```

It is optional, sent on every API and file-download request when set, and ignored when empty.

## Input files

| Input | Required | Format |
|-------|----------|--------|
| EPTS tracking | Yes | `*_epts_raw_data.txt` plus `*_epts_format_specification.xml` (25 Hz), uploaded separately **or** as one `.tar.gz` / `.tar` / `.zip` bundle containing both |
| Events | No | `remoteevents` JSON feed. Events are placed on the tracking timeline by event id (carried on EPTS ball rows), falling back to video time, then match clock |
| Match stats | No | `matchstats` JSON feed: team names, score, competition, kit colours, player names |
| Phases of play | No | `remotephasesofplay` JSON feed (or the extracted `phase` list) |
| Player runs | No | `remoteplayerruns` JSON feed (or the extracted `run` list) |

The events feed gives every event from the acting team's point of view (each team attacks left-to-right). The app rotates events (and pressure positions) for teams attacking right-to-left, using the direction of play in the EPTS XML.

Pressure arrows are derived from the events feed. If no match stats file is given, team names are left generic and player names are taken from the events feed where available.

### Local cache

By default ("Store files locally and reuse them" is ticked) each downloaded feed is saved under `data/sdapi_cache/<game id>/`, so the API is called only once per match. The next fetch reads from disk and the row labels show "loaded from cache". Tick **Re-download even if cached** for live or recently finished matches, whose feeds can change, and use **Delete cached files for this game** to remove them.

* `data/` is git-ignored and excluded from container builds, so cached match data cannot be committed by accident. Never remove it from `.gitignore`.
* Set `OPTA_VISUALISER_CACHE_DIR` to store the cache elsewhere (in a container, mount a volume there).
* Cache folders are created `0700` and files `0600`. Only feed contents are stored, never the outlet key. If the folder cannot be written, the app carries on without caching.
* Untick the option to keep downloads in memory only.

Cached files are match and player data: treat them under your own data-protection and licence terms, and delete them when no longer needed.

## VOD plugin

No video service is bundled. Out of the box, the sidebar's **VOD video** panel lets you paste a direct `http(s)` MP4 or HLS (`.m3u8`) URL per period. The component syncs the video to the current frame and provides a manual offset control.

To integrate your own service, subclass `VodProvider` (see [`examples/vod_provider_example.py`](examples/vod_provider_example.py)) and register it:

```bash
export OPTA_VISUALISER_VOD_PROVIDER="my_package.my_module:MyProvider"
```

The provider's `get_urls(context)` returns `{period_id: url}`. URLs are validated (`http`/`https` only, no embedded credentials) before reaching the browser. Keep credentials server-side.

## Configuration

* `config/data_type_config.yaml` - marker fill, line style, opacity and label for the primary tracking source.
* `.streamlit/config.toml` - theme, upload limit (600 MB), telemetry off.

## Development

Dependencies are managed with [uv](https://docs.astral.sh/uv/) (Python 3.12, pinned in `.python-version`; `uv.lock` is committed).

```bash
uv sync            # install runtime + dev dependencies
uv run pytest
uv run ruff check .
uv add <package>   # add a dependency (updates pyproject.toml and uv.lock)
uv lock --upgrade  # refresh pinned versions
```

Tests use fully synthetic data (`tests/synthetic.py`); no real match data is, or should be, committed to this repository.

## Credits

Ball graphic: OpenClipart-Vectors (via Pixabay), free to use.

## Known limitations
* Event type and qualifier names cover the common Opta ids; others display as `type_<id>` / the numeric id.
* Extra-time is yet untested; the app assumes 2 periods per match.
