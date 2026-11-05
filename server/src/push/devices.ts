// Phones registered for push, and the job that sends what each is due. The
// worker runs sendDue() after each live poll, so an alert goes out within
// seconds of ISU's change.

import type { Db } from '../db/pool.js';
import type { SavedFavorite } from '../api/accounts.js';
import { Favorites } from '../api/favorites.js';
import { Picks } from '../api/picks.js';
import { Repo } from '../api/repo.js';
import { activityRaceTitle, activityState, activityFavorite, type ActivityAttributes, type ActivityState } from '../domain/activity.js';
import type { AlertRace } from '../domain/alerts.js';
import { shortEventName } from '../domain/format.js';
import { picksAlerts, raceAlerts, type PushAlert } from '../domain/push.js';
import { lapsFor } from '../domain/time.js';
import type { ApnsEnvironment, PushSender } from './apns.js';

export interface DeviceRegistration {
  token: string;
  environment: ApnsEnvironment;
  favorites: SavedFavorite[];
  starts: boolean;
  results: boolean;
  picks: boolean;
  accountId: number | null;
  /** Live Activities' push-to-start token, hex; null when the phone can't start them. */
  activityToken: string | null;
  activities: boolean;
}

interface DeviceRow {
  token: string; environment: ApnsEnvironment; favorites: SavedFavorite[];
  notify_starts: boolean; notify_results: boolean; notify_picks: boolean; account_id: number | null;
  activity_start_token: string | null; notify_activities: boolean;
}

const DEVICE_SELECT = `select token, environment, favorites, notify_starts, notify_results, notify_picks, account_id,
  activity_start_token, notify_activities from push_device`;
/** A finished race's activity stays on the Lock Screen this long. */
const ACTIVITY_LINGER_S = 30 * 60;
/** An activity whose race never finished (ISU stopped updating) ends after this. */
const ACTIVITY_MAX_MS = 4 * 3600_000;
const liveActivityPush = { pushType: 'liveactivity' as const, topicSuffix: '.push-type.liveactivity', priority: 10 as const };

/** APNs device tokens are 32 bytes today; allow for longer ones. */
export const validToken = (token: string) => /^[0-9a-f]{64,200}$/i.test(token);

export class PushDevices {
  private readonly favorites: Favorites;
  private readonly picks: Picks;
  private readonly repo: Repo;

  constructor(private readonly db: Db, private readonly sender: PushSender | null,
    private readonly log: (msg: string) => void = (m) => console.log(`[push] ${m}`)) {
    this.favorites = new Favorites(db);
    this.picks = new Picks(db);
    this.repo = new Repo(db);
  }

  get enabled(): boolean { return this.sender != null; }

  /**
   * Saves what this phone wants. A new phone's alerts that are already due
   * count as sent, so registering mid-event doesn't replay the day's results.
   */
  async register(d: DeviceRegistration, now: Date): Promise<void> {
    const { rows } = await this.db.query<{ created: boolean }>(
      `insert into push_device (token, environment, favorites, notify_starts, notify_results, notify_picks, account_id,
         activity_start_token, notify_activities)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (token) do update set environment = $2, favorites = $3, notify_starts = $4, notify_results = $5,
         notify_picks = $6, account_id = $7, activity_start_token = $8, notify_activities = $9, updated_at = now()
       returning (xmax = 0) as created`,
      [d.token, d.environment, JSON.stringify(d.favorites), d.starts, d.results, d.picks, d.accountId, d.activityToken, d.activities]);
    if (!rows[0]?.created) return;
    const { alerts, activities } = await this.due(await this.device(d.token), new Set(), now);
    await this.markSent(d.token, [...alerts.flatMap((a) => [a.id, ...(a.covers ?? [])]), ...activities.map((h) => `activity-${h}`)]);
  }

