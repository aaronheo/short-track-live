import 'dotenv/config';
import pg from 'pg';

// bigint ids (entry.id) as numbers: we'll never get near 2^53 rows.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) throw new Error('DATABASE_URL is not set (see server/.env.example)');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return new pg.Pool({
    connectionString: url,
    // Supabase requires TLS; its pooler certificate isn't in Node's default store.
    ssl: local ? undefined : { rejectUnauthorized: false },
    max: 5,
  });
}

export type Db = pg.Pool | pg.PoolClient;
