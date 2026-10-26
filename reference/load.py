#!/usr/bin/env python3
"""Load event trees written by `isu_shorttrack.py pull` into the schema.sql tables.

Safe to re-run: everything upserts on ISU's ids, so re-loading a live event
moves heats through start_list -> running -> unofficial -> official.

  DATABASE_URL=postgresql://... python3 load.py data/*.json

Quirks of ISU's data handled here:
  * heat.date is local wall-clock time with a "Z" suffix; round.date and the
    schedule's start_time are real UTC (checked on the 2026 Vancouver event).
  * event.time_zone is sometimes wrong (Montréal 2025 says America/Halifax).
  * Many past events have no schedule; the Olympics' schedule has no round ids.
  * Heats are not raced in display order (Final B runs before Final A).
"""
import json
import os
import re
import sys
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import psycopg

TZ_OVERRIDES = {"isu-short-track-world-tour-14": "America/Toronto"}  # Montréal 2025

EVENT_STATE = {"Scheduled": "upcoming", "Upcoming": "upcoming",
               "Live": "live", "In Progress": "live", "Finished": "finished"}
HEAT_STATE = {("Scheduled", ""): "scheduled", ("Scheduled", "Start List"): "start_list",
              ("Live", "Live"): "running", ("Finished", "Live"): "unofficial",
              ("Finished", "Official"): "official"}


def utc(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def local(s, tz):
    """ISU timestamp that is really local wall-clock time -> aware datetime."""
    return datetime.fromisoformat(s[:19]).replace(tzinfo=ZoneInfo(tz)) if s else None


def millis(text):
    """'1:24.537' -> 84537, '+0.520' -> 520; 'no time' / 'PEN' / '' -> None."""
    m = re.fullmatch(r"[+-]?(?:(\d+):)?(\d+)\.(\d{1,3})", (text or "").strip())
    if not m:
        return None
    mins, secs, frac = m.groups()
    return (int(mins or 0) * 60 + int(secs)) * 1000 + int(frac.ljust(3, "0"))


def norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower().replace("'s", ""))


