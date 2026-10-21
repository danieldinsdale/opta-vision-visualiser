"""Interactive pitch animation component for Streamlit.

All rendering happens client-side (HTML5 Canvas, plus optional three.js 3D
view) inside a sandboxed ``components.html`` iframe, so playback never triggers
a Streamlit rerun. This module converts the merged tracking DataFrame into a
compact JSON payload and embeds it in ``templates/animation.html`` (with ``animation.css`` and ``animation.js`` inlined).
"""

from __future__ import annotations

import base64
import json
import re
from functools import lru_cache
from importlib import resources
from typing import Any

import numpy as np
import pandas as pd
import streamlit.components.v1 as components

from opta_vision_visualiser.columns import BALL_GROUP_ID, Column
from opta_vision_visualiser.config import DataTypeConfig
from opta_vision_visualiser.panels import build_context_panels

# Default colours (tracking_group_id -> hex): team 1, team 2, ball.
_TEAM_COLORS: dict[int, str] = {1: "#4682b4", 2: "#cd5c5c", 4: "#f5c518"}
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


# ── Public API ────────────────────────────────────────────────────────────────


def render_pitch_animation(
    df: pd.DataFrame,
    sources: dict[str, DataTypeConfig],
    height: int = 770,
    team_colors: dict[int, str] | None = None,
    vod_urls: dict[int, str] | None = None,
    events: pd.DataFrame | None = None,
    phases: list[dict] | None = None,
    lineup: dict[str, str] | None = None,
    runs: list[dict] | None = None,
    pressures: list[dict] | None = None,
) -> None:
    """Render the animation.

    Args:
        df: merged tracking frame from ``loader.build_match``.
        sources: ordered ``{source_id: style}``; the first entry is the primary source.
        team_colors: optional ``{1|2|4: '#rrggbb'}`` overrides.
        vod_urls: optional ``{period: url}`` (already validated by the caller).
        events: events placed on the timeline (``readers.events.place_events``).
        phases / runs / pressures: raw feed lists (see ``readers.feeds``).
    """
    payload = build_payload(
        df, sources, team_colors=team_colors, vod_urls=vod_urls, events=events,
        phases=phases, lineup=lineup, runs=runs, pressures=pressures,
    )
    html = _template().replace('"__PAYLOAD__"', _script_safe_json(payload), 1)
    # scrolling stays on as a fallback; the component auto-fits the frame height when it can.
    components.html(html, height=height, scrolling=True)


# ── Serialisation helpers ─────────────────────────────────────────────────────


@lru_cache(maxsize=1)
def _template() -> str:
    """Assemble the single self-contained page from the three template files."""
    folder = resources.files("opta_vision_visualiser").joinpath("templates")
    read = lambda name: folder.joinpath(name).read_text("utf-8")  # noqa: E731
    return read("animation.html").replace("/*__STYLE__*/", read("animation.css")).replace("/*__SCRIPT__*/", read("animation.js"))


@lru_cache(maxsize=1)
def _ball_image_data_url() -> str:
    """The football graphic (SVG) as a data URL, so the component needs no extra request."""
    raw = resources.files("opta_vision_visualiser").joinpath("data/ball.svg").read_bytes()
    return "data:image/svg+xml;base64," + base64.b64encode(raw).decode("ascii")


def _script_safe_json(payload: dict) -> str:
    """JSON that cannot break out of the surrounding ``<script>`` element."""
    text = json.dumps(payload, separators=(",", ":"), allow_nan=False)
    return (
        text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
        .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    )


def _neutralise(value: Any) -> Any:
    """Defuse markup in feed-supplied strings.

    The component renders some labels via ``innerHTML``; names and labels come
    from files the user uploads, so ``<`` / ``>`` are replaced by look-alike
    glyphs and control characters are dropped.
    """
    if isinstance(value, str):
        cleaned = "".join(ch for ch in value if ch >= " " or ch in "\t")
        return cleaned.replace("<", "\u2039").replace(">", "\u203a")
    if isinstance(value, list):
        return [_neutralise(v) for v in value]
    if isinstance(value, dict):
        return {_neutralise(k) if isinstance(k, str) else k: _neutralise(v) for k, v in value.items()}
    return value


# ── Payload ───────────────────────────────────────────────────────────────────


