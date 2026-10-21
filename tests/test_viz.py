"""Animation component: payload, template safety, config, ball graphic."""

import json
import re
import shutil
import subprocess

import pytest
import synthetic as syn
from common import _match, _sources
from pydantic import ValidationError

from opta_vision_visualiser import viz
from opta_vision_visualiser.config import DataTypeConfig


def test_payload_shape_and_html_safety():
    m = _match(events_feed=syn.make_events_feed([(1001, 1), (1002, 1), (1003, 2)]), matchstats=syn.make_matchstats())
    payload = viz.build_payload(m.df, _sources(m), events=m.events, lineup=m.lineup, team_colors=m.team_colors)
    assert len(payload["frameIds"]) == 200
    assert {e["g"] for e in payload["entities"]} == {1, 2, 4}
    assert any(e.get("gk") for e in payload["entities"])
    assert payload["events"] and all(0 <= e["fi"] < 200 for e in payload["events"])
    blob = json.dumps(payload)
    assert "<img" not in blob  # markup in a player name is neutralised
    html_json = viz._script_safe_json(payload)
    assert "<" not in html_json and ">" not in html_json
    assert json.loads(html_json)["frameIds"] == payload["frameIds"]


def test_payload_requires_data():
    m = _match()
    with pytest.raises(ValueError):
        viz.build_payload(m.df, {})


def test_template_has_no_internal_or_external_font_references():
    html = viz._template()
    assert "fonts.googleapis.com" not in html
    for word in ("skillcorner", "invenue", "livecv", "imputation", "mle_pipelines", "statsperform"):
        assert word not in html.lower()


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_template_javascript_parses(tmp_path):
    html = viz._template().replace('"__PAYLOAD__"', "{}")
    scripts = re.findall(r"<script>(.*?)</script>", html, flags=re.S)
    assert scripts
    f = tmp_path / "t.js"
    f.write_text("\n".join(scripts))
    subprocess.run(["node", "--check", str(f)], check=True)


def test_pydantic_config_bounds():
    with pytest.raises(ValidationError):
        DataTypeConfig(label_name="x", facecolor_fill=True, linestyle="-", alpha=2.0)


def test_ball_graphic_is_plain_svg():
    url = viz._ball_image_data_url()
    assert url.startswith("data:image/svg+xml;base64,")
    import base64

    svg = base64.b64decode(url.split(",", 1)[1]).decode()
    assert 'width="450"' in svg and "viewBox" in svg
    for forbidden in ("<script", "onload", "onclick", "<foreignObject", "<image", "href=\"http"):
        assert forbidden.lower() not in svg.lower()
