"""SDAPI client safety, fetch status, feed labels and the local cache."""

import pytest

from opta_vision_visualiser.sdapi import SdapiClient, SdapiError, validate_game_id


def test_sdapi_validation():
    with pytest.raises(SdapiError):
        SdapiClient("")
    with pytest.raises(SdapiError):
        SdapiClient("key", base_url="http://insecure.example")
    for bad in ("../etc/passwd", "abc", "a" * 50, "id with space1"):
        with pytest.raises(SdapiError):
            validate_game_id(bad)
    client = SdapiClient("secretkey")
    with pytest.raises(SdapiError) as exc:
        client.get_feed("notallowed", "abcdefghij1234")
    assert "secretkey" not in str(exc.value)
    for url in ("https://127.0.0.1/x", "https://localhost/x", "ftp://example.com/x", "file:///etc/passwd", "relative/path"):
        with pytest.raises(SdapiError):
            client.download(url)


def test_http_errors_show_redacted_url(monkeypatch):
    class Resp:
        status_code = 403
        content = b""

    client = SdapiClient("secretkey")
    monkeypatch.setattr(client._session, "get", lambda *a, **k: Resp())
    with pytest.raises(SdapiError) as exc:
        client.get_feed("remotematchtrackingepts", "abcdefghij1234")
    msg = str(exc.value)
    assert "HTTP 403" in msg and "/soccerdata/remotematchtrackingepts/<API_OUTLET_KEY>/abcdefghij1234" in msg
    assert "secretkey" not in msg


def test_http_and_protocol_relative_links_are_upgraded_to_https():
    from opta_vision_visualiser.sdapi import _normalise_download_url as norm

    assert norm("http://files.example.com/a.txt?token=x") == "https://files.example.com/a.txt?token=x"
    assert norm("//files.example.com/a.txt") == "https://files.example.com/a.txt"
    with pytest.raises(SdapiError) as exc:
        norm("ftp://files.example.com/a.txt?token=secret")
    assert "token" not in str(exc.value) and "ftp" in str(exc.value)


def test_referer_header_configuration(monkeypatch):
    from opta_vision_visualiser.sdapi import get_outlet_key, get_referer

    # Environment variables are deliberately ignored: credentials come from secrets.toml only.
    monkeypatch.setenv("API_REFERER", "env.example")
    monkeypatch.setenv("API_OUTLET_KEY", "envkey")
    assert get_referer() == "" and get_outlet_key() == ""
    assert get_referer({}) == "" and get_outlet_key({}) == ""
    assert "Referer" not in SdapiClient("k")._headers
    assert SdapiClient("k", referer=" other.example ")._headers["Referer"] == "other.example"
    assert get_referer({"API_REFERER": " from.secret "}) == "from.secret"
    assert get_outlet_key({"API_OUTLET_KEY": " abc "}) == "abc"
    with pytest.raises(SdapiError):
        get_referer({"API_REFERER": "bad\r\nX-Evil: 1"})


class _FakeClient:
    def __init__(self, fail_epts=False, fail_feeds=()):
        self.fail_epts, self.fail_feeds = fail_epts, set(fail_feeds)

    def get_epts_files(self, game_id):
        if self.fail_epts:
            raise SdapiError("remotematchtrackingepts: HTTP 403 for https://x/<API_OUTLET_KEY>/id")
        return b"raw", b"xml"

    def get_feed(self, feed, game_id):
        if feed in self.fail_feeds:
            raise SdapiError(f"{feed}: HTTP 404")
        return {"feed": feed}


def test_fetch_status_all_ok_and_skipped():
    from opta_vision_visualiser.sdapi import fetch_match

    payload, st = fetch_match(_FakeClient(), "abcdefghij1234", {"events": True, "matchstats": True})
    assert payload and set(payload) == {"raw", "spec", "events", "matchstats"}
    assert {s.label: s.state for s in st} == {
        "EPTS tracking": "ok", "Events": "ok", "Lineup and kit colours": "ok",
        "Phases of play": "skipped", "Player runs": "skipped",
    }


def test_fetch_status_optional_feed_failure_does_not_block():
    from opta_vision_visualiser.sdapi import fetch_match

    payload, st = fetch_match(_FakeClient(fail_feeds={"remoteevents"}), "abcdefghij1234", {"events": True, "matchstats": True})
    states = {s.label: s for s in st}
    assert payload is not None and "events" not in payload and "matchstats" in payload
    assert states["Events"].state == "failed" and "HTTP 404" in states["Events"].detail
    assert states["Lineup and kit colours"].state == "ok"


def test_fetch_status_tracking_failure_blocks_everything():
    from opta_vision_visualiser.sdapi import fetch_match

    payload, st = fetch_match(_FakeClient(fail_epts=True), "abcdefghij1234", {"events": True})
    assert payload is None
    assert st[0].state == "failed" and "HTTP 403" in st[0].detail
    assert all(s.state == "skipped" for s in st[1:])


