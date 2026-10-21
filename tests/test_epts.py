"""EPTS reading: bundles, XML safety, parsing."""

import io
import tarfile

import pytest
import synthetic as syn
from common import _match

from opta_vision_visualiser.columns import Column
from opta_vision_visualiser.readers import epts


def test_parse_and_merge_structure():
    m = _match()
    df = m.df
    assert set(df[Column.TRACKING_GROUP_ID].unique()) == {1, 2, 4}
    assert df[df[Column.IS_BALL]].shape[0] == 200  # 2 periods x 100 frames
    assert df[Column.IS_GOALKEEPER].any()
    # continuous frame count runs across periods without overlap
    ball = df[df[Column.IS_BALL]].sort_values(Column.CONTINUOUS_FRAME_COUNT)
    assert ball[Column.CONTINUOUS_FRAME_COUNT].is_unique
    assert ball[Column.CONTINUOUS_FRAME_COUNT].iloc[100] == 100  # P2 starts right after P1's 100 frames


def test_bundle_and_separate_files_agree():
    raw, xml = syn.make_raw(), syn.make_xml()
    r2, x2 = epts.read_epts_bundle(syn.make_bundle(raw, xml))
    assert r2 == raw and x2 == xml


def test_bundle_never_touches_disk_and_rejects_missing_members(tmp_path):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        info = tarfile.TarInfo("../../evil.txt")
        info.size = 1
        tf.addfile(info, io.BytesIO(b"x"))
    with pytest.raises(epts.EptsFormatError):
        epts.read_epts_bundle(buf.getvalue())
    assert not (tmp_path.parent / "evil.txt").exists()


def test_xml_entity_bomb_rejected():
    bomb = b'<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><r>&b;</r>'
    with pytest.raises(epts.EptsFormatError):
        epts.parse_epts_metadata(bomb)


def test_malformed_raw_rejected():
    meta = epts.parse_epts_metadata(syn.make_xml())
    with pytest.raises(epts.EptsFormatError):
        epts.parse_epts_frames("garbage\nmore garbage\n", meta)
