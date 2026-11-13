# Testing the live features without a live race

Live results, the live card, Picks locking, race alerts and Live Activities only do something while ISU is racing. To test them between events, we replay a recorded race weekend: a **fake ISU** answers the sync worker with what the real ISU answered at the same moment, and the worker and API run on a **virtual clock** set to that moment. Everything downstream runs for real: worker → database → API → app.

What we have recorded is **World Tour #2 in Montréal, Oct 30 – Nov 1, 2026**: every change ISU made to the event list, schedule, rounds and heats from Oct 29 to Nov 2 (33,244 responses).

| Piece | File |
| --- | --- |
| Fake ISU and virtual clock | `src/isu/fake.ts` |
| Replay a weekend for the app | `src/dev/live-replay.ts` (`npm run replay:live`) |
| Copy the recording out of the database | `src/dev/export-recording.ts` (`npm run recording:export`) |
| Cut a small piece for a test | `src/dev/slice-recording.ts` (`npm run recording:slice`) |
| Automated scenario test | `tests/replay.test.ts`, using `data/recordings/wt2-montreal-2026-men-500m-finals.ndjson.gz` |

## One-time setup

1. **A local Postgres on port 54329.** It's the same one the database tests use. If `pg_isready -h 127.0.0.1 -p 54329` says it's not running, start one:
   ```bash
   initdb -D ~/pg-shorttrack -U postgres --auth=trust -E UTF8
   echo "port = 54329" >> ~/pg-shorttrack/postgresql.conf
   LC_ALL=en_US.UTF-8 pg_ctl -D ~/pg-shorttrack -l ~/pg-shorttrack.log start
   ```
   (Without `LC_ALL` it fails with "postmaster became multithreaded".) The replay creates and wipes its own database, `shorttrack_replay`. `REPLAY_DATABASE_URL` points it elsewhere, but only at a local database: it is wiped on every start.

2. **The recording file**, `server/recordings/wt2-montreal-2026.ndjson.gz` (about 18 MB, gitignored). Copy it out of the production database once:
   ```bash
   cd server && npm run recording:export
   ```
   This only reads `isu_recording`, using `DATABASE_URL` from `server/.env`. The defaults are Montréal's dates; for another weekend, pass `--from 2026-11-19 --to 2026-11-24 --out recordings/<name>.ndjson.gz`.

## Replaying a weekend for the app

```bash
cd server
npm run replay:live -- --list                   # the race days, with every round's start time
npm run replay:live -- --from day2              # day 2, from 15 min before its first race, real time
npm run replay:live -- --from day3 --speed 10   # 10x faster
npm run replay:live -- --from 2026-10-31T18:30:00Z   # any moment (UTC), e.g. just before the men's 500 m finals
```

It serves the API on **http://localhost:4310**, the same address as `npm run dev`, so stop that first. It logs what the worker does and, every 30 s, the virtual time and what's on the ice. Starting mid-weekend first loads what ISU showed at that moment, so earlier days' results are there.

**Steering the clock** while it runs:

```bash
curl localhost:4311/clock                          # the time, the speed, requests the recording couldn't answer
curl -X POST 'localhost:4311/clock?speed=30'
curl -X POST 'localhost:4311/clock?pause'
curl -X POST 'localhost:4311/clock?resume'
curl -X POST 'localhost:4311/clock?jump=+20m'      # or +30s, +2h, or an ISO time
```

The clock only moves forward, because the database already holds everything up to now. To go back, restart with an earlier `--from`.

At high speeds the worker checks less often in virtual time: a tick every ¼ s real time is 15 s at 60x, so a 40-second 500 m may show only a lap or two before it's official. To watch races lap by lap, use 1–5x, with `jump` to skip the gaps.

### Pointing the app at it

- **Simulator, Debug build:** the app uses `http://localhost:4310` unless `ios/Config/Secrets.xcconfig` points it at Render. If it does, launch with an override:
  ```bash
  xcrun simctl launch booted com.aaronheo.shorttracklive -APIBaseURL http://localhost:4310
  ```
  Or add `-APIBaseURL http://localhost:4310` under the scheme's Run → Arguments.
