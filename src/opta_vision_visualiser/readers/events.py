"""Opta event feed reader (``remoteevents`` JSON) and placement onto the EPTS timeline.

Event x/y arrive on the Opta 0-100 scale and are converted to metres, centre
origin (+/-52.5, +/-34). In the feed every event is expressed from the acting
team's point of view (that team always attacks towards +x), whereas EPTS uses
absolute coordinates. ``apply_attacking_direction`` therefore rotates events by
teams attacking right-to-left by 180 degrees. (Validated against two matches of
raw feed events matched to EPTS ball positions: ~0.7 m median error for
left-to-right teams directly, ~0.7 m for right-to-left teams after rotation,
~40 m without it.)

Placement onto the tracking timeline, in order of preference:
  1. exact match of the event ``id`` against the ids carried on EPTS ball rows;
  2. ``trackingDataVideoTimeMs`` minus the per-period offset learned from (1);
  3. period-relative match clock (``timeMin`` / ``timeSec``) - second precision.
"""

from __future__ import annotations

import json
from importlib import resources
from typing import Any

import numpy as np
import pandas as pd

from opta_vision_visualiser.columns import Column
from opta_vision_visualiser.limits import MAX_JSON_BYTES


def _load_event_type_names() -> dict[int, str]:
    """Opta event type id -> name, from the bundled ``data/event_type_names.json``."""
    raw = resources.files("opta_vision_visualiser").joinpath("data/event_type_names.json").read_text("utf-8")
    return {int(k): v for k, v in json.loads(raw)["event_types"].items()}


# Ids missing from the file render as ``type_<id>``.
EVENT_TYPE_NAMES: dict[int, str] = _load_event_type_names()


def _load_qualifier_names() -> dict[int, str]:
    """Opta qualifier id -> name, from the bundled ``data/qualifier_names.json``."""
    raw = resources.files("opta_vision_visualiser").joinpath("data/qualifier_names.json").read_text("utf-8")
    return {int(k): v for k, v in json.loads(raw)["qualifiers"].items()}


# Ids missing from the file are shown as their number.
QUALIFIER_NAMES: dict[int, str] = _load_qualifier_names()

EVENT_COLUMNS = [
    "opta_event_id", "event_type_id", "event_type_desc", Column.PERIOD_ID, "contestant_id",
    "player_uuid", "player_name", "event_x", "event_y", "outcome", "qualifiers", "video_time_ms",
    "period_seconds",
]


def load_json_bytes(data: bytes, what: str) -> Any:
    """Parse uploaded / downloaded JSON with a size guard."""
    if len(data) > MAX_JSON_BYTES:
        raise ValueError(f"{what} exceeds the {MAX_JSON_BYTES // (1024 * 1024)} MB limit")
    try:
        return json.loads(data)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{what} is not valid JSON ({exc.msg} at char {exc.pos})") from None


def _to_float(value: Any) -> float:
    try:
        return float(value) if value not in (None, "") else float("nan")
    except (TypeError, ValueError):
        return float("nan")


def parse_remote_events(feed: dict) -> pd.DataFrame:
    """Parse a ``remoteevents`` feed payload into a tidy events DataFrame."""
    raw_events = (feed.get("liveData") or {}).get("event") or []
    rows = []
    for e in raw_events:
        try:
            type_id = int(e["typeId"])
            event_id = int(e["id"])
            period = int(e.get("periodId", 0))
        except (KeyError, TypeError, ValueError):
            continue
        x, y = _to_float(e.get("x")), _to_float(e.get("y"))
        quals = []
        for q in e.get("qualifier") or []:
            try:
                qid = int(q["qualifierId"])
            except (KeyError, TypeError, ValueError):
                continue
            quals.append({"id": qid, "name": QUALIFIER_NAMES.get(qid, str(qid))})
        try:
            period_seconds = (int(e.get("timeMin", 0)) - max(period - 1, 0) * 45) * 60 + int(e.get("timeSec", 0))
        except (TypeError, ValueError):
            period_seconds = float("nan")
        rows.append(
            {
                "opta_event_id": event_id,
                "event_type_id": type_id,
                "event_type_desc": EVENT_TYPE_NAMES.get(type_id, f"type_{type_id}"),
                Column.PERIOD_ID: period,
                "contestant_id": e.get("contestantId") or "",
                "player_uuid": e.get("playerId") or "",
                "player_name": e.get("playerName") or "",
                "event_x": x * 1.05 - 52.5,
                "event_y": y * 0.68 - 34.0,
                "outcome": e.get("outcome"),
                "qualifiers": quals,
                "video_time_ms": _to_float(e.get("trackingDataVideoTimeMs")),
                "period_seconds": period_seconds,
            }
        )
    return pd.DataFrame(rows, columns=EVENT_COLUMNS)


