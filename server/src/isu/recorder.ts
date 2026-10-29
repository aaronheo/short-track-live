import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type pg from 'pg';

const zip = promisify(gzip);

export interface IsuResponse { key: string; method: string; path: string; body: string | undefined; json: unknown }

/**
 * Keeps ISU's responses during live events (table isu_recording), for playing
 * an event back later. A response is stored only when it differs from the last
 * one for the same request. Never throws: a failed write is logged and skipped.
 */
export class IsuRecorder {
  private last = new Map<string, string>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly log: (msg: string) => void = (m) => console.log(`[record] ${m}`),
  ) {}

  async save(r: IsuResponse): Promise<void> {
    try {
      const text = JSON.stringify(r.json);
      const hash = createHash('sha1').update(text).digest('hex');
      let prev = this.last.get(r.key);
      if (prev === undefined) {
        const res = await this.pool.query<{ hash: string }>(
          'select hash from isu_recording where key = $1 order by id desc limit 1', [r.key]);
        prev = res.rows[0]?.hash;
      }
      if (prev === hash) return;
      await this.pool.query(
        'insert into isu_recording (key, method, path, body, hash, data) values ($1, $2, $3, $4, $5, $6)',
        [r.key, r.method, r.path, r.body ?? null, hash, await zip(text)]);
      this.last.set(r.key, hash);
    } catch (err) {
      this.log(`${r.method} ${r.path}: not recorded, ${(err as Error).message}`);
    }
  }
}
