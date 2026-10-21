"""Events: placement, lineup, names, direction of play."""

import pytest
import synthetic as syn
from common import _match

from opta_vision_visualiser.columns import Column
from opta_vision_visualiser.loader import TrackingInput, build_match
from opta_vision_visualiser.readers import epts
from opta_vision_visualiser.readers import events as ev_reader


def test_events_placed_by_id_then_estimated():
    feed = syn.make_events_feed([(1001, 1), (1002, 1), (1003, 2)])
    m = _match(events_feed=feed)
    assert m.event_stats["matched"] == 3
    assert m.event_stats["estimated"] == 1  # the id-less goal, placed by video-time offset
    assert not any("clock" in w for w in m.warnings)  # estimation is logged, not shown
    assert m.event_stats["dropped"] == 0
    assert "deleted_event" not in set(m.events["event_type_desc"])
    assert len(m.events) == 4  # deleted + coordinate-less events removed
    goal = m.events[m.events["opta_event_id"] == 9_999_999].iloc[0]
    assert goal[Column.IMPLIED_100HZ_FRAME_COUNT] == 220  # 9000 ms video time minus the 6800 ms offset learned from id-matched events
    # Opta 0-100 -> metres, centre origin
    first = m.events[m.events["opta_event_id"] == 1001].iloc[0]
    assert first["event_x"] == pytest.approx(0.0) and first["event_y"] == pytest.approx(0.0)


def test_lineup_from_matchstats_and_colours():
    m = _match(events_feed=syn.make_events_feed([(1001, 1)]), matchstats=syn.make_matchstats())
    assert m.lineup["teamname_1"] == "Hometown" and m.lineup["teamname_2"] == "Awayville"
    assert m.lineup["1:2"] == "A. Tester"
    assert m.team_colors == {1: "#112233"}  # invalid colour ignored


def test_qualifier_names_cover_common_and_newer_ids():
    names = ev_reader.QUALIFIER_NAMES
    assert names[1] == "LONG_BALL" and names[152] == "DIRECT" and names[233] == "OPPOSITE_RELATED_EVENT_ID"
    assert len(names) > 400
    feed = {"liveData": {"event": [{"id": 1, "typeId": 1, "periodId": 1, "x": "1", "y": "1",
                                    "qualifier": [{"qualifierId": 152}, {"qualifierId": 99999}]}]}}
    quals = ev_reader.parse_remote_events(feed).iloc[0]["qualifiers"]
    assert quals == [{"id": 152, "name": "DIRECT"}, {"id": 99999, "name": "99999"}]


ACTORS = {  # (period, frame index) -> (opta event id, actor uuid, group, jersey, contestant)
    (1, 10): (2001, "hplayer0000000000000000002", 1, 2, syn.HOME),
    (1, 12): (2002, "aplayer0000000000000000003", 2, 3, syn.AWAY),
    (2, 10): (2003, "hplayer0000000000000000002", 1, 2, syn.HOME),
    (2, 12): (2004, "aplayer0000000000000000003", 2, 3, syn.AWAY),
}


def _feed_coords_for(abs_x: float, abs_y: float, attacks_right: bool) -> tuple[str, str]:
    """Inverse of the feed convention: absolute metres -> team-relative Opta 0-100."""
    rel_x, rel_y = (abs_x, abs_y) if attacks_right else (-abs_x, -abs_y)
    return str((rel_x + 52.5) / 1.05), str((rel_y + 34.0) / 0.68)


def test_direction_of_play_read_from_metadata_and_required():
    expected = {(1, syn.HOME): 1, (1, syn.AWAY): -1, (2, syn.HOME): -1, (2, syn.AWAY): 1}
    assert epts.parse_epts_metadata(syn.make_xml()).directions == expected
    with pytest.raises(epts.EptsFormatError, match="DirectionsOfPlay"):
        epts.parse_epts_metadata(syn.make_xml(directions=False))