def apply_attacking_direction(
    events: pd.DataFrame, directions: dict[tuple[int, str], int]
) -> pd.DataFrame:
    """Convert event coordinates from "team attacks left-to-right" to absolute pitch coordinates.

    The feed expresses every event from the acting team's point of view (each team
    attacks towards x=+52.5). Tracking uses absolute coordinates, so events by a team
    attacking right-to-left in that period are rotated 180 degrees about the centre spot.
    The direction of every (period, team) must be in ``directions`` (the EPTS XML
    ``DirectionsOfPlay``); a missing entry raises ``ValueError``.
    """
    if events.empty:
        return events
    keys = list(zip(events[Column.PERIOD_ID].astype(int), events["contestant_id"], strict=True))
    missing = sorted({k for k in keys if k not in directions}, key=str)
    if missing:
        raise ValueError(f"No direction of play in the EPTS metadata for (period, team): {missing[:3]}")
    sign = pd.Series([directions[k] for k in keys], index=events.index, dtype="float64")
    out = events.copy()
    out["event_x"] = out["event_x"] * sign
    out["event_y"] = out["event_y"] * sign
    return out


def place_events(events: pd.DataFrame, tracking: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, int]]:
    """Attach ``implied_100hz_frame_count`` to events using the tracking timeline.

    Returns the placed events and a small stats dict (matched / estimated / dropped).
    """
    stats = {"total": int(len(events)), "matched": 0, "estimated": 0, "dropped": 0}
    if events.empty:
        return events.assign(**{Column.IMPLIED_100HZ_FRAME_COUNT: pd.Series(dtype=int)}), stats

    ball = tracking[tracking[Column.IS_BALL] & tracking["opta_event_ids"].fillna("").ne("")]
    id_rows = []
    for frame, ids in zip(ball[Column.IMPLIED_100HZ_FRAME_COUNT], ball["opta_event_ids"], strict=True):
        for token in str(ids).split("|"):
            if token.strip().isdigit():
                id_rows.append((int(token), int(frame)))
    id_to_frame = dict(id_rows)

    out = events.copy()
    frame = out["opta_event_id"].map(id_to_frame)
    matched = frame.notna()
    stats["matched"] = int(matched.sum())

    # Per-period clock offset between feed video time and tracking time (centiseconds).
    offsets: dict[int, float] = {}
    m = out[matched & out["video_time_ms"].notna()]
    for period, grp in m.groupby(Column.PERIOD_ID):
        diff = grp["video_time_ms"] / 10.0 - frame[grp.index]
        offsets[int(period)] = float(np.median(diff))

    est = pd.Series(np.nan, index=out.index)
    for period, grp in out[~matched].groupby(Column.PERIOD_ID):
        p = int(period)
        if p in offsets:
            est[grp.index] = grp["video_time_ms"] / 10.0 - offsets[p]
        est_fallback = grp["period_seconds"] * 100.0
        est[grp.index] = est[grp.index].fillna(est_fallback)
    frame = frame.fillna(est)
    stats["estimated"] = int((~matched & frame.notna()).sum())
    out[Column.IMPLIED_100HZ_FRAME_COUNT] = frame.round(0)
    keep = out[Column.IMPLIED_100HZ_FRAME_COUNT].notna()
    stats["dropped"] = int((~keep).sum())
    out = out[keep].copy()
    out[Column.IMPLIED_100HZ_FRAME_COUNT] = out[Column.IMPLIED_100HZ_FRAME_COUNT].astype(int)
    return out.reset_index(drop=True), stats