def build_payload(
    df: pd.DataFrame,
    sources: dict[str, DataTypeConfig],
    team_colors: dict[int, str] | None = None,
    vod_urls: dict[int, str] | None = None,
    events: pd.DataFrame | None = None,
    phases: list[dict] | None = None,
    lineup: dict[str, str] | None = None,
    runs: list[dict] | None = None,
    pressures: list[dict] | None = None,
) -> dict:
    """Convert the tracking DataFrame into the compact structure the JS component reads."""
    src_ids = [s for s in sources if f"{s}_x" in df.columns and df[f"{s}_x"].notna().any()]
    if not src_ids:
        raise ValueError("No tracking positions to display")

    # ── Frame index from ball rows ────────────────────────────────────────────
    ball_df = (
        df[df[Column.TRACKING_GROUP_ID] == BALL_GROUP_ID]
        .drop_duplicates(subset=[Column.CONTINUOUS_FRAME_COUNT])
        .sort_values(Column.CONTINUOUS_FRAME_COUNT)
    )
    frame_ids: list[int] = ball_df[Column.CONTINUOUS_FRAME_COUNT].tolist()
    frame_index = pd.Series(np.arange(len(frame_ids)), index=ball_df[Column.CONTINUOUS_FRAME_COUNT].to_numpy())
    # Per-row frame index (NaN when the frame has no ball row) - computed once.
    fi_col = df[Column.CONTINUOUS_FRAME_COUNT].map(frame_index)
    has_frame = fi_col.notna()

    in_play = (
        ball_df[Column.IN_PLAY].astype(bool).tolist()
        if Column.IN_PLAY in ball_df.columns else [True] * len(frame_ids)
    )

    # Each period starts at a standard frame count (P1 10000, P2 100000, ...).
    period_frame_offsets: dict[int, int] = {}
    for period_id in sorted(ball_df[Column.PERIOD_ID].dropna().unique()):
        pid = int(period_id)
        min_frame = int(ball_df.loc[ball_df[Column.PERIOD_ID] == period_id, Column.IMPLIED_100HZ_FRAME_COUNT].min())
        period_frame_offsets[pid] = int((10000 if pid == 1 else (pid - 1) * 100000) - min_frame)

    frame_meta = {
        "period": ball_df[Column.PERIOD_ID].astype(int).tolist(),
        "time": (ball_df[Column.IMPLIED_100HZ_FRAME_COUNT] / 100.0).round(2).tolist(),
        "impliedFrame": ball_df[Column.IMPLIED_100HZ_FRAME_COUNT].astype(int).tolist(),
        "periodFrameOffsets": period_frame_offsets,
        "inPlay": in_play,
    }

    n_frames = len(frame_ids)
    ball_mask = df[Column.TRACKING_GROUP_ID] == BALL_GROUP_ID
    src_payload: list[dict] = []
    for sid in src_ids:
        conf = sources[sid]

        # Possession (ball rows carry the id of the player in possession)
        possession: list[dict | None] = [None] * n_frames
        pj, pg = f"{sid}_possession_j", f"{sid}_possession_g"
        if pj in df.columns and pg in df.columns:
            poss = df[ball_mask & df[pj].notna() & df[pg].notna() & has_frame].drop_duplicates(
                subset=[Column.CONTINUOUS_FRAME_COUNT]
            )
            for fi, g, j in zip(fi_col[poss.index].astype(int), poss[pg], poss[pj], strict=True):
                possession[fi] = {"g": int(g), "j": int(j)}

        # Detection ("in view") per frame: list of "g:j" keys, or null
        detected: list[list[str] | None] = [None] * n_frames
        det_col = f"{sid}_is_detected"
        if det_col in df.columns:
            det = df[(~ball_mask) & df[det_col].astype("boolean").fillna(False) & has_frame]
            keys = det[Column.TRACKING_GROUP_ID].astype(str) + ":" + det[Column.JERSEY_NUMBER].astype(str)
            for fi, members in keys.groupby(fi_col[det.index].astype(int)):
                detected[int(fi)] = members.tolist()

        src_payload.append(
            {
                "id": sid,
                "label": conf.label_name,
                "fill": bool(conf.facecolor_fill),
                "alpha": float(conf.alpha),
                "dash": conf.linestyle not in ("-", "solid"),
                "prefix": conf.player_number_prefix or "",
                "suffix": conf.player_number_suffix or "",
                "possession": possession,
                "detected": detected,
            }
        )

    # ── Entities (sparse per-source positions, indexed by frame index) ────────
    primary_det = f"{src_ids[0]}_is_detected"
    entities: list[dict] = []
    for (group_id, jersey_no), ent in df.groupby([Column.TRACKING_GROUP_ID, Column.JERSEY_NUMBER]):
        ent_fi = fi_col[ent.index]
        per_source: dict[str, dict] = {}
        for sid in src_ids:
            x_col, y_col = f"{sid}_x", f"{sid}_y"
            ok = ent[x_col].notna() & ent[y_col].notna() & ent_fi.notna()
            if not ok.any():
                continue
            valid = ent[ok]
            entry: dict = {
                "fi": ent_fi[ok].astype(int).tolist(),
                "x": valid[x_col].round(2).tolist(),
                "y": valid[y_col].round(2).tolist(),
            }
            z_col = f"{sid}_z"
            if z_col in ent.columns and ent[z_col].notna().any():
                entry["z"] = valid[z_col].fillna(0).round(2).tolist()
            per_source[sid] = entry
        if not per_source:
            continue
        entity: dict = {"g": int(group_id), "j": int(jersey_no), "s": per_source}
        if Column.IS_GOALKEEPER in ent.columns and bool(ent[Column.IS_GOALKEEPER].fillna(False).astype(bool).any()):
            entity["gk"] = True
        if primary_det in ent.columns:
            seen = ent[ent[primary_det].astype("boolean").fillna(False).astype(bool) & ent_fi.notna()]
            if not seen.empty:
                entity["bv"] = fi_col[seen.index].astype(int).tolist()
        entities.append(entity)

    # Period start (tracking clock, seconds) - lets the video sync use period-relative time.
    period_start_times = {
        str(int(pid)): round(float(grp[Column.IMPLIED_100HZ_FRAME_COUNT].min()) / 100.0, 2)
        for pid, grp in ball_df.groupby(Column.PERIOD_ID)
    }

    lineup = lineup or {}
    phases_by_period, runs_by_period, pressures_payload = build_context_panels(lineup, phases, runs, pressures)

    colors = dict(_TEAM_COLORS)
    for k, v in (team_colors or {}).items():
        if k in colors and isinstance(v, str) and _HEX_RE.match(v):
            colors[k] = v

    payload = {
        "pitch": {"L": 105.0, "W": 68.0},
        "sources": src_payload,
        "colors": {str(k): v for k, v in colors.items()},
        "frameIds": frame_ids,
        "meta": frame_meta,
        "entities": entities,
        "events": _events_payload(events, frame_ids, df, lineup),
        "lineup": lineup,
        "phases": phases_by_period,
        "runs": runs_by_period,
        "pressures": pressures_payload,
        "vodUrls": {str(k): v for k, v in (vod_urls or {}).items()},
        "ballImage": _ball_image_data_url(),
        "periodStartTimes": period_start_times,
        "kickoffFrameCounts": {1: 10000, 2: 100000, 3: 2000000, 4: 3000000},
    }
    # Neutralise markup in the free-text parts (not numeric arrays or URLs).
    for key in ("sources", "lineup", "events", "phases", "runs", "pressures"):
        payload[key] = _neutralise(payload[key])
    return payload


