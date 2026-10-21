"""Sidebar labels that show a feed's fetch outcome on its own tick-box row.

Streamlit renders markdown in widget labels, so a loaded feed reads
``:green[**Events** · cached]`` and a failed one ``:red[**Events** · HTTP 403]``:
the whole row is coloured by outcome with a short tag on the same row.
The full (key-masked) error is in the row's help tooltip.
"""

from __future__ import annotations

import re

from opta_vision_visualiser.sdapi import FeedStatus

_HTTP_RE = re.compile(r"HTTP (\d{3})")


def _short_reason(detail: str) -> str:
    match = _HTTP_RE.search(detail)
    return f"HTTP {match.group(1)}" if match else "error"


def feed_label(base: str, status: FeedStatus | None, ticked: bool) -> str:
    """Label for a feed's checkbox given its last fetch status (``None`` = not fetched yet)."""
    if status is None:
        return base
    if status.state == "ok":
        return f":green[**{base}** · {'cached' if status.cached else 'loaded'}]"
    if status.state == "failed":
        return f":red[**{base}** · {_short_reason(status.detail)}]"
    # skipped: it was not requested last time; if it is ticked now it still needs a fetch
    return f":orange[{base}] :gray[click Fetch to load]" if ticked else base


def feed_help(status: FeedStatus | None, optional: bool = True) -> str | None:
    """Tooltip: the full masked error for failures, otherwise a short optional/required hint."""
    if status is not None and status.state == "failed" and status.detail:
        return "`" + status.detail.replace("`", "'") + "`"
    return "Optional - untick to skip this feed." if optional else "Always fetched - needed to show anything."
