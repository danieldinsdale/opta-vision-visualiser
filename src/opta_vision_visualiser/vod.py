"""VOD (video) plugin interface - placeholder implementation.

Licensed VOD streams are not available to public users, so this module only
defines the extension point. The pitch component already knows how to play a
per-period video URL (MP4 or HLS ``.m3u8``) in sync with the tracking frame,
including a manual frame-offset control; a provider simply has to return those
URLs.

Writing your own provider
-------------------------
1. Subclass :class:`VodProvider` (see ``examples/vod_provider_example.py``).
2. Point the app at it::

       export OPTA_VISUALISER_VOD_PROVIDER="my_package.my_module:MyProvider"

   (the module must be importable, e.g. ``pip install -e`` or on ``PYTHONPATH``).

Security: the provider is imported and executed with the app's privileges, so
only configure modules you trust. Keep credentials server-side (environment
variables / secrets) - never put them into the URLs you return unless they are
short-lived signed URLs, because returned URLs are sent to the browser.
"""

from __future__ import annotations

import importlib
import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

PROVIDER_ENV_VAR = "OPTA_VISUALISER_VOD_PROVIDER"
_PROVIDER_RE = re.compile(r"^[A-Za-z_][\w.]*:[A-Za-z_]\w*$")
_MAX_URL_LEN = 4096


@dataclass(frozen=True)
class VodContext:
    """What a provider is told about the loaded match."""

    game_id: str
    periods: tuple[int, ...]
    # Seconds (tracking clock) at which each period starts, keyed by period id.
    period_start_times: dict[int, float]


def validate_stream_url(url: str) -> str:
    """Return ``url`` if it is a plain http(s) URL without embedded credentials.

    Blocks ``javascript:``, ``data:``, ``file:`` etc. before a URL reaches the
    browser's ``<video>`` element.
    """
    url = (url or "").strip()
    if not url or len(url) > _MAX_URL_LEN:
        raise ValueError("VOD URL is empty or too long")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("VOD URL must start with http:// or https://")
    if parsed.username or parsed.password:
        raise ValueError("VOD URL must not contain embedded credentials")
    return url


class VodProvider(ABC):
    """Base class for VOD plugins."""

    #: Human-readable name shown in the sidebar.
    name: str = "VOD provider"

    def render_controls(self, st: Any) -> None:  # noqa: B027 - optional hook
        """Optionally draw Streamlit widgets (API options etc.) in the sidebar."""

    @abstractmethod
    def get_urls(self, context: VodContext) -> dict[int, str]:
        """Return ``{period_id: stream_url}``. Raise on failure; return ``{}`` for none."""


class ManualUrlVodProvider(VodProvider):
    """Default placeholder: paste a video URL per period (e.g. your own hosted files)."""

    name = "Manual URLs (placeholder)"

    def __init__(self) -> None:
        self._urls: dict[int, str] = {}
        self._periods: tuple[int, ...] = ()

    def set_periods(self, periods: tuple[int, ...]) -> None:
        self._periods = periods

    def render_controls(self, st: Any) -> None:
        st.caption(
            "No VOD service is bundled. Paste a direct http(s) video URL (MP4 or HLS .m3u8) "
            "for each period, or install a provider plugin - see the README."
        )
        self._urls = {p: st.text_input(f"Period {p} video URL", key=f"vod_url_{p}") for p in self._periods}

    def get_urls(self, context: VodContext) -> dict[int, str]:
        return {p: validate_stream_url(u) for p, u in self._urls.items() if u.strip()}


def load_provider() -> VodProvider:
    """Instantiate the configured provider (``module:Class``), else the manual placeholder."""
    spec = os.environ.get(PROVIDER_ENV_VAR, "").strip()
    if not spec:
        return ManualUrlVodProvider()
    if not _PROVIDER_RE.match(spec):
        raise ValueError(f"{PROVIDER_ENV_VAR} must look like 'package.module:ClassName'")
    module_name, class_name = spec.split(":")
    cls = getattr(importlib.import_module(module_name), class_name)
    if not (isinstance(cls, type) and issubclass(cls, VodProvider)):
        raise TypeError(f"{spec} is not a VodProvider subclass")
    return cls()
