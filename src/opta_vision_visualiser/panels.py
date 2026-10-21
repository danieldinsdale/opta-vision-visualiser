"""Phases-of-play, player-run and pressure payload builders.

These convert the raw feed structures (see ``readers.feeds``) into the compact,
period-relative form the pitch component consumes. Logic is unchanged from the
original animator; only the entry point differs.
"""

from __future__ import annotations


def build_context_panels(
    lineup: dict[str, str] | None,
    phases: list[dict] | None,
    runs: list[dict] | None,
    pressures: list[dict] | None,
) -> tuple[dict[str, list], dict[str, list], list[dict]]:
    """Return ``(phases_by_period, runs_by_period, pressures_payload)``."""
    # ── Phases of play (period-keyed, period-relative seconds) ───────────────────
    _player_map = lineup or {}
    # Group raw phases by period, sorted by startTime
    phases_by_period: dict[str, list] = {}
    for ph in sorted(phases or [], key=lambda p: int(p.get("startTime", 0))):
        pid = int(ph.get("periodId", 0))
        if not ph.get("phaseLabel", {}).get("value", "") or not pid:
            continue
        phases_by_period.setdefault(str(pid), []).append(ph)

    # Convert each period's phases to period-relative seconds and enrich with sub-segments
    for key in list(phases_by_period.keys()):
        raw_list = phases_by_period[key]
        off = int(raw_list[0]["startTime"])  # first startTime = period offset (cumulative ms)
        enriched = []
        for ph in raw_list:
            stats = {s["type"]: s["value"] for s in ph.get("phaseSummary", {}).get("stat", [])}
            dc = [
                {"s":   round((int(seg["startTime"]) - off) / 1000.0, 3),
                 "e":   round((int(seg["endTime"])   - off) / 1000.0, 3),
                 "v":   seg.get("label", ""),
                 "adc": seg.get("averageDefensiveAreaCoverage", "")}
                for seg in ph.get("defensiveCompactnessSummary", {}).get("defensiveCompactness", [])
            ]
            fp = [
                {"s": round((int(seg["startTime"]) - off) / 1000.0, 3),
                 "e": round((int(seg["endTime"]) - off) / 1000.0, 3)}
                for seg in ph.get("fastPassingTempoSummary", {}).get("fastPassingTempo", [])
            ]
            dp = [
                {"s": round((int(seg["startTime"]) - off) / 1000.0, 3),
                 "e": round((int(seg["endTime"]) - off) / 1000.0, 3)}
                for seg in ph.get("directPassingSummary", {}).get("directPassing", [])
            ]
            ol = [
                {"s": round((int(seg["startTime"]) - off) / 1000.0, 3),
                 "e": round((int(seg["endTime"])   - off) / 1000.0, 3),
                 "t":   seg.get("overloadType", ""),
                 "att": seg.get("attackerCount", ""),
                 "def": seg.get("defenderCount", "")}
                for seg in ph.get("overloadSummary", {}).get("overload", [])
            ]
            poss_cid  = ph.get("possessionContestantId", "")
            poss_g    = int(_player_map.get(f"ctg_{poss_cid}", "0"))
            def_g     = (3 - poss_g) if poss_g in (1, 2) else 0
            init_uuid = ph.get("initiatorPlayerId", "")
            init_gj   = _player_map.get(f"gj_{init_uuid}", "")
            try:
                init_j = int(init_gj.split(":")[1]) if init_gj else None
            except (IndexError, ValueError):
                init_j = None
            enriched.append({
                "phId":  ph.get("id", ""),
                "s":      round((int(ph["startTime"]) - off) / 1000.0, 3),
                "e":      round((int(ph["endTime"])   - off) / 1000.0, 3),
                "l":      ph.get("phaseLabel", {}).get("value", ""),
                "init":   _player_map.get(init_uuid, ""),
                "initJ":  init_j,
                "first":  _player_map.get(ph.get("firstTouchPlayerId", ""), ""),
                "passes": stats.get("numberPasses", ""),
                "goal":   stats.get("includesGoal",  ""),
                "shots":  stats.get("includesShots", ""),
                "possG": poss_g,
                "defG":  def_g,
                "dc": dc,
                "fp": fp,
                "dp": dp,
                "ol": ol,
            })
        phases_by_period[key] = enriched

    # ── Runs (period-keyed, period-relative seconds) ──────────────────────────
    # P1 offset = 0 (matched_time resets to 0 at kickoff).
    # P2 offset = minimum P2 run startTime (matched_time also resets at P2 kickoff).
    runs_by_period: dict[str, list] = {}
    if runs:
        run_offsets = {"1": 0, "2": 2700000}
        for r in sorted(runs, key=lambda x: int(x.get("startTime", 0))):
            pid = int(r.get("periodId", 0))
            if not pid:
                continue
            key = str(pid)
            off = run_offsets.get(key, 0)
            master_label = next(
                (lbl["value"] for lbl in r.get("labels", {}).get("label", [])
                 if lbl.get("type") == "master"),
                "",
            )
            player_id = r.get("playerId", "")
            gj = _player_map.get(f"gj_{player_id}", "")
            try:
                run_g, run_j = (int(x) for x in gj.split(":")) if gj else (0, 0)
            except ValueError:
                run_g, run_j = 0, 0
            quals = {q["type"]: q.get("value", "") for q in r.get("qualifiers", {}).get("qualifier", []) if "type" in q}
            def _qint(v: str) -> int:
                try: return int(float(v))
                except (ValueError, TypeError): return -1
            runs_by_period.setdefault(key, []).append({
                "runId":  r.get("id", ""),
                "s":      round((int(r["startTime"]) - off) / 1000.0, 3),
                "e":      round((int(r["endTime"])   - off) / 1000.0, 3),
                "player": _player_map.get(player_id, ""),
                "label":  master_label,
                "type":   r.get("type", ""),
                "g":      run_g,
                "j":      run_j,
                "dlb":    _qint(quals.get("defensiveLineBroken", "")),
                "mlb":    _qint(quals.get("midfieldLineBroken",  "")),
            })

    # ── Pressure events (Opta 0-100 coords → pitch meters, period-relative seconds) ─
    # Arrow color = pressor's team color; receiver highlighted with white ring.
    def _opta_to_pitch(x_opta: float, y_opta: float) -> tuple[float, float]:
        return (round(x_opta / 100.0 * 105.0 - 52.5, 2),
                round(y_opta / 100.0 * 68.0  - 34.0, 2))

    pressures_payload: list[dict] = []
    for ev in (pressures or []):
        pid = int(ev.get("periodId", 0))
        if not pid:
            continue
        t_rel = round((int(ev.get("timeMin", 0)) - (pid - 1) * 45) * 60.0
                      + int(ev.get("timeSec", 0)), 1)
        rx, ry = _opta_to_pitch(float(ev.get("x", 0)), float(ev.get("y", 0)))
        recv_uuid = ev.get("playerId", "")
        recv_gj   = _player_map.get(f"gj_{recv_uuid}", "")
        try:
            recv_g, recv_j = (int(v) for v in recv_gj.split(":")) if recv_gj else (0, 0)
        except (ValueError, IndexError):
            recv_g, recv_j = 0, 0
        prs_list = []
        for prs in ev.get("pressure", {}).get("player", []):
            px, py = _opta_to_pitch(float(prs.get("positionX", 0)),
                                    float(prs.get("positionY", 0)))
            prs_uuid = prs.get("playerId", "")
            prs_gj   = _player_map.get(f"gj_{prs_uuid}", "")
            try:
                prs_g, prs_j = (int(v) for v in prs_gj.split(":")) if prs_gj else (0, 0)
            except (ValueError, IndexError):
                prs_g, prs_j = 0, 0
            prs_list.append({"x": px, "y": py, "g": prs_g, "j": prs_j})
        pr_value = ev.get("pressure", {}).get("pressureReceived", {}).get("value", "")
        if prs_list:
            pressures_payload.append({
                "p":  pid,
                "t":  t_rel,
                "rx": rx, "ry": ry,   # static fallback positions
                "rg": recv_g, "rj": recv_j,
                "pr": pr_value,
                "prs": prs_list,
            })

    return phases_by_period, runs_by_period, pressures_payload
