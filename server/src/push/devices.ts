// Phones registered for push, and the job that sends what each is due. The
// worker runs sendDue() after each live poll, so an alert goes out within
// seconds of ISU's change.

import type { Db } from '../db/pool.js';
import type { SavedFavorite } from '../api/accounts.js';
import { Favorites } from '../api/favorites.js';
import { Picks } from '../api/picks.js';
import { picksAlerts, raceAlerts, type PushAlert } from '../domain/push.js';
import type { ApnsEnvironment, PushSender } from './apns.js';

export interface DeviceRegistration {
  token: string;
  environment: ApnsEnvironment;
  favorites: SavedFavorite[];
  starts: boolean;
  results: boolean;
  picks: boolean;
  accountId: number | null;
}

interface DeviceRow {
  token: string; environment: ApnsEnvironment; favorites: SavedFavorite[];
  notify_starts: boolean; notify_results: boolean; notify_picks: boolean; account_id: number | null;
}

/** APNs device tokens are 32 bytes today; allow for longer ones. */
export const validToken = (token: string) => /^[0-9a-f]{64,200}$/i.test(token);

export class PushDevices {
  private readonly favorites: Favorites;
  private readonly picks: Picks;

  constructor(private readonly db: Db, private readonly sender: PushSender | null,
    private readonly log: (msg: string) => void = (m) => console.log(`[push] ${m}`)) {
    this.favorites = new Favorites(db);
    this.picks = new Picks(db);
  }

  get enabled(): boolean { return this.sender != null; }

  /**
   * Saves what this phone wants. A new phone's alerts that are already due
   * count as sent, so registering mid-event doesn't replay the day's results.
   */
  async register(d: DeviceRegistration, now: Date): Promise<void> {
    const { rows } = await this.db.query<{ created: boolean }>(
      `insert into push_device (token, environment, favorites, notify_starts, notify_results, notify_picks, account_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (token) do update set environment = $2, favorites = $3, notify_starts = $4, notify_results = $5,
         notify_picks = $6, account_id = $7, updated_at = now()
       returning (xmax = 0) as created`,
      [d.token, d.environment, JSON.stringify(d.favorites), d.starts, d.results, d.picks, d.accountId]);
    if (!rows[0]?.created) return;
    const due = await this.due(await this.device(d.token), new Set(), now);
    await this.markSent(d.token, due.flatMap((a) => [a.id, ...(a.covers ?? [])]));
  }

  async remove(token: string): Promise<void> {
    await this.db.query('delete from push_device where token = $1', [token]);
  }

  /** Sends every device what it's due. Returns how many went out. */
  async sendDue(now: Date): Promise<number> {
    if (!this.sender) return 0;
    const devices = (await this.db.query<DeviceRow>(
      `select token, environment, favorites, notify_starts, notify_results, notify_picks, account_id from push_device
       where notify_starts or notify_results or (notify_picks and account_id is not null)`)).rows;
    let count = 0;
    for (const device of devices) {
      const sent = new Set((await this.db.query<{ alert_id: string }>(
        'select alert_id from push_sent where token = $1', [device.token])).rows.map((r) => r.alert_id));
      for (const alert of await this.due(device, sent, now)) {
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
    // A heat's alerts are done within days.
    await this.db.query(`delete from push_sent where sent_at < now() - interval '7 days'`);
    return count;
  }

  private async device(token: string): Promise<DeviceRow> {
    return (await this.db.query<DeviceRow>(
      `select token, environment, favorites, notify_starts, notify_results, notify_picks, account_id
       from push_device where token = $1`, [token])).rows[0]!;
  }

  private async due(device: DeviceRow, sent: Set<string>, now: Date): Promise<PushAlert[]> {
    const out: PushAlert[] = [];
    if ((device.notify_starts || device.notify_results) && device.favorites.length) {
      const added = new Map(device.favorites.map((f) => [f.id, new Date(f.addedAt)]));
      const { races } = await this.favorites.races([...added.keys()], now);
      out.push(...raceAlerts(races, added, { starts: device.notify_starts, results: device.notify_results, picks: false },
        sent, now, (race) => race.event));
    }
    if (device.notify_picks && device.account_id != null) {
      const home = await this.picks.home(device.account_id, now);
      out.push(...picksAlerts(home.open, home.event, sent));
    }
    return out;
  }

  /** Marks alerts sent; true if the first one wasn't already. */
  private async markSent(token: string, ids: string[]): Promise<boolean> {
    if (!ids.length) return false;
    const { rowCount } = await this.db.query(
      `insert into push_sent (token, alert_id) select $1, unnest($2::text[]) on conflict do nothing`, [token, ids]);
    return ids.length === 1 ? rowCount === 1 : (rowCount ?? 0) > 0;
  }
}