def _events_payload(
    events: pd.DataFrame | None,
    frame_ids: list[int],
    df: pd.DataFrame,
    lineup: dict[str, str],
) -> list[dict]:
    """Events as ``{fi, t, x, y, g, p, jn, ti, eid, quals}`` sorted by frame index."""
    if events is None or events.empty or not frame_ids:
        return []
    # Continuous frame count of each event = implied/4 + that period's offset.
    offsets = (df[Column.CONTINUOUS_FRAME_COUNT] - df[Column.IMPLIED_100HZ_FRAME_COUNT] // 4).groupby(df[Column.PERIOD_ID]).first()
    ev = events[events[Column.PERIOD_ID].isin(offsets.index)].copy()
    if ev.empty:
        return []
    cont = (ev[Column.IMPLIED_100HZ_FRAME_COUNT] // 4) + ev[Column.PERIOD_ID].map(offsets)
    frames = np.asarray(frame_ids)
    pos = np.clip(np.searchsorted(frames, cont.to_numpy()), 1, len(frames) - 1) if len(frames) > 1 else np.zeros(len(ev), int)
    if len(frames) > 1:
        left, right = frames[pos - 1], frames[pos]
        pos = np.where(np.abs(cont.to_numpy() - left) <= np.abs(right - cont.to_numpy()), pos - 1, pos)
    ev["fi"] = pos
    ev = ev.sort_values("fi")

    out = []
    for r in ev.itertuples(index=False):
        gj = lineup.get(f"gj_{r.player_uuid}", "")
        group = jersey = None
        if gj:
            group, jersey = (int(v) for v in gj.split(":"))
        elif r.contestant_id and f"ctg_{r.contestant_id}" in lineup:
            group = int(lineup[f"ctg_{r.contestant_id}"])
        out.append(
            {
                "fi": int(r.fi),
                "t": r.event_type_desc,
                "x": round(float(r.event_x), 2),
                "y": round(float(r.event_y), 2),
                "g": int(group or 0),
                "p": int(getattr(r, Column.PERIOD_ID)),
                "jn": jersey,
                "ti": (group - 1) if group in (1, 2) else None,
                "eid": int(r.opta_event_id),
                "quals": r.qualifiers,
            }
        )
    return out
