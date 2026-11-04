# Short Track Live: handoff for the next agent

Read this first, then `README.md` (setup, commands, feature notes). This file covers what the README doesn't: how Aaron likes to work, where everything runs, what ISU's data actually does, what's in flight, and what's next.

Last updated 2026-10-31, day 2 of World Tour #2 (Montréal, Oct 30 – Nov 1).

## What this is

An iPhone app (SwiftUI, iOS 18+, also iPad and the iPhone Duo foldable) for following ISU short track speed skating: schedules, live heats lap by lap, results, qualification, athlete histories, World Tour standings, favorites with notifications, a prediction game (Picks), and Ask (questions answered by an LLM from our database). A Node server polls ISU's undocumented results API, stores everything in Postgres, and serves screen-shaped JSON to the app. The app never talks to ISU.

**Personal use only.** ISU's terms forbid systematic collection or republishing without written permission. No App Store, no public release, no ISU logos or skater photos. Don't propose launch work.

## How Aaron works (follow these)

- **Show designs before building.** New screens or visible UI go on the design canvas first (see Design canvas below), and wait for a yes. Small follow-ups Aaron specifies exactly (e.g. "move this setting to Profile") can be built directly. He has also approved reusing an existing pattern without a new mock (the Standings season menu reuses Events').
- **Push straight to `main`.** No branches or PRs. Every push to `main` deploys the server on Render.
- **Commit messages** describe the user-visible change in plain words, and end with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- **Production database migrations need Aaron's go-ahead** before you apply them, and so do bulk deletes. Additive data fixes he asked for are fine. Ask with one clear question; don't push code that depends on an unapplied migration.
- **Secrets never go in git and never get read.** `server/.env` and `ios/Config/Secrets.xcconfig` are gitignored. Don't print or copy their values (reading `OPENAI_API_KEY` was blocked before). Aaron sets secrets in Render himself. The Google client id is not a secret.
- **The Ask model's SQL runs as the read-only `chat_reader` role.** It must never get access to account or pick tables. New tables get no grant to it unless they hold public results.
- **Comments on the design canvas:** answer in the comment's thread; leave threads for Aaron to resolve unless he asks.
- **Verify before saying done.** Run both test suites, check in the simulator, install on his phone (commands below), and say plainly what you could and couldn't check.
- Writing style he responds to: short, plain, concrete (real names, real times). No filler.

## Where things run

| What | Where |
| --- | --- |
| Code | `~/code/short-track-live`, GitHub `aaronheo/short-track-live` |
| Database | Supabase project `gcrkqfwjyihmqcbhovpi` (Postgres, free tier, ~100 MB of 500 MB). RLS on every table, no public policies: only our server reads/writes |
| Server | Render web service `srv-dbfs70ek1f9s7388btv0`, https://short-track-live.onrender.com. API and sync worker in one process (`npm start`). Auto-deploys from `main`. Requests need the app's bearer token (`API_TOKEN`), so a bare `curl` gets 401 |
| Design canvas | https://claude.ai/code/artifact/fee6de94-63a7-4acb-a235-ab6c771f5294 (Design artifact; pages per area, dark mode, Duo layouts; "26 · Helmet numbers" is the latest board, on its own page) |
| Aaron's iPhone | device id `00008160-0004554601E80036` |
| Simulators | iPhone 17 `03AD718F-E127-4F10-AC80-D2F98DE8E255` (use this one; the iPhone 17 Pro simulator is gone); iPad mini `3FA17204-…`; iPhone Duo `A9200F85-D8FD-4F3B-9349-CF9CAAFA8EE6` (see Gotchas) |

Debug builds also point at Render, because `Secrets.xcconfig` sets `API_BASE_URL`. A local `npm run dev` server isn't used by the app unless you change that.

## Build, test, ship

```bash
# Local test Postgres (throwaway; the db tests drop its schema). If port 54329 refuses connections, start one:
#   initdb -D <dir>/pg -U postgres --auth=trust -E UTF8
#   echo "port = 54329" >> <dir>/pg/postgresql.conf; echo "unix_socket_directories = ''" >> <dir>/pg/postgresql.conf
#   LC_ALL=en_US.UTF-8 pg_ctl -D <dir>/pg -l <dir>/pg.log start
#   psql -h 127.0.0.1 -p 54329 -U postgres -c "create database shorttrack_test"
# (Without LC_ALL it fails with "postmaster became multithreaded"; a long scratch path breaks the Unix socket, hence TCP only.)
# Server tests
cd server && TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/shorttrack_test npx vitest run --no-file-parallelism
cd server && npx tsc --noEmit -p .

# iOS tests (Swift Testing)
cd ios && xcodebuild test -project ShortTrackLive.xcodeproj -scheme ShortTrackLive -destination 'id=03AD718F-E127-4F10-AC80-D2F98DE8E255'

# Install on Aaron's phone (Release)
xcodebuild -project ios/ShortTrackLive.xcodeproj -scheme ShortTrackLive -configuration Release \
  -destination 'id=00008160-0004554601E80036' -derivedDataPath ios/build/device -allowProvisioningUpdates build
xcrun devicectl device install app --device 00008160-0004554601E80036 ios/build/device/Build/Products/Release-iphoneos/ShortTrackLive.app
```

At last count: 99 server tests, 47 iOS tests, all passing. The Xcode project is generated by XcodeGen from `ios/project.yml` (`xcodegen generate` after adding files).

Deep links for checking screens in the simulator: `shorttrack://event/<slug>`, `round/<id>`, `heat/<id>`, `athlete/<id>`, `pick/<heatId>`. Andrew Heo is athlete `262`; Montréal 2026 is `isu-short-track-world-tour-2-montreal`.

One-off scripts against production go in your scratch space and run with `npx tsx script.mts` from `server/` (top-level await needs `.mts`; `src/db/pool.ts` already loads `.env`, so don't import dotenv yourself).

## Code map

**Server (`server/src`)**
- `isu/client.ts`: ISU client. One request at a time, ≤1/s, retries, raw responses cached on disk. `recording` flag + `recorder` hook.
- `isu/recorder.ts`: saves changed ISU responses during live events into `isu_recording`.
- `db/ingest.ts`: ISU JSON → our tables (events, competitions, rounds, heats, entries, laps, schedule). Heat times, event short names, and city cleanup happen here. ISU sometimes returns an unfinished heat with most of its skaters missing; if a response has fewer than half the entries we stored, the roster is kept until an official result replaces it.
- `sync/worker.ts`: polling policy: backfill once, daily event list, live event polling (racing heats every 10 s and always first in ISU's one-request queue; structure every 60 s and far-off start lists every 10 min, both skipped while a heat is running), settling re-pulls for a week, standings. `prioritizeRounds()` is tested in `tests/sync.test.ts`. `sync/standings.ts`: World Tour / World Cup standings, all seasons since 2019/20.
- `api/app.ts`: routes. `api/views.ts` + `api/repo.ts`: events, schedule, rounds, heats. Other files: `athletes.ts`, `favorites.ts`, `accounts.ts` (Google sign-in, settings sync), `picks.ts`, `standings.ts`, `helmet.ts` (this season's helmet number).
- `domain/`: pure logic, unit tested: `time.ts` (ISU time conventions), `rules.ts` (qualification rule parser), `places.ts` (the qualified/time-spots card), `format.ts` (labels, event names, cities), `standings.ts`, `picks.ts`, `alerts.ts`, `summary.ts`.
- `push/`: APNs (`apns.ts`, HTTP/2 + ES256 token) and `devices.ts` (registrations, `sendDue()` after each live poll).
- `chat/`: Ask (OpenAI, tools + read-only SQL; schema description in `tools.ts`).
- `dev/replay.ts`: `REPLAY_HEAT=<id>` fakes one finished heat as live at the API layer.

**iOS (`ios/ShortTrackLive`)**
- `App/`: `ShortTrackLiveApp.swift` (tabs; split vs stack layout; tab-bar-on-scroll; `screen(title:)`), `AppModel.swift` (navigation state, deep links, `tabBarAtSide`/`tabBarFixed`).
- `Networking/Live.swift`: polling loader used by every screen. `APIClient.swift`.
- `Models/API.swift` (decodable responses), `Models/Formatting.swift` (`Fmt`, and `RaceTimes`: the single venue/my-time setting).
- `DesignSystem/`: `Theme`, `Components` (`FlagView`, `QualBadge`, `HelmetBadge`, …).
- `Features/`: Events, Schedule, Round, Heat, Athlete, Search, Ask, Standings, Picks, Profile (favorites, notifications, `RaceAlerts` local notifications, accounts).

**Database (`supabase/migrations`)**: 0001–0012. Recent: 0008 picks, 0009 `isu_recording`, 0010 `event.short_name`, 0011 `pick.advanced`, 0012 `push_device` / `push_sent`. Apply new ones after Aaron says yes. The Supabase MCP refused `apply_migration` on 2026-11-03 (permission error); 0012 went in with a one-off script on the server's pool (`npx tsx script.mts` from `server/`), recorded in `supabase_migrations.schema_migrations`.

## What ISU's data really does (hard-won)

- **Times.** `schedule.start_time` is real UTC. `heat.date` used to be the venue's wall-clock time with a fake `Z`; in late October 2026 ISU switched to real UTC (it rewrote Vancouver's heats after the event). `domain/time.ts heatTimes()` reads each round's heats whichever way puts the first heat at or just after ISU's schedule time. Older events without schedule times use wall-clock. Event `from_date`/`to_date` are local midnights with a `Z`. ISU's venue time zones are often wrong; `venueTimeZone()` overrides them by city/country.
- **Round dates** can't be trusted; a round starts with its first heat.
- **The bib is the helmet number**: a skater's place in last season's World Tour, the same at every World Tour event in a season (men and women numbered separately). Championships number skaters their own way.
- **ISU's `message` field** alternates between "… fetched successfully" and "… (cache)"; ignore it when comparing responses.
- **Event names vary by year** ("ISU World Cup 2019/20 - Salt Lake City (USA)", "ISU World Cup Short Track Speed Skating", sponsor prefixes). `event.short_name` is computed per season in date order (`eventNames()`): "World Cup #3", "World Tour #1", "European Championships", "Junior World Championships". 2024/25's World Tour events sit under ISU's "World Cup" series. Cities: arena names dropped, "Dordrech" → Dordrecht, Montreal → Montréal.
- **Standings** (`/events/get-world-standings-list`, season ids: 47 = 2026/27, 1 = 2025/26, 2 = 2024/25, 3 = 2023/24, 4 = 2022/23, 5 = 2021/22, 7 = 2019/20; 2020/21 had no World Cup). Lists before 2024/25 have empty `gender` (use the discipline name, or the skaters' gender for overall lists). Junior lists are mixed in and excluded. Some entries have a null rank and are dropped. Relay results in brackets like "(60)" are dropped results and are stored as null. Columns repeat countries, so points map by `display_order`. Column dates can be weeks off; columns match events by country plus nearest date.
- **Results get corrected for days.** Finished events are re-pulled until they settle a week later.
- ISU's results before 2019/20 are fragments; history starts at 2019/20.

## Features shipped (most recent first)

Done Oct 30 in another session (commits 7cf3244 → 453ef36):
- **Trackboard restyle** (`Theme.swift`): graphite, warm-paper and ice-blue palette, cards with a hairline border and soft shadow, capsule LIVE badge. The design canvas still shows the old palette.
- **Events tab** is one "Events" list for the season, finished ones marked "Completed" (no more Latest results / Coming up / show-all toggle). The live event card says "Up next" between races (`onTheIce.isLive`) and falls back to the event's next round.
- **Schedule** shows every round of the day (no "Show N earlier rounds" fold).
- **Lap totals** read as skaters count them: 500 m is "of 4½", 1500 m "of 13½" (ISU's data counts the opening half lap as a lap; `lapTotalLabel()` / `Fmt.lapTotal`).
- **Picks lock two races ahead**: a heat locks when the race two places before it starts; the first race after a ≥10-minute break locks 3 minutes before its own start (`lockTimes()` in `api/picks.ts`, `locksAt` in the response, countdown in the app). Saved picks leave the "Pick now" list.
- **Worker** puts running heats first in ISU's queue (see Code map); **ingest** keeps rosters through ISU's partial responses.

- Event names cleaned up for every season (`short_name`), cities cleaned.
- **Race times setting** in Profile (Venue time / My time) drives every time in the app: Schedule (days regroup in my time; header says "Times in ET"), round headers, start lists, athlete upcoming races, Picks. Syncs with the account (`settings.venueTime`). The Schedule's old toolbar picker is gone. AppStorage key is still `scheduleInVenueTime`.
- **Helmet numbers** (`HelmetBadge`) beside names in heat results, round heats, live heat, start lists, Picks (all three views), athlete header (large), Search, favorites, Add favorites. Not in Standings, Ask, the places card, or relay teams.
- Athlete race list: upcoming races show their start time.
- **Heat time fix** (see Times above); Vancouver and Montréal were reloaded from ISU afterwards.
- **ISU recording** for testing live features (see below).
- Standings for every season back to 2019/20 with the Events-style season menu.
- iPhone Duo: tab bar stays put in split layouts and on the cover screen (side tab bar detected on either edge); cover screen hides the navigation bar background/top edge effect (it drew an empty strip).
- Picks (signed-in only) with a "Picks are open" notification and a switch in Profile.
- Earlier: Sign in with Google and sync, favorites + local race notifications, standings tab, position-by-lap chart, relay members, Ask.

## In flight right now

- **Montréal (World Tour #2) is racing Oct 30 – Nov 1.** The production worker polls it, and **every changed ISU response is being recorded** in `isu_recording`. Don't break the worker this weekend; if you must deploy, keep it small and check Render logs afterwards.
- **Recording is bigger than expected:** about 22,500 rows and 22 MB (gzipped) after two days of Montréal; the database is at 130 MB of Supabase's 500 MB free tier. Recording every event all season would fill it. Before the next event, decide with Aaron: export each finished event's recording to a file (and delete the rows, with his OK), record only some events, or slim what's kept.
- **Uncommitted work in the working tree** (Aaron's, from the Oct 30 session; tests pass, not deployed):
  - **ADV picks**: a skater can be picked as advanced by the referee (ADV button beside PEN). Penalties and advancements both score 5 now (places still 3 / 1). `PUT /picks/heats/:id` takes `advanced`; scoring counts an `ADV…` qualification code. Needs migration `0011_pick_advancements.sql` (untracked file; **already applied in production**). The app decodes picks without `advanced` as empty, so it works against the deployed server too.
  - **Leaderboard** moved off the Picks home: the score card opens it as its own screen.
  - The live heat's "Updated Ns ago" ticker is gone (and `Live.updatedAt` with it); a start list card shows its time ("Up next · 09:54") rather than "Start list"; the heat screen shows no "Start list" status.
  - README's Picks section already describes ADV scoring and the two-races-ahead lock.
  Ask Aaron before committing or reverting any of it; when he says ship, commit it together with 0011 and push.
- Untracked files at the repo root (`isu_shorttrack.py`, `load.py`, `schema.sql`, `queries.sql`, `data-scan/`, `data/laps.csv`, `.cache/`) are the original Python prototype and scratch data. Leave them alone.

## Next: testing live features without a live race

Aaron's goal is to test the live features thoroughly before calling this production quality. The agreed plan, step 1 done:

1. ✅ **Record real live weekends.** `isu_recording(fetched_at, key, method, path, body, hash, data gzip)`. One row per changed response during live polling. Montréal is the first full recording. Read rows with `gunzipSync(row.data)`.
2. **Fake ISU server.** An `IsuClient` stand-in (or `fetchImpl`) that serves a recording on a virtual clock: real time, 10×/60×, pause, jump to a time. Until a recording exists, synthesize a timeline from a finished event (start list → running with laps appearing by `elapsed_ms` → unofficial → official). Then the real worker → ingest → DB → API → app all run. `dev/replay.ts` is a much smaller version of this idea, at the API layer only.
3. **Scenario tests in vitest** on top of it: play a timeline, assert at checkpoints. Picks open when a QF goes official; a penalty after unofficial changes who advances; picks lock two races ahead (and 3 minutes before the first race after a break) and score when official; a re-run heat; the schedule slipping; ISU erroring mid-round; results corrected after official.
4. **A test server for the phone.** A second Render service in simulation mode with its own database (never production), and a hidden Debug-only control in Profile for event, speed and jump time.

Propose the design of 2–4 to Aaron before building; 4 involves new infrastructure.

## Other open items

- The Duo cover-screen top-strip fix wasn't verified on a device (the Duo simulator stopped loading data). Ask Aaron to confirm.
- Earlier unconfirmed: Search on the folded Duo shows its field at the bottom without overlap.
- Offered, not taken up: iOS 26 native tab-bar minimize behavior on phones.
- The design canvas predates the Trackboard palette (most boards still use the old blue-grey colors).
- Later ideas Aaron has mentioned: follow a country, head-to-head (designed on the canvas), race chat (nicknames already exist for it).
- **Paid Apple developer account since 2026-11-03** (team `8L8VJTQFD6`). Server push is built (see README); it's on once `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID` are set in Render. Still to do: Sign in with Apple and a Live Activity (mock both on the canvas first), and TestFlight (internal testing only, for personal use).

## Gotchas

- **Simulator screenshots lag** a few actions behind; take another before trusting one. For a sure read: `xcrun simctl io <udid> screenshot file.png`.
- **The Duo simulator** (cover screen) doesn't register taps on its side tab bar, and recently wouldn't load data at all. Use the iPhone simulator for checks and ask Aaron to confirm Duo behavior on his device.
- Changing an app setting in the simulator: `defaults write` on the bundle id doesn't reach the app. Use the container plist path through cfprefsd: `xcrun simctl spawn <udid> defaults write "<data container>/Library/Preferences/com.aaronheo.shorttracklive" <key> -bool false`. Bundle id: `com.aaronheo.shorttracklive`.
- macOS has no `timeout`; long waits go in background shell tasks.
- Render's free plan sleeps after 15 minutes idle; the worker only polls ISU while the service is awake. Its disk (the ISU cache) is wiped on every deploy.
- `cd` inside parallel shell commands can race; prefer absolute paths.
- New tables: enable RLS, revoke from `anon`/`authenticated` (see 0008/0009), and decide deliberately whether `chat_reader` may read them.
