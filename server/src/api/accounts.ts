// Accounts: sign in with Google, then favorite skaters and settings saved for
// the person. The phone keeps working without one; signed in, it sends its
// whole state after each change and loads the account's when it opens.

import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Db } from '../db/pool.js';

export interface GoogleIdentity { sub: string; email: string | null; name: string | null }
/** Checks a Google ID token from the app; throws when it isn't valid for us. */
export type VerifyGoogle = (idToken: string) => Promise<GoogleIdentity>;

export interface Settings {
  notifyStarts?: boolean;
  notifyResults?: boolean;
  appearance?: 'system' | 'light' | 'dark';
}

export interface AccountState {
  account: { name: string | null; email: string | null; provider: 'google'; nickname: string | null };
  favorites: { id: number; name: string; last: string; nat: string | null; iso2: string | null; gender: 'Men' | 'Women' | null; addedAt: string }[];
  settings: Settings;
  updatedAt: string;
}

export interface SavedFavorite { id: number; addedAt: string }

/** Google's ID tokens for our iOS client ids (GOOGLE_CLIENT_ID, comma-separated). */
export function googleVerifier(clientIds: string[]): VerifyGoogle {
  const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
  return async (idToken) => {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientIds,
    });
    if (!payload.sub) throw new Error('No subject');
    const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return { sub: payload.sub, email: payload.email_verified === false ? null : text(payload.email), name: text(payload.name) };
  };
}

/** Only the settings we know, with the right types. */
export function cleanSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Settings = {};
  if (typeof r.notifyStarts === 'boolean') out.notifyStarts = r.notifyStarts;
  if (typeof r.notifyResults === 'boolean') out.notifyResults = r.notifyResults;
  if (r.appearance === 'system' || r.appearance === 'light' || r.appearance === 'dark') out.appearance = r.appearance;
  return out;
}

/** The phone's favorites from a request body: at most 500, each once; null when malformed. */
export function parseFavorites(raw: unknown): SavedFavorite[] | null {
  if (!Array.isArray(raw) || raw.length > 500) return null;
  const out = new Map<number, SavedFavorite>();
  for (const f of raw) {
    const id = (f as { id?: unknown })?.id;
    const added = new Date(String((f as { addedAt?: unknown })?.addedAt));
    if (!Number.isInteger(id) || (id as number) <= 0 || Number.isNaN(added.getTime())) return null;
    out.set(id as number, { id: id as number, addedAt: added.toISOString() });
  }
  return [...out.values()];
}

const GENDER: Record<string, 'Men' | 'Women'> = { M: 'Men', F: 'Women' };
const hash = (token: string) => createHash('sha256').update(token).digest();

export class Accounts {
  constructor(private readonly db: Db) {}

  /** Finds or makes the account for this Google identity; returns a new session token. */
  async signInGoogle(who: GoogleIdentity): Promise<{ token: string; accountId: number }> {
    const { id } = (await this.db.query<{ id: number }>(
      `insert into account (google_sub, email, name) values ($1, $2, $3)
       on conflict (google_sub) do update set email = coalesce(excluded.email, account.email), name = coalesce(excluded.name, account.name)
       returning id`, [who.sub, who.email, who.name])).rows[0]!;
    const token = randomBytes(32).toString('base64url');
    await this.db.query('insert into account_session (token_hash, account_id) values ($1, $2)', [hash(token), id]);
    return { token, accountId: id };
  }

  /** The account a session token belongs to, or null. */
  async fromToken(token: string): Promise<number | null> {
    const row = (await this.db.query<{ account_id: number }>(
      'update account_session set last_used_at = now() where token_hash = $1 returning account_id', [hash(token)])).rows[0];
    return row?.account_id ?? null;
  }

  async signOut(token: string): Promise<void> {
    await this.db.query('delete from account_session where token_hash = $1', [hash(token)]);
  }

  /** Deletes the account and everything saved in it (sessions, favorites). */
  async remove(accountId: number): Promise<void> {
    await this.db.query('delete from account where id = $1', [accountId]);
  }

  async state(accountId: number): Promise<AccountState | null> {
    const account = (await this.db.query<{ name: string | null; email: string | null; nickname: string | null; settings: unknown; updated_at: Date }>(
      'select name, email, nickname, settings, updated_at from account where id = $1', [accountId])).rows[0];
    if (!account) return null;
    const favorites = (await this.db.query<{
      id: number; first_name: string | null; last_name: string; nation: string | null; iso2: string | null; gender: string | null; added_at: Date;
    }>(
      `select s.id, s.first_name, s.last_name, s.nation, n.iso2, s.gender, f.added_at
       from account_favorite f join skater s on s.id = f.skater_id left join nation n on n.code = s.nation
       where f.account_id = $1 order by f.added_at, s.id`, [accountId])).rows;
    return {
      account: { name: account.name, email: account.email, provider: 'google', nickname: account.nickname },
      favorites: favorites.map((f) => ({
        id: f.id, name: f.first_name ? `${f.first_name} ${f.last_name}` : f.last_name, last: f.last_name,
        nat: f.nation, iso2: f.iso2, gender: GENDER[f.gender ?? ''] ?? null, addedAt: f.added_at.toISOString(),
      })),
      settings: cleanSettings(account.settings),
      updatedAt: account.updated_at.toISOString(),
    };
  }

  /** The name on leaderboards (and in chat). 'taken' when someone else has it, ignoring case. */
  async setNickname(accountId: number, nickname: string): Promise<'ok' | 'taken'> {
    try {
      await this.db.query('update account set nickname = $2 where id = $1', [accountId, nickname]);
      return 'ok';
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return 'taken';
      throw err;
    }
  }

  /** Replaces the saved favorites and settings with the phone's. Unknown skaters are left out. */
  async save(accountId: number, favorites: SavedFavorite[], settings: Settings): Promise<void> {
    await this.db.query(
      `with gone as (
         delete from account_favorite where account_id = $1 and not (skater_id = any($2::int[]))),
       kept as (
         insert into account_favorite (account_id, skater_id, added_at)
         select $1, s.id, f.added_at from unnest($2::int[], $3::timestamptz[]) as f(id, added_at) join skater s on s.id = f.id
         on conflict (account_id, skater_id) do update set added_at = excluded.added_at)
       update account set settings = $4, updated_at = now() where id = $1`,
      [accountId, favorites.map((f) => f.id), favorites.map((f) => f.addedAt), settings]);
  }
}
