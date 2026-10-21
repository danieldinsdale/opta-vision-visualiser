"""Opta Vision Visualiser - Streamlit app.

Interactive visualiser for EPTS tracking data and Opta event feeds. Works fully
from locally uploaded files; fetching from the Stats Perform SDAPI is optional
and only enabled when ``API_OUTLET_KEY`` is set in ``.streamlit/secrets.toml``.

Run:  streamlit run app.py

Privacy: uploaded files are processed in memory only. Files fetched from the SDAPI are
cached on disk by default in a git-ignored folder (see CACHE_DIR); this can be switched
off in the sidebar. Nothing is sent to a third party by this app.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import streamlit as st

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))

from opta_vision_visualiser import vod  # noqa: E402
from opta_vision_visualiser.columns import Column  # noqa: E402
from opta_vision_visualiser.config import load_data_type_config  # noqa: E402
from opta_vision_visualiser.feed_labels import feed_help, feed_label  # noqa: E402
from opta_vision_visualiser.loader import LoadedMatch, TrackingInput, build_match  # noqa: E402
from opta_vision_visualiser.readers.epts import EptsFormatError, read_epts_bundle  # noqa: E402
from opta_vision_visualiser.readers.events import load_json_bytes  # noqa: E402
from opta_vision_visualiser.sdapi import (  # noqa: E402
    OPTIONAL_FEEDS,
    FeedCache,
    SdapiClient,
    SdapiError,
    fetch_match,
    get_outlet_key,
    get_referer,
)
from opta_vision_visualiser.viz import render_pitch_animation  # noqa: E402

logger = logging.getLogger("opta_vision_visualiser")

ASSETS = ROOT / "assets"
# Downloaded SDAPI files are cached here (git-ignored). Override with OPTA_VISUALISER_CACHE_DIR.
CACHE_DIR = Path(os.environ.get("OPTA_VISUALISER_CACHE_DIR") or ROOT / "data" / "sdapi_cache")
# Feeds ticked by default in the SDAPI sidebar (the others start unticked).
DEFAULT_FEEDS = ("events", "matchstats")


# ── Loading ───────────────────────────────────────────────────────────────────


@dataclass
class LoadRequest:
    """Raw inputs for one load. ``digest`` identifies them for caching (never the bytes)."""

    tracking: TrackingInput
    events: bytes | None = None
    matchstats: bytes | None = None
    phases: bytes | None = None
    runs: bytes | None = None
    digest: str = ""


def _digest(*parts: bytes | str | None) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(b"\x00" if p is None else (p if isinstance(p, bytes) else p.encode()))
        h.update(b"|")
    return h.hexdigest()


@st.cache_resource(show_spinner="Parsing tracking data ...", max_entries=2)
def _load_cached(digest: str, _req: LoadRequest) -> LoadedMatch:  # noqa: ARG001 - digest is the cache key
    return build_match(
        _req.tracking,
        events_feed=load_json_bytes(_req.events, "Events feed") if _req.events else None,
        matchstats=load_json_bytes(_req.matchstats, "Match stats feed") if _req.matchstats else None,
        phases_feed=load_json_bytes(_req.phases, "Phases feed") if _req.phases else None,
        runs_feed=load_json_bytes(_req.runs, "Runs feed") if _req.runs else None,
    )


@st.cache_data
def _data_config():
    return load_data_type_config(ROOT / "config" / "data_type_config.yaml")


# ── Page chrome ───────────────────────────────────────────────────────────────


def _apply_theme() -> None:
    """Inject the page theme (assets/theme.css) and the slim page heading."""
    st.markdown(f"<style>{(ASSETS / 'theme.css').read_text('utf-8')}</style>", unsafe_allow_html=True)
    st.markdown(
        '<div class="page-top"><b>Opta Vision Visualiser</b><span>EPTS &amp; event tracking</span></div>',
        unsafe_allow_html=True,
    )


def _sidebar_logo() -> None:
    try:
        uri = "data:image/png;base64," + base64.b64encode((ASSETS / "opta-ai-logo_white.png").read_bytes()).decode()
    except OSError:
        return
    st.markdown(f'<img class="side-logo" src="{uri}" alt="Opta AI">', unsafe_allow_html=True)


def _section(title: str) -> None:
    """Small uppercase section label in the sidebar."""
    st.markdown(f'<div class="sec-lbl">{title}</div>', unsafe_allow_html=True)


# ── Sidebar: one function per data source ─────────────────────────────────────


def _sidebar_local_files() -> LoadRequest | None:
    """EPTS bundle (or txt + xml) plus optional feed uploads. None until the EPTS files are given."""
    _section("EPTS tracking data")
    bundle = st.file_uploader("Bundle (.tar.gz / .zip)", type=["gz", "tgz", "tar", "zip"], key="bundle")
    st.caption("or the two files separately:")
    txt = st.file_uploader("EPTS raw data (.txt)", type=["txt"], key="txt")
    xml = st.file_uploader("EPTS format specification (.xml)", type=["xml"], key="xml")
    with st.expander("Events and context (optional)", expanded=False):
        st.caption("JSON feeds exactly as returned by the API (or the extracted list for phases/runs).")
        uploads = [
            st.file_uploader("Events (remoteevents)", type=["json"], key="f_events"),
            st.file_uploader("Match stats (lineup, kit colours)", type=["json"], key="f_stats"),
            st.file_uploader("Phases of play", type=["json"], key="f_phases"),
            st.file_uploader("Player runs", type=["json"], key="f_runs"),
        ]

    if bundle is not None:
        raw, spec = read_epts_bundle(bundle.getvalue())
        tracking = TrackingInput(raw, spec)
    elif txt is not None and xml is not None:
        tracking = TrackingInput(txt.getvalue(), xml.getvalue())
    else:
        return None
    parts = [f.getvalue() if f is not None else None for f in uploads]
    return LoadRequest(tracking, *parts, digest=_digest(tracking.raw_txt, tracking.xml, *parts))


def _sidebar_sdapi(outlet_key: str, secrets) -> LoadRequest | None:
    """Game id, feed tick-boxes with fetch status, cache options and the Fetch button."""
    _section("Match")
    game_id = st.text_input("Opta Game UUID", max_chars=40)
    saved = st.session_state.get("sdapi_status")
    # Statuses belong to the game that was fetched; hide them for any other id.
    by_label = {s.label: s for s in saved[1]} if saved and saved[0] == game_id else {}

    _section("Feeds")
    # EPTS tracking is the only required feed; its row is always ticked.
    epts_status = by_label.get("EPTS tracking")
    st.checkbox(
        feed_label("EPTS tracking (required)", epts_status, True), value=True, disabled=True,
        key="want_epts", help=feed_help(epts_status, optional=False),
    )
    want = {}
    for key, label, _feed in OPTIONAL_FEEDS:
        status = by_label.get(label)
        ticked_before = st.session_state.get(f"want_{key}", key in DEFAULT_FEEDS)
        want[key] = st.checkbox(
            feed_label(label, status, ticked_before), value=key in DEFAULT_FEEDS,
            key=f"want_{key}", help=feed_help(status),
        )

    st.divider()
    use_cache = st.checkbox(
        "Store files locally and reuse them", value=True, key="use_cache",
        help="Saves downloaded feeds to a git-ignored folder so the API is only called once per match.",
    )
    refresh = st.checkbox(
        "Re-download even if cached", value=False, key="refresh", disabled=not use_cache,
        help="Use for live or recently finished matches whose feeds may have changed.",
    )
    if use_cache:
        _cache_controls(game_id)

    if st.button("Fetch from SDAPI", type="primary") and game_id:
        client = SdapiClient(outlet_key, referer=get_referer(secrets))
        with st.spinner("Fetching from SDAPI ..."):
            payload, statuses = fetch_match(
                client, game_id, want, cache=FeedCache(CACHE_DIR) if use_cache else None, refresh=refresh,
            )
        st.session_state["sdapi_status"] = (game_id, statuses)
        if payload is None:
            st.session_state.pop("sdapi_request", None)
        else:
            # Held in session memory; also cached on disk only if "Store files locally" is ticked.
            fetched = LoadRequest(
                TrackingInput(payload["raw"], payload["spec"]),
                payload.get("events"), payload.get("matchstats"), payload.get("phases"), payload.get("runs"),
                digest=_digest(game_id, *[payload[k] for k in sorted(payload)]),
            )
            st.session_state["sdapi_request"] = fetched
            st.session_state["active_request"] = fetched  # one click: fetch and show
        st.rerun()  # redraw the rows above with their new loaded / failed labels
    return st.session_state.get("sdapi_request")


def _cache_controls(game_id: str) -> None:
    """Cache folder caption and the delete button (only when this game has cached files)."""
    try:
        shown = CACHE_DIR.relative_to(ROOT) if CACHE_DIR.is_relative_to(ROOT) else "custom folder"
        st.caption(f"Cache folder: `{shown}`")
        if game_id and FeedCache(CACHE_DIR).has(game_id) and st.button("Delete cached files for this game"):
            FeedCache(CACHE_DIR).clear(game_id)
            st.session_state.pop("sdapi_status", None)
            st.session_state.pop("sdapi_request", None)
            st.rerun()
    except SdapiError:
        pass  # game id not valid yet - nothing to look up


# ── VOD ───────────────────────────────────────────────────────────────────────


def _vod_urls(match: LoadedMatch, provider: vod.VodProvider) -> dict[int, str] | None:
    """Ask the VOD provider for per-period stream URLs (validated). None if unavailable."""
    ball = match.df[match.df[Column.TRACKING_GROUP_ID] == 4]
    periods = tuple(sorted(int(p) for p in ball[Column.PERIOD_ID].dropna().unique()))
    if isinstance(provider, vod.ManualUrlVodProvider):
        provider.set_periods(periods)
    with st.sidebar:
        provider.render_controls(st)
    starts = {int(p): float(g[Column.IMPLIED_100HZ_FRAME_COUNT].min()) / 100.0 for p, g in ball.groupby(Column.PERIOD_ID)}
    try:
        urls = provider.get_urls(vod.VodContext(match.match_uuid, periods, starts)) or None
        return {p: vod.validate_stream_url(u) for p, u in urls.items()} if urls else None
    except Exception as exc:  # noqa: BLE001 - provider code is user-supplied
        st.sidebar.warning(f"VOD unavailable: {type(exc).__name__}: {exc}")
        return None


# ── Page ──────────────────────────────────────────────────────────────────────

st.set_page_config(page_title="Opta Vision Visualiser", layout="wide")
_apply_theme()

data_config = _data_config()
_secrets = st.secrets if (ROOT / ".streamlit" / "secrets.toml").exists() else None
outlet_key = get_outlet_key(_secrets)
vod_provider = vod.load_provider()

request: LoadRequest | None = None
input_error: str | None = None

with st.sidebar:
    _sidebar_logo()
    modes = ["Local files"] + (["SDAPI"] if outlet_key else [])
    mode = st.radio("Data source", modes, horizontal=True)
    if not outlet_key:
        st.caption("SDAPI access is off. Add `API_OUTLET_KEY` to `.streamlit/secrets.toml` to enable it.")

    try:
        request = _sidebar_local_files() if mode == "Local files" else _sidebar_sdapi(outlet_key, _secrets)
    except (EptsFormatError, SdapiError, ValueError) as exc:
        input_error = str(exc)

    st.divider()
    with st.expander("VOD video", expanded=False):
        show_vod = st.checkbox("Show VOD video alongside the animation", value=False)
        if show_vod:
            st.caption(f"Provider: {vod_provider.name}")

    # SDAPI fetches show the match straight away, so "Load data" is only needed for local files.
    load_clicked = False
    if mode == "Local files":
        load_clicked = st.button("Load data", type="primary", disabled=request is None, key="load_btn")

if input_error:
    st.error(input_error)
    st.stop()
if load_clicked and request is not None:
    st.session_state["active_request"] = request
active: LoadRequest | None = st.session_state.get("active_request")
if active is None:
    if mode == "Local files":
        st.info("Upload an EPTS dataset in the sidebar, then click **Load data**.")
    else:
        st.info("Enter an Opta Game UUID in the sidebar and click **Fetch from SDAPI**.")
    st.stop()

try:
    match = _load_cached(active.digest, active)
except (EptsFormatError, ValueError) as exc:
    st.error(f"Could not load the data: {exc}")
    st.stop()
except Exception:  # noqa: BLE001 - never surface internals / paths to the browser
    logger.exception("Unexpected error while loading match data")
    st.error("Unexpected error while loading the data. Check the server log for details.")
    st.stop()

for message in match.warnings:
    st.warning(message)

vod_urls = _vod_urls(match, vod_provider) if show_vod else None

render_pitch_animation(
    match.df, {"epts": data_config["epts"]}, height=960 if vod_urls else 920,
    team_colors=match.team_colors, vod_urls=vod_urls, events=match.events,
    phases=match.phases or None, lineup=match.lineup, runs=match.runs or None, pressures=match.pressures or None,
)
