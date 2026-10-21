"""Helpers shared by the test modules."""


import synthetic as syn

from opta_vision_visualiser.config import load_data_type_config
from opta_vision_visualiser.loader import TrackingInput, build_match

EVENT_IDS = {(1, 5): 1001, (1, 30): 1002, (2, 10): 1003}


def _match(**kw):
    raw = syn.make_raw(event_ids=EVENT_IDS)
    return build_match(TrackingInput(raw, syn.make_xml()), **kw)


def _sources(m):
    return {"epts": load_data_type_config("config/data_type_config.yaml")["epts"]}
