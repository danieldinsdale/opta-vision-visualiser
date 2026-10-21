"""Reader for EPTS tracking data (FIFA EPTS text frames + XML format specification).

Accepted inputs
---------------
* the raw data text (``*_epts_raw_data.txt``) and the XML format specification
  (``*_epts_format_specification.xml``) as two separate files, or
* a ``.tar.gz`` / ``.tar`` / ``.zip`` bundle containing both.

Raw data line layout (one line per frame, 25 Hz)::

    <frame>:<uuid,x,y,speed,visible;...>:<ball x,y,z,speed,visible,period,
    event ids ('|' separated),team in possession,player in possession,
    matched time (ms)>:

XML parsing uses ``defusedxml`` so hostile uploads cannot trigger entity
expansion or external entity resolution. Archives are never extracted to
disk; only the two expected members are read, with a size cap.
"""

from __future__ import annotations

import io
import tarfile
import zipfile
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd
from defusedxml import ElementTree as SafeET

from opta_vision_visualiser.columns import BALL_GROUP_ID, Column
from opta_vision_visualiser.limits import (
    MAX_ARCHIVE_MEMBER_BYTES,
    MAX_BAD_LINE_FRACTION,
)

EPTS_XML_SUFFIX = "_epts_format_specification.xml"
EPTS_TXT_SUFFIX = "_epts_raw_data.txt"


class EptsFormatError(ValueError):
    """Raised when an EPTS input is malformed or unsafe to read."""


@dataclass
class PlayerInfo:
    team_uuid: str
    jersey_no: int
    tracking_group_id: int  # 1 = home, 2 = away
    is_goalkeeper: bool
    name: str = ""


@dataclass
class EptsMetadata:
    players: dict[str, PlayerInfo] = field(default_factory=dict)
    # Team uuid -> tracking group id (1 = home, 2 = away)
    team_groups: dict[str, int] = field(default_factory=dict)
    match_uuid: str = ""
    # (period id, team uuid) -> +1 if the team attacks left-to-right (towards +x), -1 if right-to-left.
    directions: dict[tuple[int, str], int] = field(default_factory=dict)


# ── Metadata ──────────────────────────────────────────────────────────────────


def _parse_player_name(player: Any) -> str:
    for tag in ("Shortname", "ShortName", "Name", "LastName", "FirstName"):
        el = player.find(tag)
        if el is not None and el.text and el.text.strip():
            return el.text.strip()
    return ""


def parse_epts_metadata(xml: bytes | str) -> EptsMetadata:
    """Parse the EPTS XML format specification into player / team lookups."""
    try:
        root = SafeET.fromstring(xml)
    except Exception as exc:  # defusedxml raises several distinct types
        raise EptsFormatError(f"EPTS metadata XML could not be parsed: {type(exc).__name__}") from None

    meta = EptsMetadata()
    for param in root.iter("ProviderParameter"):
        name = param.find("Name")
        value = param.find("Value")
        if name is not None and name.text == "match_uuid" and value is not None and value.text:
            meta.match_uuid = value.text.strip()
            break

    for player in root.iter("Player"):
        uuid = player.attrib.get("id")
        team = player.attrib.get("teamId")
        shirt = player.find("ShirtNumber")
        ptype = player.find("ProviderPlayerParameters/ProviderParameter/Value")
        if not uuid or not team or shirt is None or ptype is None:
            raise EptsFormatError(f"Player entry {uuid!r} is missing id, team, shirt number or type")
        try:
            jersey = int(shirt.text or "")
            type_code = int(ptype.text or "")
        except ValueError:
            raise EptsFormatError(f"Player {uuid!r} has a non-numeric shirt number or type") from None
        # Provider type codes: 0 home outfield, 1 away outfield, 3 home GK, 4 away GK
        is_gk = type_code in (3, 4)
        group = (type_code - 3 if is_gk else type_code) + 1
        if group not in (1, 2):
            raise EptsFormatError(f"Player {uuid!r} has unsupported provider type {type_code}")
        meta.players[uuid] = PlayerInfo(team, jersey, group, is_gk, _parse_player_name(player))
        meta.team_groups[team] = group

    if not meta.players:
        raise EptsFormatError("EPTS metadata contains no players")

    for period in root.findall(".//DirectionsOfPlay/Period"):
        try:
            period_id = int(period.attrib["id"])
        except (KeyError, ValueError):
            continue
        for team in period.findall("Team"):
            value = (team.findtext("DirectionOfPlay") or "").strip()
            if team.attrib.get("id") and value in ("LeftToRight", "RightToLeft"):
                meta.directions[(period_id, team.attrib["id"])] = 1 if value == "LeftToRight" else -1
    if not meta.directions:
        raise EptsFormatError("EPTS metadata has no DirectionsOfPlay")
    return meta


