#!/usr/bin/env python3
"""Client for the short track results behind isu-skating.com.

The ISU fan site (Next.js) reads from an undocumented Express backend at
front-api.isu.org. Endpoints and payloads below were read out of the site's
JS bundles on 2026-10-23; they can change without notice.

ISU's terms of use prohibit "systematic or automated data collection
activities (including ... scraping, data mining, data extraction and data
harvesting)" without ISU's prior written consent. Get that before running
full-season pulls or building a product on this.

Hierarchy:  season -> event (slug) -> competition (event_result_id, e.g. "Men 500 m")
            -> round (event_result_round_id, e.g. "Quarterfinals") -> heat -> competitors -> laps

Usage:
  python3 isu_shorttrack.py seasons
  python3 isu_shorttrack.py events --season 2025/2026
  python3 isu_shorttrack.py pull --season 2025/2026 --event isu-short-track-world-tour-14 --competition 228
"""
import argparse
import csv
import hashlib
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://front-api.isu.org"
SHORT_TRACK = 3  # discipline_id: 1 figure, 2 synchro, 3 short track, 4 speed skating
HEADERS = {
    "Accept": "application/json",
    "language_code": "en",
    "site_type": "fan",
    "User-Agent": "Mozilla/5.0 (research prototype)",
}


class Client:
    def __init__(self, delay=1.0, cache_dir=Path(".cache/isu")):
        self.delay = delay
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._last = 0.0

    def _request(self, method, path, json_body=None, form=None, use_cache=True):
        body, headers = None, dict(HEADERS)
        if json_body is not None:
            body = json.dumps(json_body).encode()
            headers["Content-Type"] = "application/json"
        elif form is not None:
            body = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"

        key = hashlib.sha1(f"{method} {path} {body!r}".encode()).hexdigest()
        cached = self.cache_dir / f"{key}.json"
        if use_cache and cached.exists():
            return json.loads(cached.read_text())

        wait = self.delay - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read())
        self._last = time.monotonic()
        if payload.get("status") != 200:
            raise RuntimeError(f"{method} {path} -> {payload.get('status')} {payload.get('message')}")
        if use_cache:
            cached.write_text(json.dumps(payload))
        return payload

    def seasons(self):
        return self._request("GET", "/common/get-season")["data"]

    def events(self, season, discipline_id=SHORT_TRACK, event_level="ISU"):
        """season is the title string, e.g. "2025/2026" (season_id does not filter)."""
        out, page = [], 1
        while True:
            resp = self._request("POST", "/events/list", json_body={
                "discipline_id": discipline_id, "season": season,
                "event_level": event_level, "page": page, "pagesize": 50,
            })
            out += resp.get("data") or []
            if resp.get("is_next_page") != "Y":
                return out
            page += 1

    def schedule(self, event_slug, use_cache=True):
        """Running order, one item per round. Empty for many past events; the
        Olympics' items have no round ids."""
        data = self._request("GET", f"/events/getschedule/{event_slug}", use_cache=use_cache)["data"]
        return (data or {}).get("value") or []

    def competitions(self, event_slug, use_cache=True):
        return self._request("POST", "/events/get-event-result", json_body={
            "slug": event_slug, "gender": "", "discipline_distance": "",
        }, use_cache=use_cache)["data"] or []

    def rounds(self, event_result_id, use_cache=True):
        return self._request("POST", "/events/get-event-result-round", json_body={
            "event_result_id": str(event_result_id),
        }, use_cache=use_cache)["data"] or []

    def heats(self, event_result_id, round_id, team=False, use_cache=True):
        kind = "team" if team else "single"
        return self._request("POST", f"/events/get-event-result-round-heats-stk-{kind}", form={
            "event_result_id": event_result_id, "event_result_round_id": round_id, "country_code": "",
        }, use_cache=use_cache)["data"] or []


def is_relay(competition):
    return (competition.get("discipline_type") or "").lower() in ("couples", "team") \
        or "relay" in (competition.get("name") or "").lower()


