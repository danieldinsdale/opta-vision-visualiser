"""Skeleton VOD provider - copy, rename and fill in ``get_urls``.

Run the app with::

    export OPTA_VISUALISER_VOD_PROVIDER="vod_provider_example:ExampleVodProvider"
    PYTHONPATH=examples streamlit run app.py

The URL below is a placeholder: replace the body of ``get_urls`` with a call to
your own video service. Keep API keys in environment variables, never in code.
"""

from __future__ import annotations

import os

from opta_vision_visualiser.vod import VodContext, VodProvider, validate_stream_url


class ExampleVodProvider(VodProvider):
    name = "Example provider"

    def get_urls(self, context: VodContext) -> dict[int, str]:
        base = os.environ.get("MY_VOD_BASE_URL", "")  # e.g. https://video.example.com
        if not base:
            return {}
        # One clip per period, starting at the beginning of that period.
        return {
            period: validate_stream_url(f"{base}/{context.game_id}/period-{period}.m3u8")
            for period in context.periods
        }
