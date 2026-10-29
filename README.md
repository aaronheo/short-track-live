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

Apply the files in `supabase/migrations/` to the database once, in order, then:

| Command | What it does |
| --- | --- |
| `npm run backfill` | Stores every event of the current and previous season (about 25 min the first time). A finished event is fetched again daily for a week while ISU corrects it, then never again. Results ISU never published show as "No time"; an event it has no results for at all is left out of the app |
| `npm run backfill:history` | Stores every season from 2019/20 on, newest first (about an hour). ISU's results before 2019/20 are fragments, one race per round, so they're left out. Stops once the database passes `BACKFILL_MAX_DB_MB` (default 400, under Supabase's 500 MB free tier); run it again to pick up where it stopped |
| `npm run dev` | API on port 4310 plus the sync worker (polls ISU only while an event is live) |
| `npm run api` | API only |
| `REPLAY_HEAT=<heat id> npm run api` | Replays a finished heat lap by lap as if it were live, for testing the live screens |
| `npm test` | Unit tests; set `TEST_DATABASE_URL` to a throwaway database to also run the database and API tests (they drop its schema) |

The server sends ISU at most one request per second and keeps every raw response in `server/.cache/`.

### Ask

Questions typed into Search ("How did Sarault do at the Olympics?") go to `POST /chat`, which answers with OpenAI from our database. The model looks things up with a few tools (athlete search, an athlete's races, event finals, a heat) and, for anything else, one read-only `SELECT` run as the `chat_reader` role (migration 0003) with a 5 s timeout. Answers stream back as server-sent events. Nothing is stored: the app sends the conversation with each question and OpenAI is called with `store: false`.

| Variable | |
| --- | --- |
| `OPENAI_API_KEY` | Turns Ask on. Without it `/chat` answers 503 |
| `OPENAI_MODEL` | Default `gpt-5.5` |
| `OPENAI_REASONING_EFFORT` | Default `low` |

`/chat` allows 60 questions an hour. To try a question without the app: `npx tsx src/chat/try.ts "Who won the men's 1500 m in Vancouver?"`.

## Deploying (Render)

Live at https://short-track-live.onrender.com (workspace `short-track-live`). `render.yaml` describes it: one web service in Oregon, next to the Supabase project, running the API and the sync worker together. It's on the free plan, so it sleeps after 15 minutes without requests and the first request after that takes about a minute; ISU is only polled while it's awake.

1. Render Dashboard → **New → Blueprint** → pick this repo.
2. Fill in `DATABASE_URL` with Supabase's **Session pooler** string (Connect → Session pooler). Render has no IPv6, so the direct `db.<ref>.supabase.co` string won't connect.
3. Render generates `API_TOKEN`. Copy `ios/Config/Secrets.xcconfig.example` to `ios/Config/Secrets.xcconfig` and put the service URL and that token in it.
4. For Ask, add `OPENAI_API_KEY` under the service's **Environment**.
5. For signing in, add `GOOGLE_CLIENT_ID` (see Accounts below).

Every push to `main` redeploys. The raw ISU cache lives on the service's disk and is lost on redeploy; that only costs a refetch of events that aren't complete yet.

## iOS app

```bash
brew install xcodegen
cd ios && xcodegen generate && open ShortTrackLive.xcodeproj
```

The app talks to `http://localhost:4310` by default (`ios/Config/App.xcconfig`). To use the deployed server, create `ios/Config/Secrets.xcconfig` as described above; launch arguments `-APIBaseURL` and `-APIToken` override both. Deep links for testing: `shorttrack://event/<slug>`, `shorttrack://round/<id>`, `shorttrack://heat/<id>`, `shorttrack://athlete/<id>`.

Tabs: Events, Standings, Profile, and Search, where a name finds athletes and a question goes to Ask.

### Favorites and notifications

Star a skater on their page, or add them in Profile (which also holds light/dark). Favorites stay on the phone. The app asks the server for their races (`GET /favorites/races?skaters=…`, which also writes the notification text) and notifies, if you allow it, when a favorite's race is next on the ice and when its result is official, relays included. ISU names a relay team's skaters only after the race, so before it a relay counts if the favorite skated that relay for that nation in the past year, and the alert names the team ("Netherlands is up next · Velzeboer's team"). Profile has a switch for each kind, so results can stay unspoiled.

There's no push from the server yet: that needs a paid Apple developer account (APNs). Until then the phone does it. It schedules "up next" for 4 minutes before each heat's planned start, and posts it straight away if the server says the heat is next. Results come whenever the app gets to check: every 30 s while it's open and a favorite is racing, and in background refreshes, which iOS runs when it sees fit (often not for a while).

### Standings

ISU's own World Tour standings, as isu-skating.com shows them: the Crystal Globe (overall) for women and men, each distance and relay, the mixed relay and nations. The sync worker reads them from ISU (`/events/get-world-standings-list`, then each list's skaters) every 6 hours, hourly around an event, and only fetches lists ISU has updated. They live in `standing` and `standing_entry`, with skaters linked by ISU's id and each column matched to that season's World Tour events in order. `GET /standings` serves the latest season; Ask can query them too.

Tapping a skater shows their points by distance and stop, and what one result at the next stop would do against today's standings, using ISU's points per place (100, 80, 70, 60, 50, 44 …). On wide screens the list and the skater sit side by side.

### Accounts (Sign in with Google)

Signing in is optional; without it everything stays on the phone. Signed in, favorites and settings (notification switches, appearance) are saved to an account and come back on another iPhone or iPad. On the first sign-in the phone's favorites and the account's are combined and the phone's settings win; after that the phone sends its whole state after each change (`PUT /me`) and loads the account's when the app opens (`GET /me`), so the last change wins.

The app does Google's sign-in itself (system sign-in sheet, PKCE, no Google SDK) and sends the ID token to `POST /auth/google`. The server checks it against Google's keys and `GOOGLE_CLIENT_ID`, and returns a session token the app keeps in the Keychain and sends as `X-Session`. Accounts live in `account`, `account_session` (only a SHA-256 of each token) and `account_favorite`, which the Ask role can't read. Signing out keeps the phone's copy; deleting the account removes everything saved in it.

Setup, once:
1. Google Cloud Console → a project → **Google Auth Platform**: set up the consent screen (External; while it's in Testing, add your Google account as a test user).
2. **Clients → Create client → iOS**, bundle id `com.aaronheo.shorttracklive`. Copy the client id (`….apps.googleusercontent.com`; not a secret).
3. Put it in `GOOGLE_CLIENT_ID` in `ios/Config/App.xcconfig` and in Render's environment. Without it the app shows no sign-in and `/auth/google` answers 503.

Sign in with Apple needs the paid Apple developer account, so it comes later.

Flags are from [flag-icons](https://github.com/lipis/flag-icons) (MIT, see `ios/ShortTrackLive/Resources/FlagIconsLICENSE.txt`).

## Using ISU's data

The results come from ISU's public results API. ISU's terms don't allow systematic collection or republishing without written permission, so this is for personal use until ISU says yes: no public release, no App Store, no ISU logos or skater photos.
