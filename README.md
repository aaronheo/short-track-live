# Short Track Live

Live results for ISU short track events: the schedule in running order, each race's heats as they finish, who's qualified, and lap-by-lap data. For personal testing only until ISU agrees to how its data is used (see below).

```
server/    Node + Express + TypeScript: polls ISU, stores results in Postgres, serves the app API
supabase/  database schema (migrations)
ios/       SwiftUI app (iOS 18+), generated with XcodeGen
data/      real ISU responses used as test fixtures
design/    design tokens (the designs live in the Claude canvas)
```

## Server

Needs Node 22 and a Postgres database (a Supabase project, or a local one).

```bash
cd server && npm install
cp .env.example .env      # then paste your DATABASE_URL into .env
```

Apply `supabase/migrations/0001_init.sql` to the database once, then:

| Command | What it does |
| --- | --- |
| `npm run backfill` | Stores every event of the current and previous season (about 25 min the first time; finished events are never fetched again) |
| `npm run dev` | API on port 4310 plus the sync worker (polls ISU only while an event is live) |
| `npm run api` | API only |
| `REPLAY_HEAT=<heat id> npm run api` | Replays a finished heat lap by lap as if it were live, for testing the live screens |
| `npm test` | Unit tests; set `TEST_DATABASE_URL` to a throwaway database to also run the database and API tests (they drop its schema) |

The server sends ISU at most one request per second and keeps every raw response in `server/.cache/`.

## Deploying (Render)

Live at https://short-track-live.onrender.com (workspace `short-track-live`). `render.yaml` describes it: one web service in Oregon, next to the Supabase project, running the API and the sync worker together. It's on the free plan, so it sleeps after 15 minutes without requests and the first request after that takes about a minute; ISU is only polled while it's awake.

1. Render Dashboard → **New → Blueprint** → pick this repo.
2. Fill in `DATABASE_URL` with Supabase's **Session pooler** string (Connect → Session pooler). Render has no IPv6, so the direct `db.<ref>.supabase.co` string won't connect.
3. Render generates `API_TOKEN`. Copy `ios/Config/Secrets.xcconfig.example` to `ios/Config/Secrets.xcconfig` and put the service URL and that token in it.

Every push to `main` redeploys. The raw ISU cache lives on the service's disk and is lost on redeploy; that only costs a refetch of events that aren't complete yet.

## iOS app

```bash
brew install xcodegen
cd ios && xcodegen generate && open ShortTrackLive.xcodeproj
```

The app talks to `http://localhost:4310` by default (`ios/Config/App.xcconfig`). To use the deployed server, create `ios/Config/Secrets.xcconfig` as described above; launch arguments `-APIBaseURL` and `-APIToken` override both. Deep links for testing: `shorttrack://event/<slug>`, `shorttrack://round/<id>`, `shorttrack://heat/<id>`.

Flags are from [flag-icons](https://github.com/lipis/flag-icons) (MIT, see `ios/ShortTrackLive/Resources/FlagIconsLICENSE.txt`).

## Using ISU's data

The results come from ISU's public results API. ISU's terms don't allow systematic collection or republishing without written permission, so this is for personal use until ISU says yes: no public release, no App Store, no ISU logos or skater photos.