def test_feed_labels_show_outcome_on_the_tick_box_row():
    from opta_vision_visualiser.feed_labels import feed_help, feed_label
    from opta_vision_visualiser.sdapi import FeedStatus

    ok = FeedStatus("Events", "ok")
    bad = FeedStatus("Events", "failed", "remoteevents: HTTP 403 for https://x/<API_OUTLET_KEY>/id")
    skipped = FeedStatus("Player runs", "skipped", "not requested")
    assert feed_label("Events", None, True) == "Events"
    assert feed_label("Events", ok, True).startswith(":green[") and "loaded" in feed_label("Events", ok, True)
    assert feed_label("Events", bad, True).startswith(":red[") and "HTTP 403" in feed_label("Events", bad, True)
    assert "API_OUTLET_KEY" not in feed_label("Events", bad, True)  # full detail only in the tooltip
    assert "<API_OUTLET_KEY>" in feed_help(bad)
    assert feed_label("Player runs", skipped, False) == "Player runs"
    assert "click Fetch" in feed_label("Player runs", skipped, True)
    assert "Optional" in feed_help(None) and "Always" in feed_help(None, optional=False)


def test_all_optional_feeds_can_be_skipped():
    from opta_vision_visualiser.sdapi import fetch_match

    payload, st = fetch_match(_FakeClient(), "abcdefghij1234", {})
    assert set(payload) == {"raw", "spec"}
    assert [s.state for s in st] == ["ok", "skipped", "skipped", "skipped", "skipped"]


GAME = "abcdefghij1234"


class _CountingClient(_FakeClient):
    def __init__(self, **kw):
        super().__init__(**kw)
        self.epts_calls = self.feed_calls = 0

    def get_epts_files(self, game_id):
        self.epts_calls += 1
        return super().get_epts_files(game_id)

    def get_feed(self, feed, game_id):
        self.feed_calls += 1
        return super().get_feed(feed, game_id)


def test_cache_second_fetch_makes_no_api_calls(tmp_path):
    from opta_vision_visualiser.sdapi import FeedCache, fetch_match

    cache, client = FeedCache(tmp_path), _CountingClient()
    p1, s1 = fetch_match(client, GAME, {"events": True}, cache=cache)
    assert (client.epts_calls, client.feed_calls) == (1, 1) and not any(s.cached for s in s1)
    p2, s2 = fetch_match(client, GAME, {"events": True}, cache=cache)
    assert (client.epts_calls, client.feed_calls) == (1, 1)  # served entirely from disk
    assert p2 == p1
    assert [s.cached for s in s2 if s.state == "ok"] == [True, True]
    # works with no client at all once everything is cached
    p3, _ = fetch_match(None, GAME, {"events": True}, cache=cache)
    assert p3 == p1


def test_cache_refresh_redownloads_and_overwrites(tmp_path):
    from opta_vision_visualiser.sdapi import FeedCache, fetch_match

    cache, client = FeedCache(tmp_path), _CountingClient()
    fetch_match(client, GAME, {"events": True}, cache=cache)
    fetch_match(client, GAME, {"events": True}, cache=cache, refresh=True)
    assert (client.epts_calls, client.feed_calls) == (2, 2)


def test_cache_only_fetches_what_is_missing_and_never_stores_failures(tmp_path):
    from opta_vision_visualiser.sdapi import FeedCache, fetch_match

    cache = FeedCache(tmp_path)
    fetch_match(_CountingClient(fail_feeds={"remoteevents"}), GAME, {"events": True}, cache=cache)
    assert cache.get(GAME, "remoteevents.json") is None  # failure not cached
    client = _CountingClient()
    _, st = fetch_match(client, GAME, {"events": True, "matchstats": True}, cache=cache)
    assert (client.epts_calls, client.feed_calls) == (0, 2)  # EPTS cached; both feeds now downloaded
    assert {s.label: s.cached for s in st}["EPTS tracking"] is True


def test_cache_files_are_private_and_contain_no_key(tmp_path):
    import stat

    from opta_vision_visualiser.sdapi import FeedCache, fetch_match

    cache = FeedCache(tmp_path / "c")
    fetch_match(_CountingClient(), GAME, {"events": True}, cache=cache)
    folder = tmp_path / "c" / GAME
    assert stat.S_IMODE(folder.stat().st_mode) == 0o700
    files = [f for f in folder.iterdir()]
    assert files and all(stat.S_IMODE(f.stat().st_mode) == 0o600 for f in files)
    assert not any(f.name.startswith(".tmp-") for f in files)  # atomic write left no temp files


def test_cache_rejects_path_traversal_and_clears(tmp_path):
    from opta_vision_visualiser.sdapi import FeedCache, SdapiError, fetch_match

    cache = FeedCache(tmp_path)
    for bad in ("../x", "a/b", "..", ""):
        with pytest.raises(SdapiError):
            cache.get(bad, "x")
        with pytest.raises(SdapiError):
            cache.put(bad, "x", b"1")
    fetch_match(_CountingClient(), GAME, {}, cache=cache)
    assert cache.has(GAME)
    cache.clear(GAME)
    assert not cache.has(GAME)


def test_unwritable_cache_degrades_to_no_cache(tmp_path):
    from opta_vision_visualiser.sdapi import FeedCache, fetch_match

    blocked = tmp_path / "file"
    blocked.write_text("not a directory")
    payload, st = fetch_match(_CountingClient(), GAME, {"events": True}, cache=FeedCache(blocked / "sub"))
    assert payload is not None and all(s.state == "ok" for s in st if s.label in ("EPTS tracking", "Events"))
