import 'dotenv/config';
import dns from 'node:dns';
import pg from 'pg';

// bigint ids (entry.id) as numbers: we'll never get near 2^53 rows.
pg.types.setTypeParser(20, (v) => Number(v));

// The Supabase pooler has IPv6 addresses too; on networks without IPv6 a
// connection that picks one fails with EHOSTUNREACH.
dns.setDefaultResultOrder('ipv4first');

export function createPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) throw new Error('DATABASE_URL is not set (see server/.env.example)');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    // Supabase requires TLS; its pooler certificate isn't in Node's default store.
    ssl: local ? undefined : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    keepAlive: true, // notice a connection that died quietly instead of waiting on it forever
  });
  // Supabase drops idle connections now and then. The pool replaces them;
  // without this listener the error would crash the process.
  pool.on('error', (err) => console.warn(`[db] idle connection dropped: ${err.message}`));
  return pool;
}

export type Db = pg.Pool | pg.PoolClient;
