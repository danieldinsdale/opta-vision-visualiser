"""Optional Stats Perform SDAPI client (outlet-key authentication).

Everything here is opt-in: the visualiser works fully from local files. To use
the API, put ``API_OUTLET_KEY`` in ``.streamlit/secrets.toml``. If the API answers
HTTP 403, also set ``API_REFERER`` there - it is sent as the ``Referer`` header.
Credentials are read from that file only (not from environment variables). The key is
never written to disk, logged, or included in raised error messages.

Security notes
--------------
* HTTPS only; redirects are refused (the key is part of the request path, so a
  redirect could leak it to a third party).
* Feed names and game ids are validated against strict allow-lists/patterns.
* Download URLs returned by the API are validated (https, public host) and the
  response size is capped before they are fetched.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import shutil
import socket
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import requests

from opta_vision_visualiser.limits import HTTP_TIMEOUT_S, MAX_INPUT_BYTES

DEFAULT_BASE_URL = "https://api.performfeeds.com"
ALLOWED_FEEDS = frozenset(
    {
        "remotematchtrackingepts",
        "remoteevents",
        "matchstats",
        "remotephasesofplay",
        "remoteplayerruns",
    }
)
logger = logging.getLogger(__name__)
_GAME_ID_RE = re.compile(r"^[A-Za-z0-9]{10,40}$")


class SdapiError(RuntimeError):
    """Raised for any SDAPI failure. Messages never contain the outlet key."""


def get_outlet_key(secrets: object | None = None) -> str:
    """Return the outlet key from ``.streamlit/secrets.toml`` (server-side only); empty if not set."""
    if secrets is None:
        return ""
    try:
        return str(secrets.get("API_OUTLET_KEY", "")).strip()  # type: ignore[attr-defined]
    except Exception:  # secrets file missing or unreadable
        return ""


def get_referer(secrets: object | None = None) -> str:
    """Optional ``Referer`` header value from ``API_REFERER`` in ``.streamlit/secrets.toml``."""
    value = ""
    if secrets is not None:
        try:
            value = str(secrets.get("API_REFERER", "")).strip()  # type: ignore[attr-defined]
        except Exception:  # secrets file missing or unreadable
            value = ""
    if any(ch in value for ch in "\r\n\0") or len(value) > 255:
        raise SdapiError("API_REFERER contains invalid characters or is too long")
    return value


def validate_game_id(game_id: str) -> str:
    game_id = (game_id or "").strip()
    if not _GAME_ID_RE.match(game_id):
        raise SdapiError("Game id must be 10-40 alphanumeric characters")
    return game_id


def _redact_url(url: str) -> str:
    """URL safe to log/display: no query string, credentials or tokens."""
    p = urlparse(url)
    return urlunparse((p.scheme, p.hostname or "", p.path, "", "", ""))


def _normalise_download_url(url: str) -> str:
    """Return an HTTPS URL for a file link supplied by the API.

    ``http://`` and protocol-relative (``//host/path``) links are upgraded to
    HTTPS rather than fetched in clear text. Anything else is refused, with the
    (redacted) URL in the message so the cause is visible.
    """
    url = (url or "").strip()
    if url.startswith("//"):
        url = "https:" + url
    elif url.lower().startswith("http://"):
        logger.warning("API returned an http:// file link; upgrading to https: %s", _redact_url(url))
        url = "https://" + url[len("http://"):]
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise SdapiError(f"Refusing to fetch an unsupported file link: {_redact_url(url) or repr(url[:60])}")
    return url


def _assert_public_https(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise SdapiError(f"Refusing to fetch a non-HTTPS URL: {_redact_url(url)}")
    host = parsed.hostname
    try:
        infos = socket.getaddrinfo(host, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise SdapiError(f"Download host could not be resolved: {host}") from None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise SdapiError(f"Refusing to fetch from a non-public address: {host}")


class SdapiClient:
    def __init__(self, outlet_key: str, base_url: str = DEFAULT_BASE_URL, referer: str | None = None) -> None:
        if not outlet_key:
            raise SdapiError("No SDAPI outlet key configured (set API_OUTLET_KEY in .streamlit/secrets.toml)")
        if not base_url.startswith("https://"):
            raise SdapiError("SDAPI base URL must use HTTPS")
        self._key = outlet_key
        self._base = base_url.rstrip("/")
        self._session = requests.Session()
        self._headers = {"Accept": "application/json"}
        # Some accounts need a Referer header (HTTP 403 without it). Set API_REFERER in secrets.toml.
        referer = (referer or "").strip()
        if referer:
            self._headers["Referer"] = referer

    def get_feed(self, feed: str, game_id: str) -> dict:
        if feed not in ALLOWED_FEEDS:
            raise SdapiError(f"Unsupported feed {feed!r}")
        game_id = validate_game_id(game_id)
        url = f"{self._base}/soccerdata/{feed}/{self._key}/{game_id}"
        # Same URL with the outlet key masked - the only form that is ever shown or logged.
        shown = f"{self._base}/soccerdata/{feed}/<API_OUTLET_KEY>/{game_id}?_fmt=json&_rt=c"
        logger.info("GET %s", shown)
        try:
            resp = self._session.get(
                url,
                params={"_fmt": "json", "_rt": "c"},
                headers=self._headers,
                timeout=HTTP_TIMEOUT_S,
                allow_redirects=False,
            )
        except requests.RequestException as exc:
            raise SdapiError(f"{feed}: request failed ({type(exc).__name__}) for {shown}") from None
        if resp.status_code != 200:
            raise SdapiError(f"{feed}: HTTP {resp.status_code} for {shown}")
        if len(resp.content) > MAX_INPUT_BYTES:
            raise SdapiError(f"{feed}: response too large")
        try:
            return resp.json()
        except ValueError:
            raise SdapiError(f"{feed}: response was not JSON") from None

    def download(self, url: str) -> bytes:
        """Download a file URL returned by the API (size-capped, HTTPS, public host)."""
        url = _normalise_download_url(url)
        _assert_public_https(url)
        shown = _redact_url(url)
        logger.info("GET %s", shown)
        try:
            with self._session.get(
                url, headers=self._headers, timeout=HTTP_TIMEOUT_S, stream=True, allow_redirects=False
            ) as resp:
                if resp.status_code != 200:
                    raise SdapiError(f"download: HTTP {resp.status_code} for {shown}")
                chunks, size = [], 0
                for chunk in resp.iter_content(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_INPUT_BYTES:
                        raise SdapiError(f"download: file exceeds the size limit ({shown})")
                    chunks.append(chunk)
        except requests.RequestException as exc:
            raise SdapiError(f"download: request failed ({type(exc).__name__}) for {shown}") from None
        return b"".join(chunks)

    def get_epts_files(self, game_id: str) -> tuple[bytes, bytes]:
        """Return ``(raw_txt, xml)`` for the 25 Hz EPTS files of a match."""
        data = self.get_feed("remotematchtrackingepts", game_id)
        try:
            files = data["trackingFiles"]["fps25"]
            meta_url = files["metadata"]["value"]
            data_url = files["trackingData"]["value"]
        except (KeyError, TypeError):
            raise SdapiError("EPTS feed has no 25 Hz tracking files for this match") from None
        return self.download(data_url), self.download(meta_url)


# ── Fetching a whole match, with per-feed status for the UI ──────────────────

OPTIONAL_FEEDS: tuple[tuple[str, str, str], ...] = (
    # (key, display label, feed name)
    ("events", "Events", "remoteevents"),
    ("matchstats", "Lineup and kit colours", "matchstats"),
    ("phases", "Phases of play", "remotephasesofplay"),
    ("runs", "Player runs", "remoteplayerruns"),
)


class FeedCache:
    """Optional on-disk cache of downloaded feeds, one folder per game id.

    Never holds the outlet key (only feed bodies). Folders are created ``0700`` and
    files ``0600``; writes are atomic. Any I/O problem (read-only folder, full disk)
    is logged and treated as "no cache" so the app keeps working.
    """

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)

    def _dir(self, game_id: str) -> Path:
        return self.root / validate_game_id(game_id)  # validated: no path separators / traversal

    def get(self, game_id: str, name: str) -> bytes | None:
        path = self._dir(game_id) / name
        try:
            if not path.is_file() or path.stat().st_size > MAX_INPUT_BYTES:
                return None
            return path.read_bytes()
        except OSError:
            logger.warning("Could not read cache file %s", name)
            return None

    def put(self, game_id: str, name: str, data: bytes) -> bool:
        """Store ``data``; returns False (and logs) if it could not be written."""
        directory = self._dir(game_id)
        try:
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-")
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(data)
                os.chmod(tmp, 0o600)
                os.replace(tmp, directory / name)
            except BaseException:
                Path(tmp).unlink(missing_ok=True)
                raise
            return True
        except OSError as exc:
            logger.warning("Could not write cache file %s (%s)", name, type(exc).__name__)
            return False

    def has(self, game_id: str) -> bool:
        directory = self._dir(game_id)
        return directory.is_dir() and any(directory.iterdir())

    def clear(self, game_id: str) -> None:
        """Delete every cached file for one game."""
        shutil.rmtree(self._dir(game_id), ignore_errors=True)


@dataclass(frozen=True)
class FeedStatus:
    """Outcome of one feed: ``state`` is ``ok``, ``failed`` or ``skipped``."""

    label: str
    state: str
    detail: str = ""
    cached: bool = False  # True when served from the local cache rather than the API


# Cache file names for each piece of a match.
_CACHE_NAMES = {"raw": "epts_raw_data.txt", "spec": "epts_format_specification.xml"} | {
    key: f"{feed}.json" for key, _label, feed in OPTIONAL_FEEDS
}


def fetch_match(
    client: SdapiClient | None,
    game_id: str,
    want: dict[str, bool],
    cache: FeedCache | None = None,
    refresh: bool = False,
) -> tuple[dict[str, bytes] | None, list[FeedStatus]]:
    """Get EPTS plus the requested optional feeds, from the cache when possible.

    With ``cache`` set, a piece already on disk is reused (no API call) unless
    ``refresh`` is true; anything downloaded is stored. ``client`` may be ``None``
    when everything needed is cached.

    Returns ``(payload, statuses)``. ``payload`` maps ``raw``/``spec`` and each optional
    feed key to bytes, or is ``None`` if the EPTS tracking files could not be obtained
    (nothing can be shown without them). Optional feeds fail independently, and failed
    downloads are never cached.
    """
    use_cache = cache is not None and not refresh
    statuses: list[FeedStatus] = []
    payload: dict[str, bytes] = {}

    raw = cache.get(game_id, _CACHE_NAMES["raw"]) if use_cache else None
    spec = cache.get(game_id, _CACHE_NAMES["spec"]) if use_cache else None
    from_cache = raw is not None and spec is not None
    try:
        if not from_cache:
            if client is None:
                raise SdapiError("not cached and no API key configured")
            raw, spec = client.get_epts_files(game_id)
            if cache is not None:
                cache.put(game_id, _CACHE_NAMES["raw"], raw)
                cache.put(game_id, _CACHE_NAMES["spec"], spec)
        payload["raw"], payload["spec"] = raw, spec
        statuses.append(FeedStatus("EPTS tracking", "ok", cached=from_cache))
    except SdapiError as exc:
        statuses.append(FeedStatus("EPTS tracking", "failed", str(exc)))
        statuses.extend(
            FeedStatus(label, "skipped", "not fetched (tracking failed)" if want.get(key) else "not requested")
            for key, label, _ in OPTIONAL_FEEDS
        )
        return None, statuses

    for key, label, feed in OPTIONAL_FEEDS:
        if not want.get(key):
            statuses.append(FeedStatus(label, "skipped", "not requested"))
            continue
        cached_body = cache.get(game_id, _CACHE_NAMES[key]) if use_cache else None
        if cached_body is not None:
            payload[key] = cached_body
            statuses.append(FeedStatus(label, "ok", cached=True))
            continue
        try:
            if client is None:
                raise SdapiError("not cached and no API key configured")
            body = json.dumps(client.get_feed(feed, game_id)).encode()
        except SdapiError as exc:
            statuses.append(FeedStatus(label, "failed", str(exc)))
            continue
        payload[key] = body
        if cache is not None:
            cache.put(game_id, _CACHE_NAMES[key], body)
        statuses.append(FeedStatus(label, "ok"))
    return payload, statuses