def lap_rows(season, event, comp, rnd, heat):
    """Flatten one heat into one row per competitor per lap."""
    for c in heat.get("event_result_round_heats_competitors") or []:
        athlete = c.get("skaters") or c.get("skaters_team") or {}
        base = {
            "season": season,
            "event_slug": event["slug"],
            "event_name": event["name"],
            "competition_id": comp["event_result_id"],
            "competition": comp["name"],
            "round": rnd["name"],
            "heat": heat["name"],
            "heat_status": heat.get("result_status"),
            "athlete": athlete.get("full_name") or athlete.get("name"),
            "athlete_slug": athlete.get("slug"),
            "nation": c.get("started_for_nf_code"),
            "start_pos": c.get("starting_position"),
            "final_rank": c.get("final_rank"),
            "final_time": c.get("final_result"),
            "result_status": c.get("result_status"),  # e.g. PEN / DNF / DNS / YC
            "qualification": c.get("qualification_code"),
            "record": c.get("record_flag"),
        }
        laps = c.get("lap") or [{}]
        for lap in laps:
            yield {**base,
                   "lap": lap.get("LapNumber"),
                   "lap_time": lap.get("LapTime"),
                   "elapsed": lap.get("Time"),
                   "lap_rank": lap.get("Rank"),
                   "gap_to_leader": lap.get("ResultDiff")}


def pull(client, season, event_slug=None, competition_id=None, out_dir=Path("data"), fresh=False):
    events = client.events(season)
    if event_slug:
        events = [e for e in events if e["slug"] == event_slug]
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for event in events:
        cache = not fresh
        tree = {"event": event, "schedule": client.schedule(event["slug"], use_cache=cache), "competitions": []}
        for comp in client.competitions(event["slug"], use_cache=cache):
            if competition_id and str(comp["event_result_id"]) not in str(competition_id).split(","):
                continue
            node = {**comp, "rounds": []}
            for rnd in client.rounds(comp["event_result_id"], use_cache=cache):
                heats = client.heats(comp["event_result_id"], rnd["event_result_round_id"],
                                     team=is_relay(comp), use_cache=cache)
                node["rounds"].append({**rnd, "heats": heats})
                for heat in heats:
                    rows += lap_rows(season, event, comp, rnd, heat)
                print(f"  {event['name']} | {comp['name']} | {rnd['name']}: {len(heats)} heats", file=sys.stderr)
            tree["competitions"].append(node)
        (out_dir / f"{event['slug']}.json").write_text(json.dumps(tree, indent=1))

    if rows:
        csv_path = out_dir / "laps.csv"
        with csv_path.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"wrote {len(rows)} lap rows -> {csv_path}", file=sys.stderr)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--delay", type=float, default=1.0, help="seconds between requests (default 1)")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("seasons")
    e = sub.add_parser("events")
    e.add_argument("--season", required=True)
    pl = sub.add_parser("pull")
    pl.add_argument("--season", required=True)
    pl.add_argument("--event", help="event slug; omit for every event in the season")
    pl.add_argument("--competition", help="event_result_id(s), comma-separated; omit for every competition")
    pl.add_argument("--out", type=Path, default=Path("data"))
    pl.add_argument("--fresh", action="store_true", help="ignore cached responses (use for live events)")
    args = p.parse_args()

    client = Client(delay=args.delay)
    if args.cmd == "seasons":
        for s in client.seasons():
            print(f"{s['title']}  id={s['season_id']}{'  (current)' if s['is_current'] else ''}")
    elif args.cmd == "events":
        for ev in client.events(args.season):
            print(f"{ev['from_date'][:10]}  {ev['state']:<9} {ev['slug']:<60} {ev['name']}")
    elif args.cmd == "pull":
        pull(client, args.season, args.event, args.competition, args.out, args.fresh)


if __name__ == "__main__":
    main()
