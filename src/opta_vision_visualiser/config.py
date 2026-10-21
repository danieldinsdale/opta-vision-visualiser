"""Per-source rendering configuration (fill, line style, opacity, label ...)."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import pydantic
import yaml


class DataTypeConfig(pydantic.BaseModel):
    """Rendering style for one tracking source."""

    label_name: str
    facecolor_fill: bool
    linestyle: str | Literal["solid", "dashed", "dotted"]
    alpha: float = pydantic.Field(ge=0.0, le=1.0)
    fontsize: int = 10
    player_number_prefix: str = ""
    player_number_suffix: str = ""
    color_override: str | None = None


def load_data_type_config(path: str | Path) -> dict[str, DataTypeConfig]:
    """Load ``data_type_config.yaml`` (safe YAML only)."""
    with open(path, encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}
    return {key: DataTypeConfig(**value) for key, value in raw.items()}