- **iPhone on the same Wi-Fi:** use the Mac's local name, `-APIBaseURL http://<mac-name>.local:4310`. The app allows local-network HTTP (`NSAllowsLocalNetworking`), and iOS asks once for local network access.

### What to check

- **Events:** the live card shows Montréal with what's on the ice, and "Up next" between races.
- **Schedule:** the live round is marked, and finished rounds fill in.
- **Round and heat:** the live heat's laps and positions update, the result posts, then turns official. The places card updates as heats finish.
- **Picks:** sign in again, because the replay's database starts empty. Races lock two ahead, and the first race after a break locks 3 minutes before it starts. Scores appear once results are official.
- **Favorites and alerts:** favorites live on the phone, so star a Montréal skater. Without APNs keys the phone schedules its own alerts from `/favorites/races`.
- **Server push and Live Activities:** these need `APNS_KEY`, `APNS_KEY_ID` and `APNS_TEAM_ID` in `server/.env`; the replay prints "push on" when they're set. The phone must register with the replay server, i.e. run the app pointed at it. Builds installed from Xcode use APNs' sandbox.

### What the replay doesn't do

- **Only the recorded event exists.** The other events of the season show up from the recorded event list. Vancouver (World Tour #1), already finished, is left out as "no results", because its results were never recorded.
- **Some data is empty.** There are no standings, Ask is off, and there's no earlier season.
- **Requests the worker makes before ISU was first recorded answering them** get that first recorded answer. This rarely matters, since the worker asks for each round's heats about a day ahead.
- **`/clock` lists `unanswered`.** These are requests the recording has nothing for. A few are expected (standings, Vancouver). Many unexpected ones mean the worker asks for something new, which a new recording would need to include.

## Automated scenario tests

`tests/replay.test.ts` plays the men's 500 m finals on Oct 31 through the real worker and API, and checks the round at each step:
1. both finals are start lists;
2. Final B is official;
3. Final A is running, and the events list's live card points at it;
4. Final A has 5 ranked results;
5. Final A is official with 4 ranked (one skater was penalized), and the round is finished.

It runs with the other database tests:

```bash
cd server && TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/shorttrack_test npm test
```

The pattern for a new scenario:
- start a `VirtualClock` that only moves when told (`new VirtualClock(start, 1, () => 0)`);
- create a `FakeIsu` over a slice and an `IsuClient` that fetches through it;
- create a `SyncWorker`;
- `clock.jump(...)`, then `worker.tick(clock.now())`, then check the API with supertest.

To cut a slice for it, keep only the requests the scenario needs:

```bash
npm run recording:slice -- --from 2026-10-31T18:30:00Z --to 2026-10-31T18:50:00Z \
  --match /events/list --match getschedule --match world-tour-2-montreal --match '"16034"' \
  --match 'event_result_round_id=22931&' --out ../data/recordings/<name>.ndjson.gz
```

Each `--match` is looked for in the request's path or body:
- `16034` is the competition (`event_result_id`): the Men 500 m;
- `22931` is the round (`event_result_round_id`): its finals.

`npm run replay:live -- --list` shows rounds by name. To get their ids, read the `getschedule` responses in the recording (`event_result_id`, `event_result_round_id`).

Keep slices small (this one is 23 KB) and commit them under `data/recordings/`.

## Recording another weekend

Recording is off, because a weekend takes 30–50 MB of the 500 MB database. To record one:
1. Set `ISU_RECORD=1` in Render's environment before the event, and remove it afterwards.
2. Export the weekend with `npm run recording:export -- --from <day before> --to <day after> --out recordings/<name>.ndjson.gz`.
3. With Aaron's OK, delete those rows from `isu_recording`, then run `vacuum full isu_recording` to hand the space back.

The Montréal rows are still in the database. Once everyone who needs the file has it, they can go the same way (45 MB).
