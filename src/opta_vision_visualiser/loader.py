"""Assemble tracking, events and ancillary feeds into one ready-to-render match."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import pandas as pd

from opta_vision_visualiser.columns import Column
from opta_vision_visualiser.readers import epts as epts_reader
from opta_vision_visualiser.readers import events as events_reader
from opta_vision_visualiser.readers import feeds

logger = logging.getLogger(__name__)

_MERGE_KEYS = [
    Column.PERIOD_ID,
    Column.IMPLIED_100HZ_FRAME_COUNT,
    Column.TRACKING_GROUP_ID,
    Column.JERSEY_NUMBER,
    Column.IS_BALL,
]
_HEX_COLOUR_LEN = 7


@dataclass
class TrackingInput:
    """The EPTS dataset: raw frame text plus its XML format specification."""

    raw_txt: bytes
    xml: bytes


@dataclass
class LoadedMatch:
    df: pd.DataFrame
    events: pd.DataFrame = field(default_factory=pd.DataFrame)
    event_stats: dict[str, int] = field(default_factory=dict)
    lineup: dict[str, str] = field(default_factory=dict)
    phases: list[dict] = field(default_factory=list)
    runs: list[dict] = field(default_factory=list)
    pressures: list[dict] = field(default_factory=list)
    team_colors: dict[int, str] | None = None
    warnings: list[str] = field(default_factory=list)
    match_uuid: str = ""


def add_continuous_frame_count(df: pd.DataFrame) -> pd.Series:
    """Frame counter that keeps running across periods (25 Hz frames)."""
    frames = (df[Column.IMPLIED_100HZ_FRAME_COUNT] // 4).astype("int64")
    offsets: dict[int, int] = {}
    running = 0
    for period in sorted(df[Column.PERIOD_ID].dropna().unique()):
        offsets[int(period)] = running
        running += int(frames[df[Column.PERIOD_ID] == period].max()) + 1
    return frames + df[Column.PERIOD_ID].map(offsets).astype("int64")


SOURCE_ID = "epts"


def build_match(
    tracking: TrackingInput,
    events_feed: dict | None = None,
    matchstats: dict | None = None,
    phases_feed: object | None = None,
    runs_feed: object | None = None,
) -> LoadedMatch:
    """Parse everything supplied. Raises ``EptsFormatError`` / ``ValueError`` on bad input."""
    warnings: list[str] = []
    df, meta = epts_reader.load_epts(tracking.raw_txt, tracking.xml, SOURCE_ID)
    df[Column.CONTINUOUS_FRAME_COUNT] = add_continuous_frame_count(df)
    df[Column.IS_BALL] = df[Column.IS_BALL].astype(bool)

    events = pd.DataFrame()
    event_stats: dict[str, int] = {}
    pressures: list[dict] = []
    if events_feed:
        directions = meta.directions  # from the EPTS XML DirectionsOfPlay
        parsed = events_reader.parse_remote_events(events_feed)
        parsed = parsed[(parsed["event_type_desc"] != "deleted_event")].dropna(subset=["event_x", "event_y"])
        # Pre-/post-match periods in the feed (e.g. 14, 16) have no tracking, so no pitch position.
        parsed = parsed[parsed[Column.PERIOD_ID].astype(int).isin({p for p, _ in directions})]
        parsed = events_reader.apply_attacking_direction(parsed, directions)
        events, event_stats = events_reader.place_events(parsed, df)
        pressures = feeds.extract_pressure_events(events_feed, directions)
        if event_stats.get("dropped"):
            warnings.append(f"{event_stats['dropped']} events could not be placed on the tracking timeline.")
        if event_stats.get("estimated"):
            logger.info("%d events were placed by clock time (approximate).", event_stats["estimated"])

    lineup = feeds.build_lineup(meta, matchstats, events if not events.empty else None)
    kits = {g: lineup[f"kit_{g}"] for g in (1, 2) if f"kit_{g}" in lineup}

    return LoadedMatch(
        df=df,
        events=events,
        event_stats=event_stats,
        lineup=lineup,
        phases=feeds.extract_phases(phases_feed) if phases_feed else [],
        runs=feeds.extract_runs(runs_feed) if runs_feed else [],
        pressures=pressures,
        team_colors=kits or None,
        warnings=warnings,
        match_uuid=meta.match_uuid,
    )