class Loader:
    def __init__(self, conn):
        self.cur = conn.cursor()

    def upsert(self, table, isu_id, **cols):
        keys = ["isu_id", *cols]
        sql = (f"insert into {table} ({', '.join(keys)}) values ({', '.join(['%s'] * len(keys))}) "
               f"on conflict (isu_id) do update set {', '.join(f'{k} = excluded.{k}' for k in cols)} "
               f"returning id")
        return self.cur.execute(sql, [isu_id, *cols.values()]).fetchone()[0]

    def nation(self, code, name=None):
        if not code:
            return None
        self.cur.execute(
            "insert into nation (code, name) values (%s, %s) on conflict (code) do update "
            "set name = excluded.name where nation.name = nation.code and excluded.name <> excluded.code",
            (code, name or code))
        return code

    def skater(self, s):
        return self.upsert(
            "skater", s["id"], api_id=s.get("api_id") or None, slug=s.get("slug"),
            first_name=s.get("first_name"), last_name=s.get("last_name") or s.get("full_name"),
            gender=s.get("gender"), nation=self.nation(s.get("nationality_code")),
            photo_path=s.get("thumbnail_image") or None)

    def team(self, t):
        return self.upsert(
            "relay_team", t["id"], api_id=t.get("api_id") or None, slug=t.get("slug"),
            name=t["name"], nation=self.nation(t.get("nf_organization_code")), gender=t.get("gender"))

    def load_tree(self, tree):
        ev = tree["event"]
        tz = TZ_OVERRIDES.get(ev["slug"], ev["time_zone"])
        first_year = int(ev["season"][:4])
        season_id = self.upsert("season", int(ev["season_id"]), title=ev["season"],
                                starts_on=date(first_year, 7, 1), ends_on=date(first_year + 1, 6, 30))
        event_id = self.upsert(
            "event", int(ev.get("event_id") or ev["id"]), api_id=ev.get("api_id") or None,
            slug=ev["slug"], season_id=season_id, name=ev["name"], series=ev.get("event_sub_type_name"),
            city=ev.get("city"), country_code=self.nation(ev.get("country_code"), ev.get("country_name")),
            time_zone=tz, starts_on=ev["from_date"][:10], ends_on=ev["to_date"][:10],
            state=EVENT_STATE[ev["state"]])

        round_ids = {}            # ISU round id -> our id
        round_keys = {}           # (competition name, round name) -> our id, for unlinked schedules
        derived = []
        for comp in tree["competitions"]:
            name = comp["name"]
            dist = comp.get("discipline_distance") or ""
            comp_id = self.upsert(
                "competition", comp["event_result_id"], api_id=comp.get("api_id") or None,
                event_id=event_id, name=name, gender=comp["gender"],
                distance_m=int(dist) if dist.isdigit() else None,
                is_relay=comp.get("discipline_type") in ("Couples", "Team") or "relay" in name.lower(),
                display_order=comp.get("display_order"), state=EVENT_STATE[comp["status"]])
            for rnd in comp["rounds"]:
                rid = self.upsert(
                    "round", rnd["event_result_round_id"], competition_id=comp_id, name=rnd["name"],
                    display_order=rnd["display_order"], qualification_rule=rnd.get("qualification_rule") or None,
                    starts_at=utc(rnd.get("date")), state=EVENT_STATE[rnd["status"]])
                round_ids[rnd["event_result_round_id"]] = rid
                round_keys[(norm(name), norm(rnd["name"]))] = rid
                if rnd.get("date"):
                    derived.append((utc(rnd["date"]), name, rnd["name"], rid))
                self.load_heats(rid, rnd["heats"], tz)

        self.cur.execute("delete from schedule_item where event_id = %s", (event_id,))
        sched = tree.get("schedule") or []
        if sched:
            for item in sched:
                rid = round_ids.get(item.get("event_result_round_id")) or \
                    round_keys.get((norm(item["event_schedule_title"]), norm(item["round_information"])))
                self.cur.execute(
                    "insert into schedule_item (event_id, round_id, starts_at, title, round_label, source) "
                    "values (%s, %s, %s, %s, %s, 'isu')",
                    (event_id, rid, utc(item["start_time"]), item["event_schedule_title"], item["round_information"]))
        else:
            for starts_at, title, label, rid in derived:
                self.cur.execute(
                    "insert into schedule_item (event_id, round_id, starts_at, title, round_label, source) "
                    "values (%s, %s, %s, %s, %s, 'derived')", (event_id, rid, starts_at, title, label))

    def load_heats(self, round_id, heats, tz):
        # heat.date is the planned time until the heat starts, then the actual
        # start. Raced heats go first by actual time, then the rest by plan.
        def race_key(h):
            return (h["status"] == "Scheduled", h.get("date") or "", h["display_order"])
        run_order = {h["event_result_round_heats_id"]: i
                     for i, h in enumerate(sorted(heats, key=race_key), start=1)}
        for h in heats:
            heat_id = self.upsert(
                "heat", h["event_result_round_heats_id"], api_id=h.get("api_id") or None,
                round_id=round_id, name=h["name"], display_order=h["display_order"],
                run_order=run_order[h["event_result_round_heats_id"]], starts_at=local(h.get("date"), tz),
                state=HEAT_STATE[(h["status"], h["result_status"] or "")],
                source_updated_at=utc(h.get("updated_at")))
            seen = []
            for c in h.get("event_result_round_heats_competitors") or []:
                seen.append(c["event_result_round_heats_competitors_id"])
                self.load_entry(heat_id, c)
            # Drop entries ISU no longer lists (e.g. a start list that changed).
            self.cur.execute("delete from entry where heat_id = %s and isu_id <> all(%s)", (heat_id, seen))

    def load_entry(self, heat_id, c):
        skater_id = self.skater(c["skaters"]) if c.get("skaters") else None
        team_id = self.team(c["skaters_team"]) if c.get("skaters_team") else None
        entry_id = self.upsert(
            "entry", c["event_result_round_heats_competitors_id"], heat_id=heat_id,
            skater_id=skater_id, team_id=team_id,
            nation=self.nation(c.get("started_for_nf_code"), c.get("started_for_nf_country_name")),
            bib=c.get("bib_number"), start_position=c.get("starting_position"), rank=c.get("final_rank"),
            time_ms=millis(c.get("final_result")), time_text=c.get("final_result") or None,
            status=c.get("result_status") or None, qualification=c.get("qualification_code") or None,
            record=c.get("record_flag") or None)

        self.cur.execute("delete from lap where entry_id = %s", (entry_id,))
        self.cur.executemany(
            "insert into lap (entry_id, lap_no, lap_ms, elapsed_ms, position, gap_ms) values (%s, %s, %s, %s, %s, %s)",
            [(entry_id, int(l["LapNumber"]), millis(l.get("LapTime")), millis(l.get("Time")),
              l.get("Rank"), millis(l.get("ResultDiff"))) for l in c.get("lap") or []])

        self.cur.execute("delete from relay_member where entry_id = %s", (entry_id,))
        for m in c.get("event_result_round_heats_competitors_team_members") or []:
            if m.get("skaters"):
                self.cur.execute("insert into relay_member (entry_id, skater_id) values (%s, %s) on conflict do nothing",
                                 (entry_id, self.skater(m["skaters"])))


def main(paths):
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        loader = Loader(conn)
        for path in paths:
            with open(path) as f:
                loader.load_tree(json.load(f))
            conn.commit()
            print(f"loaded {path}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
