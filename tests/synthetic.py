"""Generate small, fully synthetic EPTS / event data for tests (no real match data)."""

from __future__ import annotations

import io
import math
import tarfile

HOME, AWAY = "teamhome000000000000000001", "teamaway000000000000000002"
MATCH = "synthmatch0000000000000001"


def _players() -> list[tuple[str, str, int, int]]:
    """(uuid, team, shirt, provider type) - 1 GK + 3 outfield per side."""
    out = []
    for team, gk_type, out_type in ((HOME, 3, 0), (AWAY, 4, 1)):
        prefix = "h" if team == HOME else "a"
        out.append((f"{prefix}player{1:019d}", team, 1, gk_type))
        for n in range(2, 5):
            out.append((f"{prefix}player{n:019d}", team, n, out_type))
    return out


def make_xml(match_uuid: str = MATCH, directions: bool = True) -> bytes:
    """EPTS metadata. Period 1: HOME attacks left-to-right (+x), AWAY right-to-left; reversed in period 2."""
    ltr, rtl = "LeftToRight", "RightToLeft"
    dirs = (
        "<DirectionsOfPlay>"
        f'<Period id="1"><Team id="{HOME}"><DirectionOfPlay>{ltr}</DirectionOfPlay></Team>'
        f'<Team id="{AWAY}"><DirectionOfPlay>{rtl}</DirectionOfPlay></Team></Period>'
        f'<Period id="2"><Team id="{HOME}"><DirectionOfPlay>{rtl}</DirectionOfPlay></Team>'
        f'<Team id="{AWAY}"><DirectionOfPlay>{ltr}</DirectionOfPlay></Team></Period>'
        "</DirectionsOfPlay>"
    ) if directions else ""
    players = "".join(
        f'<Player id="{u}" teamId="{t}"><ShirtNumber>{s}</ShirtNumber>'
        f"<ProviderPlayerParameters><ProviderParameter><Name>type</Name><Value>{ty}</Value>"
        f"</ProviderParameter></ProviderPlayerParameters></Player>"
        for u, t, s, ty in _players()
    )
    return (
        '<?xml version="1.1" encoding="UTF-8"?><tns:FIFADataTransferFormatEPTS xmlns:tns="x"><Metadata>'
        "<GlobalConfig><ProviderGlobalParameters><ProviderParameter><Name>match_uuid</Name>"
        f"<Value>{match_uuid}</Value></ProviderParameter></ProviderGlobalParameters></GlobalConfig>"
        f"{dirs}<Players>{players}</Players></Metadata></tns:FIFADataTransferFormatEPTS>"
    ).encode()


def make_raw(frames_per_period: int = 100, x_shift: float = 0.0, event_ids: dict[tuple[int, int], int] | None = None) -> bytes:
    """Frames at 25 Hz. Period 1 starts at frame 10000, period 2 at 1000000.

    ``event_ids`` maps (period, frame_index_in_period) -> opta event id carried on the ball row.
    """
    event_ids = event_ids or {}
    lines = []
    for period, start in ((1, 10000), (2, 1000000)):
        for i in range(frames_per_period):
            t = i / 25.0
            matched = i * 40
            # Teams swap ends at half time: HOME defends -x in period 1, +x in period 2.
            players = ";".join(
                f"{u},{(-20 + 10 * s) * (1 if team == HOME else -1) * (1 if period == 1 else -1) + 3 * math.sin(t) + x_shift:.4f},"
                f"{5 * (s - 2.5) + math.cos(t):.4f},1.0000,{1 if s != 3 else 0}"
                for u, team, s, _ in _players()
            ) + ";"
            ball_player = "hplayer0000000000000000002" if i % 20 < 10 else ""
            ball = (
                f"{10 * math.sin(t) + x_shift:.4f},{4 * math.cos(t):.4f},{abs(math.sin(t)):.4f},5.0000,1,{period},"
                f"{event_ids.get((period, i), '')},{HOME if ball_player else ''},{ball_player},{matched}"
            )
            lines.append(f"{start + i}:{players}:{ball}:")
    return ("\n".join(lines) + "\n").encode()


def make_bundle(raw: bytes, xml: bytes, name: str = MATCH) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for fname, data in ((f"{name}_epts_raw_data.txt", raw), (f"{name}_epts_format_specification.xml", xml)):
            info = tarfile.TarInfo(fname)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def make_events_feed(placed_ids: list[tuple[int, int]], unplaced_video_ms: int | None = 2000) -> dict:
    """Events feed. ``placed_ids`` are (event id, period) pairs that exist on EPTS ball rows."""
    events = []
    for n, (eid, period) in enumerate(placed_ids):
        events.append(
            {
                "id": eid, "typeId": 1, "periodId": period, "timeMin": (period - 1) * 45, "timeSec": n,
                "contestantId": HOME, "playerId": "hplayer0000000000000000002", "playerName": "A. Tester",
                "outcome": 1, "x": "50", "y": "50", "trackingDataVideoTimeMs": 1000 * n + 7000,
                "qualifier": [{"id": 1, "qualifierId": 1}, {"id": 2, "qualifierId": 999, "value": "x"}],
            }
        )
    if unplaced_video_ms is not None:
        events.append(
            {
                "id": 9_999_999, "typeId": 16, "periodId": 1, "timeMin": 0, "timeSec": 2, "contestantId": AWAY,
                "playerId": "aplayer0000000000000000003", "playerName": "<img src=x onerror=alert(1)>", "outcome": 1,
                "x": "10", "y": "20", "trackingDataVideoTimeMs": unplaced_video_ms + 7000,
            }
        )
    events.append({"id": 5, "typeId": 43, "periodId": 1, "x": "1", "y": "1"})  # deleted event
    events.append({"id": 6, "typeId": 32, "periodId": 1})  # no coordinates
    return {"liveData": {"event": events}}


def make_matchstats() -> dict:
    return {
        "matchInfo": {
            "date": "2026-01-02Z",
            "competition": {"name": "Test League"},
            "contestant": [
                {"id": HOME, "position": "home", "shortName": "Hometown"},
                {"id": AWAY, "position": "away", "name": "Awayville"},
            ],
        },
        "liveData": {
            "matchDetails": {"scores": {"total": {"home": 2, "away": 1}}},
            "lineUp": [
                {"contestantId": HOME, "kit": {"colour1": "#112233"},
                 "player": [{"playerId": "hplayer0000000000000000002", "matchName": "A. Tester", "shirtNumber": 2}]},
                {"contestantId": AWAY, "kit": {"colour1": "not-a-colour"}, "player": []},
            ],
        },
    }