  /** A Live Activity's own push token, sent by the phone once the activity is running. */
  async registerActivity(token: string, deviceToken: string, heatId: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `insert into live_activity (token, device_token, heat_id)
       select $1, d.token, h.id from push_device d, heat h where d.token = $2 and h.id = $3
       on conflict (token) do nothing`, [token, deviceToken, heatId]);
    return (rowCount ?? 0) > 0 || (await this.db.query('select 1 from live_activity where token = $1', [token])).rowCount === 1;
  }

  async remove(token: string): Promise<void> {
    await this.db.query('delete from push_device where token = $1', [token]);
  }

  /** Sends every device what it's due. Returns how many went out. */
  async sendDue(now: Date): Promise<number> {
    if (!this.sender) return 0;
    const devices = (await this.db.query<DeviceRow>(
      `${DEVICE_SELECT} where notify_starts or notify_results or (notify_picks and account_id is not null)
         or (notify_activities and activity_start_token is not null)`)).rows;
    let count = 0;
    for (const device of devices) {
      const sent = new Set((await this.db.query<{ alert_id: string }>(
        'select alert_id from push_sent where token = $1', [device.token])).rows.map((r) => r.alert_id));
      const { alerts, activities } = await this.due(device, sent, now);
      for (const heatId of activities) {
        if (await this.startActivity(device, heatId)) count++;
      }
      for (const alert of alerts) {
        // Claim it first, so a slow send can't go out twice.
        if (!(await this.markSent(device.token, [alert.id]))) continue;
        const result = await this.sender.send(device.token, device.environment, {
          payload: {
            aps: { alert: { title: alert.title, body: alert.body }, sound: 'default', 'thread-id': alert.thread },
            url: `shorttrack://${alert.link}/${alert.heatId}`,
          },
          collapseId: alert.id,
        });
        if (result === 'gone') {
          this.log('device token expired; removing it');
          await this.remove(device.token);
          break;
        }
        if (result === 'error') {
          await this.db.query('delete from push_sent where token = $1 and alert_id = $2', [device.token, alert.id]);
          continue;
        }
        await this.markSent(device.token, alert.covers ?? []);
        count++;
      }
    }
    count += await this.updateActivities(now);
    // A heat's alerts are done within days.
    await this.db.query(`delete from push_sent where sent_at < now() - interval '7 days'`);
    await this.db.query(`delete from live_activity where created_at < now() - interval '2 days'`);
    return count;
  }

  private async device(token: string): Promise<DeviceRow> {
    return (await this.db.query<DeviceRow>(`${DEVICE_SELECT} where token = $1`, [token])).rows[0]!;
  }

  /** Alerts due, and heats whose Live Activity should start (a favorite's individual race is up next). */
  private async due(device: DeviceRow, sent: Set<string>, now: Date): Promise<{ alerts: PushAlert[]; activities: number[] }> {
    const alerts: PushAlert[] = [];
    const activities: number[] = [];
    const wantsActivities = device.notify_activities && device.activity_start_token != null;
    if ((device.notify_starts || device.notify_results || wantsActivities) && device.favorites.length) {
      const added = new Map(device.favorites.map((f) => [f.id, new Date(f.addedAt)]));
      const { races } = await this.favorites.races([...added.keys()], now);
      alerts.push(...raceAlerts(races, added, { starts: device.notify_starts, results: device.notify_results, picks: false },
        sent, now, (race) => race.event));
      if (wantsActivities) {
        // The same race the "up next" alert is about: drop the alert text but keep the timing rules.
        const starts = raceAlerts(races.filter((r) => !r.relay), added, { starts: true, results: false, picks: false }, new Set(), now, () => '');
        activities.push(...starts.map((a) => a.heatId).filter((id) => !sent.has(`activity-${id}`)));
      }
    }
    if (device.notify_picks && device.account_id != null) {
      const home = await this.picks.home(device.account_id, now);
      alerts.push(...picksAlerts(home.open, home.event, sent));
    }
    return { alerts, activities };
  }

  /** The activity's fixed attributes and current content for this device's favorites. */
  private async activity(heatId: number, favorites: SavedFavorite[]): Promise<{ attributes: ActivityAttributes; state: ActivityState; official: boolean } | null> {
    const heat = await this.repo.heat(heatId);
    const round = heat ? await this.repo.round(heat.round_id) : null;
    if (!heat || !round) return null;
    const entries = await this.repo.entriesForHeat(heatId);
    const ids = new Set(favorites.map((f) => f.id));
    const me = activityFavorite(entries, ids);
    if (!me) return null;
    const race: AlertRace = {
      competition: round.competition, distanceM: round.distance_m, relay: round.is_relay, round: round.name, heat: heat.name,
      destination: round.destination, event: shortEventName(round.event_name),
    };
    const state = activityState(race, heat.state, entries, ids, lapsFor(round.distance_m));
    if (!state) return null;
    return {
      attributes: { heatId, event: race.event, race: activityRaceTitle(race), favorite: me.last, iso2: me.iso2 },
      state, official: heat.state === 'official',
    };
  }

  private async startActivity(device: DeviceRow, heatId: number): Promise<boolean> {
    if (!this.sender || !device.activity_start_token) return false;
    if (!(await this.markSent(device.token, [`activity-${heatId}`]))) return false;
    const activity = await this.activity(heatId, device.favorites);
    if (!activity) return false;
    const result = await this.sender.send(device.activity_start_token, device.environment, {
      ...liveActivityPush,
      payload: {
        aps: {
          timestamp: Math.floor(Date.now() / 1000), event: 'start',
          'content-state': activity.state, 'attributes-type': 'RaceActivityAttributes', attributes: activity.attributes,
          alert: { title: activity.state.headline, body: `${activity.attributes.race} · ${activity.attributes.event}` },
        },
      },
    });
    if (result === 'error') {
      await this.db.query('delete from push_sent where token = $1 and alert_id = $2', [device.token, `activity-${heatId}`]);
      return false;
    }
    if (result === 'gone') await this.db.query('update push_device set activity_start_token = null where token = $1', [device.token]);
    return result === 'ok';
  }

  /** Sends each running activity its race's latest state; ends it once the result is official. */
  private async updateActivities(now: Date): Promise<number> {
    if (!this.sender) return 0;
    const rows = (await this.db.query<{ token: string; heat_id: number; last_state: string | null; created_at: Date; environment: ApnsEnvironment; favorites: SavedFavorite[] }>(
      `select a.token, a.heat_id, a.last_state, a.created_at, d.environment, d.favorites
       from live_activity a join push_device d on d.token = a.device_token where not a.ended`)).rows;
    let count = 0;
    for (const row of rows) {
      const activity = await this.activity(row.heat_id, row.favorites);
      const stale = now.getTime() - row.created_at.getTime() > ACTIVITY_MAX_MS;
      const end = !activity || activity.official || stale;
      const json = activity ? JSON.stringify(activity.state) : null;
      if (!end && json === row.last_state) continue;
      const timestamp = Math.floor(Date.now() / 1000);
      const result = await this.sender.send(row.token, row.environment, {
        ...liveActivityPush,
        payload: {
          aps: end
            ? { timestamp, event: 'end', ...(activity ? { 'content-state': activity.state } : {}),
              'dismissal-date': timestamp + (activity?.official ? ACTIVITY_LINGER_S : 0) }
            : { timestamp, event: 'update', 'content-state': activity!.state },
        },
      });
      if (result === 'gone') {
        await this.db.query('delete from live_activity where token = $1', [row.token]);
        continue;
      }
      if (result === 'error') continue;
      await this.db.query('update live_activity set last_state = $2, ended = $3 where token = $1', [row.token, json, end]);
      count++;
    }
    return count;
  }

  /** Marks alerts sent; true if the first one wasn't already. */
  private async markSent(token: string, ids: string[]): Promise<boolean> {
    if (!ids.length) return false;
    const { rowCount } = await this.db.query(
      `insert into push_sent (token, alert_id) select $1, unnest($2::text[]) on conflict do nothing`, [token, ids]);
    return ids.length === 1 ? rowCount === 1 : (rowCount ?? 0) > 0;
  }
}