def test_event_coordinates_match_tracking_for_both_directions_and_periods():
    """Regression for the left-to-right / right-to-left handling.

    Events are generated from the actor's real tracked position, expressed the way the
    feed expresses them (relative to the acting team's attack). After loading they must
    land back on the player - for teams attacking either way, in both halves.
    """
    ids = {k: v[0] for k, v in ACTORS.items()}
    raw, xml = syn.make_raw(event_ids=ids), syn.make_xml()
    base = build_match(TrackingInput(raw, xml))
    directions = epts.parse_epts_metadata(xml).directions

    events = []
    for (period, i), (eid, uuid, group, jersey, contestant) in ACTORS.items():
        row = base.df[
            (base.df[Column.PERIOD_ID] == period)
            & (base.df[Column.IMPLIED_100HZ_FRAME_COUNT] == i * 4)
            & (base.df[Column.TRACKING_GROUP_ID] == group)
            & (base.df[Column.JERSEY_NUMBER] == jersey)
        ].iloc[0]
        fx, fy = _feed_coords_for(float(row["epts_x"]), float(row["epts_y"]), directions[(period, contestant)] == 1)
        events.append({"id": eid, "typeId": 1, "periodId": period, "contestantId": contestant, "playerId": uuid,
                       "x": fx, "y": fy, "timeMin": 0, "timeSec": 0})
    m = build_match(TrackingInput(raw, xml), events_feed={"liveData": {"event": events}})

    assert len(m.events) == 4 and not m.warnings
    for (period, i), (eid, _uuid, group, jersey, _c) in ACTORS.items():
        ev = m.events[m.events["opta_event_id"] == eid].iloc[0]
        row = base.df[
            (base.df[Column.PERIOD_ID] == period)
            & (base.df[Column.IMPLIED_100HZ_FRAME_COUNT] == i * 4)
            & (base.df[Column.TRACKING_GROUP_ID] == group)
            & (base.df[Column.JERSEY_NUMBER] == jersey)
        ].iloc[0]
        assert ev["event_x"] == pytest.approx(float(row["epts_x"]), abs=0.05), (period, group)
        assert ev["event_y"] == pytest.approx(float(row["epts_y"]), abs=0.05), (period, group)


def test_pressure_positions_follow_the_same_direction_rule():
    from opta_vision_visualiser.readers.feeds import extract_pressure_events

    def ev(contestant):
        return {"id": 1, "periodId": 1, "contestantId": contestant, "x": "70", "y": "20",
                "pressure": {"player": [{"playerId": "p", "positionX": "75", "positionY": "30"}]}}

    directions = {(1, syn.HOME): 1, (1, syn.AWAY): -1}
    home, away = extract_pressure_events([ev(syn.HOME), ev(syn.AWAY)], directions)
    assert (home["x"], home["pressure"]["player"][0]["positionX"]) == ("70", "75")
    assert (away["x"], away["y"]) == ("30.0", "80.0")
    assert (away["pressure"]["player"][0]["positionX"], away["pressure"]["player"][0]["positionY"]) == ("25.0", "70.0")


def test_pre_and_post_match_periods_are_ignored():
    """Opta feeds carry events in periods 14 / 16 (no tracking, no direction); they must not break loading."""
    feed = syn.make_events_feed([(1001, 1), (1002, 1)])
    for period in (14, 16):
        feed["liveData"]["event"].append(
            {"id": 7000 + period, "typeId": 34, "periodId": period, "contestantId": syn.HOME, "x": "50", "y": "50",
             "pressure": {"player": [{"playerId": "p", "positionX": "1", "positionY": "2"}]}}
        )
    m = _match(events_feed=feed)
    assert set(m.events[Column.PERIOD_ID].astype(int)) <= {1, 2}
    assert all(int(p["periodId"]) in (1, 2) for p in m.pressures)


def test_event_type_names_complete_for_common_feed_ids():
    names = ev_reader.EVENT_TYPE_NAMES
    assert names[1] == "pass" and names[28] == "end_delay" and names[43] == "deleted_event" and names[61] == "ball_touch"
    assert all(i in names for i in (30, 32, 34, 37, 70, 81))  # previously fell back to type_<id>
    feed = {"liveData": {"event": [{"id": 1, "typeId": 28, "periodId": 1, "x": "1", "y": "1"}]}}
    assert ev_reader.parse_remote_events(feed).iloc[0]["event_type_desc"] == "end_delay"