# ── Frame data ────────────────────────────────────────────────────────────────


def parse_epts_frames(raw: str, meta: EptsMetadata) -> pd.DataFrame:
    """Parse the EPTS raw text into a long-format DataFrame (one row per entity per frame)."""
    cols: dict[str, list] = {
        "frame_id": [],
        "player_uuid": [],
        Column.IS_BALL: [],
        "pos_x": [],
        "pos_y": [],
        "pos_z": [],
        "speed": [],
        Column.BROADCAST_VISIBLE: [],
        Column.PERIOD_ID: [],
        "matched_time": [],
        "opta_event_ids": [],
        "team_in_possession": [],
        "player_in_possession": [],
    }
    nan = float("nan")
    total = bad = 0
    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        total += 1
        try:
            frame_s, players_s, ball_s, _ = line.split(":")
            ball = ball_s.split(",")
            bx, by, bz, bspeed, bvis, period, event_ids, team_poss, player_poss, matched = ball
            frame_id = int(frame_s)
            period_id = int(period)
            matched_time = int(matched)
            player_rows = []
            for chunk in players_s.split(";"):
                if not chunk.strip():
                    continue
                uuid, px, py, pspeed, pvis = chunk.split(",")
                player_rows.append(
                    (uuid, float(px) if px else nan, float(py) if py else nan,
                     float(pspeed) if pspeed else nan, int(pvis))
                )
            ball_row = (
                float(bx) if bx else nan, float(by) if by else nan, float(bz) if bz else nan,
                float(bspeed) if bspeed else nan, int(bvis),
            )
        except ValueError:
            bad += 1
            continue

        cols["frame_id"].append(frame_id)
        cols["player_uuid"].append(None)
        cols[Column.IS_BALL].append(True)
        cols["pos_x"].append(ball_row[0])
        cols["pos_y"].append(ball_row[1])
        cols["pos_z"].append(ball_row[2])
        cols["speed"].append(ball_row[3])
        cols[Column.BROADCAST_VISIBLE].append(ball_row[4])
        cols[Column.PERIOD_ID].append(period_id)
        cols["matched_time"].append(matched_time)
        cols["opta_event_ids"].append(event_ids)
        cols["team_in_possession"].append(team_poss)
        cols["player_in_possession"].append(player_poss)
        for uuid, px, py, pspeed, pvis in player_rows:
            cols["frame_id"].append(frame_id)
            cols["player_uuid"].append(uuid)
            cols[Column.IS_BALL].append(False)
            cols["pos_x"].append(px)
            cols["pos_y"].append(py)
            cols["pos_z"].append(nan)
            cols["speed"].append(pspeed)
            cols[Column.BROADCAST_VISIBLE].append(pvis)
            cols[Column.PERIOD_ID].append(period_id)
            cols["matched_time"].append(matched_time)
            cols["opta_event_ids"].append("")
            cols["team_in_possession"].append("")
            cols["player_in_possession"].append("")

    if total == 0:
        raise EptsFormatError("EPTS raw data file is empty")
    if bad / total > MAX_BAD_LINE_FRACTION:
        raise EptsFormatError(
            f"{bad} of {total} EPTS lines could not be parsed - is this a 25 Hz EPTS raw data file?"
        )

    df = pd.DataFrame(cols)
    info = meta.players
    df["team_uuid"] = df["player_uuid"].map({u: p.team_uuid for u, p in info.items()})
    df[Column.TRACKING_GROUP_ID] = (
        df["player_uuid"].map({u: p.tracking_group_id for u, p in info.items()}).fillna(BALL_GROUP_ID).astype(int)
    )
    df[Column.JERSEY_NUMBER] = (
        df["player_uuid"].map({u: p.jersey_no for u, p in info.items()}).fillna(-1).astype(int)
    )
    df["player_name"] = df["player_uuid"].map({u: p.name for u, p in info.items()}).fillna("")
    df[Column.IS_GOALKEEPER] = df["player_uuid"].map({u: p.is_goalkeeper for u, p in info.items()}).eq(True)

    # Rows for players that are not in the metadata cannot be identified - drop them.
    unknown = (~df[Column.IS_BALL]) & df["team_uuid"].isna()
    if unknown.any():
        df = df[~unknown].reset_index(drop=True)
    return df


