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

While an event is live, the sync worker also records what ISU answers, with when, in `isu_recording` (migration 0009): the event list and the live polling, gzipped, and only when a response differs from the last one for the same request. It's for playing a live weekend back later to test the live features. `ISU_RECORD=0` turns it off.

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

Tabs: Events, Standings, Picks, Profile, and Search, where a name finds athletes and a question goes to Ask.

### Favorites and notifications

Star a skater on their page, or add them in Profile (which also holds light/dark). Favorites stay on the phone. The app asks the server for their races (`GET /favorites/races?skaters=…`, which also writes the notification text) and notifies, if you allow it, when a favorite's race is next on the ice and when its result is official, relays included. ISU names a relay team's skaters only after the race, so before it a relay counts if the favorite skated that relay for that nation in the past year, and the alert names the team ("Netherlands is up next · Velzeboer's team"). Profile has a switch for each kind, so results can stay unspoiled.

With server push (APNs) the server sends these the moment they happen. The phone registers its push token with its favorites and switches (`PUT /devices/:token { environment, favorites, notifyStarts, notifyResults, notifyPicks }`, with `X-Session` when signed in so "Picks are open" can come too), again whenever they change and once a day. After each live poll the worker works out what each phone is due (`domain/push.ts`, the same rules the phone used) and sends it; `push_sent` keeps each alert to once, and a new phone's already-due alerts count as sent. Push needs `APNS_KEY` (the .p8's contents), `APNS_KEY_ID` and `APNS_TEAM_ID` on the server; the deploy log says "Push: on". Builds Xcode installs use APNs' sandbox, TestFlight builds production (the app reads its embedded profile).

When the server can't push (no APNs key, or it can't be reached) the phone does it itself, as before: it schedules "up next" for 4 minutes before each heat's planned start, posts it straight away if the server says the heat is next, and posts results whenever it gets to check (every 30 s while it's open and a favorite is racing, and in background refreshes, which iOS runs when it sees fit).

### Live Activities

When a favorite's individual race is up next, the server starts a Live Activity on the phone with a push (the phone registers its push-to-start token with `PUT /devices/:token`, `activityToken`). The activity shows "up next", then the race lap by lap (lap, progress, the top three plus the favorite with gaps to the leader), then the result; it ends when the result is official and stays on the Lock Screen 30 minutes. The phone reports each activity's own token (`PUT /activities/:token { device, heatId }`) and the worker sends an update after each poll when something changed (`live_activity`, `domain/activity.ts`). The widget extension (`ios/ShortTrackLiveWidgets`) and the app share `ios/Shared/RaceActivity.swift`, whose keys match the server's. Profile → Notifications → Live Activities turns it off. To see one without the server, a Debug build launched with `-sampleActivity` starts a sample: `xcrun simctl launch <device> com.aaronheo.shorttracklive -sampleActivity`, then switch apps (iOS hides an app's own activity while it's in front).

Render's free plan sleeps after 15 idle minutes, and a sleeping server neither polls ISU nor pushes. While an event is on or a day away, the worker requests its own public URL (`RENDER_EXTERNAL_URL`) every 10 minutes to stay up, and a GitHub Actions cron (`.github/workflows/wake.yml`) wakes it every 6 hours to notice an event coming.

### Standings

ISU's own World Tour standings, as isu-skating.com shows them: the Crystal Globe (overall) for women and men, each distance and relay, the mixed relay and nations. The sync worker reads them from ISU (`/events/get-world-standings-list`, then each list's skaters) every 6 hours, hourly around an event, and only fetches lists ISU has updated. They live in `standing` and `standing_entry`, with skaters linked by ISU's id and each column matched to that season's World Tour events in order. `GET /standings` serves the latest season; Ask can query them too.

Tapping a skater shows their place, points and gap to 1st, and their points by distance and stop (ISU gives 100, 80, 70, 60, 50, 44 … per place). On wide screens the list and the skater sit side by side.

### Picks

Before each quarterfinal, semifinal and final, signed-in people put the skaters in the order they think they'll finish, starting from the start order, and can mark any as penalized or advanced by the referee. Picks lock when the race two places before it in the running order begins, so nobody picks with a look at the warm-up; the first race after a break of 10 minutes or more locks 3 minutes before its own start instead (`locksAt` in the API). A race that has started is always locked. After picking, or once the race starts, everyone's picks show per skater: the most picked place, penalty, or advancement, with a bar for each. When the result is official a pick scores 3 for an exact place, 1 for one place off and 5 for a penalty, card, or referee advancement called right; scores are worked out when read, so a corrected result rescores. The Picks tab shows the live (or next) event's open races you haven't picked yet, your picks, and your score card, which opens the leaderboard. Leaderboards use a nickname, chosen at the first pick and changeable in Account; the race chat will use it too.

Skaters qualify into each round, so a round can only be picked once its start lists are out. The app checks `GET /picks` with the race alerts and sends one "Picks are open" notification per round (tap opens the race in Picks). It's a local notification, so with the app closed it comes at the next background refresh. Profile → Notifications → Picks are open turns it off (saved to the account).

API: `GET /picks`, `GET /picks/heats/:id`, `PUT /picks/heats/:id { finish, penalized, advanced }` (entry ids), `PUT /me/nickname`. Stored in `pick` and `account.nickname`.

### Accounts (Sign in with Apple or Google)

Signing in is optional; without it everything stays on the phone. Signed in, favorites and settings (notification switches, appearance) are saved to an account and come back on another iPhone or iPad. On the first sign-in the phone's favorites and the account's are combined and the phone's settings win; after that the phone sends its whole state after each change (`PUT /me`) and loads the account's when the app opens (`GET /me`), so the last change wins.

The app does Google's sign-in itself (system sign-in sheet, PKCE, no Google SDK) and sends the ID token to `POST /auth/google`. The server checks it against Google's keys and `GOOGLE_CLIENT_ID`, and returns a session token the app keeps in the Keychain and sends as `X-Session`. Accounts live in `account`, `account_session` (only a SHA-256 of each token) and `account_favorite`, which the Ask role can't read. Signing out keeps the phone's copy; deleting the account removes everything saved in it.

Setup, once:
1. Google Cloud Console → a project → **Google Auth Platform**: set up the consent screen (External; while it's in Testing, add your Google account as a test user).
2. **Clients → Create client → iOS**, bundle id `com.aaronheo.shorttracklive`. Copy the client id (`….apps.googleusercontent.com`; not a secret).
3. Put it in `GOOGLE_CLIENT_ID` in `ios/Config/App.xcconfig` and in Render's environment. Without it the app shows no sign-in and `/auth/google` answers 503.

Sign in with Apple uses Apple's own sheet (`SignInWithAppleButton`); the app sends Apple's identity token and, on the first sign-in only, the name Apple shares to `POST /auth/apple`. The server checks the token against Apple's keys with the bundle id as audience (`APPLE_CLIENT_ID` overrides it) and keeps Apple's id in `account.apple_sub`. Apple and Google sign-ins are separate accounts.

Flags are from [flag-icons](https://github.com/lipis/flag-icons) (MIT, see `ios/ShortTrackLive/Resources/FlagIconsLICENSE.txt`).

## Using ISU's data

The results come from ISU's public results API. ISU's terms don't allow systematic collection or republishing without written permission, so this is for personal use until ISU says yes: no public release, no App Store, no ISU logos or skater photos.
