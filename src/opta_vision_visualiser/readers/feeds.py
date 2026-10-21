"""Ancillary match feeds: match stats (lineup / kit colours), phases of play, player runs, pressure.

Every function accepts either the full feed payload (``dict``) or the already
extracted list, so files saved from the API or hand-trimmed both work.
"""

from __future__ import annotations

import copy
from typing import Any

import pandas as pd

from opta_vision_visualiser.readers.epts import EptsMetadata


def extract_phases(feed: Any) -> list[dict]:
    if isinstance(feed, list):
        return [p for p in feed if isinstance(p, dict)]
    if isinstance(feed, dict):
        return list(((feed.get("liveData") or {}).get("phaseByPhase") or {}).get("phase") or [])
    return []


def extract_runs(feed: Any) -> list[dict]:
    if isinstance(feed, list):
        return [r for r in feed if isinstance(r, dict)]
    if isinstance(feed, dict):
        return list(((feed.get("liveData") or {}).get("runByRun") or {}).get("run") or [])
    return []


def _period(event: dict) -> int | None:
    try:
        return int(event.get("periodId"))
    except (TypeError, ValueError):
        return None


def extract_pressure_events(
    events_feed: Any, directions: dict[tuple[int, str], int]
) -> list[dict]:
    """Events that carry a ``pressure`` node (raw dicts, as the animation expects).

    Positions in the feed (the event's own x/y and each pressing player's
    ``positionX/Y``) are relative to the event team's attacking direction. When
    they are rotated 180 degrees (``v -> 100 - v``) for teams attacking right-to-left
    (per ``directions``, from the EPTS XML) so they match absolute tracking coordinates.
    """
    if isinstance(events_feed, dict):
        events = (events_feed.get("liveData") or {}).get("event") or []
    elif isinstance(events_feed, list):
        events = events_feed
    else:
        return []
    played = {period for period, _ in directions}  # periods covered by the tracking
    selected = [
        e for e in events
        if isinstance(e, dict) and (e.get("pressure") or {}).get("player") and _period(e) in played
    ]
    def flip(value: Any) -> Any:
        try:
            return str(round(100.0 - float(value), 2))
        except (TypeError, ValueError):
            return value

    out = []
    for e in selected:
        try:
            direction = directions[(int(e.get("periodId", 0)), e.get("contestantId", ""))]
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("No direction of play in the EPTS metadata for a pressure event.") from exc
        if direction == -1:
            e = copy.deepcopy(e)
            e["x"], e["y"] = flip(e.get("x")), flip(e.get("y"))
            for prs in e["pressure"]["player"]:
                prs["positionX"], prs["positionY"] = flip(prs.get("positionX")), flip(prs.get("positionY"))
        out.append(e)
    return out


def build_lineup(
    meta: EptsMetadata,
    matchstats: dict | None = None,
    events: pd.DataFrame | None = None,
) -> dict[str, str]:
    """Build the flat lookup dictionary consumed by the pitch component.

    Keys:
      ``teamname_1`` / ``teamname_2``      team display names (home / away)
      ``ctg_<contestantId>``               contestant -> tracking group ("1" / "2")
      ``gj_<playerUuid>``                  player uuid -> "<group>:<jersey>"
      ``<playerUuid>``                     player uuid -> display name
      ``<group>:<jersey>``                 "<group>:<jersey>" -> display name
      ``kit_1`` / ``kit_2``                kit colour (#rrggbb) when available
      ``match_*``                          competition, date and score for the title bar

    Names come from the match stats feed when supplied, otherwise from the
    events feed (``playerName``), otherwise are left blank (shown as #jersey).
    """
    lookup: dict[str, str] = {}
    if meta:
        for team_uuid, group in meta.team_groups.items():
            lookup[f"ctg_{team_uuid}"] = str(group)
        for uuid, p in meta.players.items():
            lookup[f"gj_{uuid}"] = f"{p.tracking_group_id}:{p.jersey_no}"
            if p.name:
                lookup[uuid] = p.name
                lookup[f"{p.tracking_group_id}:{p.jersey_no}"] = p.name

    def set_name(uuid: str, name: str) -> None:
        if not (uuid and name and meta and uuid in meta.players):
            return
        p = meta.players[uuid]
        lookup[uuid] = name
        lookup[f"{p.tracking_group_id}:{p.jersey_no}"] = name

    if events is not None and not events.empty and "player_name" in events.columns:
        for uuid, name in events[["player_uuid", "player_name"]].drop_duplicates().itertuples(index=False):
            set_name(uuid, name)

    if matchstats:
        info = matchstats.get("matchInfo") or {}
        contestant_group: dict[str, int] = {}
        for c in info.get("contestant") or []:
            cid, pos = c.get("id", ""), c.get("position", "")
            group = 1 if pos == "home" else 2 if pos == "away" else 0
            if cid and group:
                contestant_group[cid] = group
                lookup[f"teamname_{group}"] = c.get("shortName") or c.get("name", "")
                lookup[f"ctg_{cid}"] = str(group)
        live = matchstats.get("liveData") or {}
        total = ((live.get("matchDetails") or {}).get("scores") or {}).get("total") or {}
        lookup["match_home_score"] = str(total.get("home", ""))
        lookup["match_away_score"] = str(total.get("away", ""))
        comp = info.get("competition") or {}
        lookup["match_comp"] = comp.get("knownName") or comp.get("name", "")
        lookup["match_date"] = str(info.get("date", "")).rstrip("Z")
        for team in live.get("lineUp") or []:
            group = contestant_group.get(team.get("contestantId", ""), 0)
            if not group:
                continue
            colour = (team.get("kit") or {}).get("colour1", "")
            if isinstance(colour, str) and len(colour) == 7 and colour.startswith("#"):
                lookup[f"kit_{group}"] = colour
            for player in team.get("player") or []:
                set_name(player.get("playerId", ""), player.get("matchName", ""))
                pid, shirt, name = player.get("playerId", ""), player.get("shirtNumber"), player.get("matchName", "")
                # Keep g:j lookups for players that are absent from the EPTS metadata.
                if pid and shirt is not None:
                    lookup.setdefault(f"gj_{pid}", f"{group}:{int(shirt)}")
                if shirt is not None and name:
                    lookup[f"{group}:{int(shirt)}"] = name
                    lookup.setdefault(pid, name)
    return lookup