def to_source_frame(df: pd.DataFrame, meta: EptsMetadata, source_id: str) -> pd.DataFrame:
    """Reduce a parsed EPTS frame to the per-source columns the visualiser merges on."""
    out = pd.DataFrame(
        {
            Column.PERIOD_ID: df[Column.PERIOD_ID].astype(int),
            Column.IMPLIED_100HZ_FRAME_COUNT: (df["matched_time"] / 10).round(0).astype(int),
            Column.TRACKING_GROUP_ID: df[Column.TRACKING_GROUP_ID],
            Column.JERSEY_NUMBER: df[Column.JERSEY_NUMBER],
            Column.IS_BALL: df[Column.IS_BALL],
            Column.IS_GOALKEEPER: df[Column.IS_GOALKEEPER],
            f"{source_id}_x": df["pos_x"].astype("float32"),
            f"{source_id}_y": df["pos_y"].astype("float32"),
            f"{source_id}_z": df["pos_z"].astype("float32"),
            f"{source_id}_is_detected": df[Column.BROADCAST_VISIBLE].astype(bool),
        }
    )
    # Possession: the player holding the ball is flagged on the ball row.
    poss = df["player_in_possession"].replace("", np.nan)
    out[f"{source_id}_possession_g"] = poss.map({u: p.tracking_group_id for u, p in meta.players.items()})
    out[f"{source_id}_possession_j"] = poss.map({u: p.jersey_no for u, p in meta.players.items()})
    # Event ids ride along on ball rows so events can be placed on the timeline.
    out["opta_event_ids"] = df["opta_event_ids"]
    out = out.drop_duplicates(
        subset=[Column.PERIOD_ID, Column.IMPLIED_100HZ_FRAME_COUNT, Column.TRACKING_GROUP_ID,
                Column.JERSEY_NUMBER, Column.IS_BALL]
    )
    return out.reset_index(drop=True)


# ── Containers ────────────────────────────────────────────────────────────────


def _read_member(handle: Any, name: str, size: int) -> bytes:
    if size > MAX_ARCHIVE_MEMBER_BYTES:
        raise EptsFormatError(f"Archive member {name!r} exceeds the size limit")
    data = handle.read(MAX_ARCHIVE_MEMBER_BYTES + 1)
    if len(data) > MAX_ARCHIVE_MEMBER_BYTES:
        raise EptsFormatError(f"Archive member {name!r} exceeds the size limit")
    return data


def read_epts_bundle(data: bytes) -> tuple[bytes, bytes]:
    """Return ``(raw_txt_bytes, xml_bytes)`` from a tar / tar.gz / zip bundle.

    Members are matched by suffix and read in memory - nothing is extracted to
    disk, so path-traversal entries in a hostile archive have no effect.
    """
    txt = xml = None
    buf = io.BytesIO(data)
    if zipfile.is_zipfile(buf):
        with zipfile.ZipFile(buf) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                with zf.open(info) as fh:
                    if info.filename.endswith(EPTS_TXT_SUFFIX) and txt is None:
                        txt = _read_member(fh, info.filename, info.file_size)
                    elif info.filename.endswith(EPTS_XML_SUFFIX) and xml is None:
                        xml = _read_member(fh, info.filename, info.file_size)
    else:
        buf.seek(0)
        try:
            with tarfile.open(fileobj=buf, mode="r:*") as tf:
                for member in tf:
                    if not member.isfile():
                        continue
                    if member.name.endswith(EPTS_TXT_SUFFIX) and txt is None:
                        txt = _read_member(tf.extractfile(member), member.name, member.size)
                    elif member.name.endswith(EPTS_XML_SUFFIX) and xml is None:
                        xml = _read_member(tf.extractfile(member), member.name, member.size)
        except tarfile.TarError:
            raise EptsFormatError("File is not a valid tar/tar.gz/zip archive") from None
    if txt is None or xml is None:
        raise EptsFormatError(
            f"Archive must contain a '*{EPTS_TXT_SUFFIX}' and a '*{EPTS_XML_SUFFIX}' file"
        )
    return txt, xml


def load_epts(raw_txt: bytes | str, xml: bytes | str, source_id: str) -> tuple[pd.DataFrame, EptsMetadata]:
    """Parse an EPTS raw/metadata pair into ``(source frame, metadata)``."""
    meta = parse_epts_metadata(xml)
    text = raw_txt.decode("utf-8", errors="strict") if isinstance(raw_txt, bytes) else raw_txt
    frames = parse_epts_frames(text, meta)
    return to_source_frame(frames, meta, source_id), meta
