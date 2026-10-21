"""VOD placeholder plugin."""

import pytest

from opta_vision_visualiser import vod


@pytest.mark.parametrize("bad", ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://x/y", "", "https://u:p@host/x", "//host/x"])
def test_vod_url_validation_rejects(bad):
    with pytest.raises(ValueError):
        vod.validate_stream_url(bad)


def test_vod_url_validation_accepts():
    assert vod.validate_stream_url("https://video.example.com/a.m3u8") == "https://video.example.com/a.m3u8"


def test_vod_provider_loading(monkeypatch):
    monkeypatch.delenv(vod.PROVIDER_ENV_VAR, raising=False)
    assert isinstance(vod.load_provider(), vod.ManualUrlVodProvider)
    monkeypatch.setenv(vod.PROVIDER_ENV_VAR, "os:system")
    with pytest.raises(TypeError):
        vod.load_provider()
    monkeypatch.setenv(vod.PROVIDER_ENV_VAR, "bad spec; rm -rf /")
    with pytest.raises(ValueError):
        vod.load_provider()
