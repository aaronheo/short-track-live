// Apple Push Notification service: HTTP/2 to Apple, authenticated with a
// token signed by our APNs key (.p8). Debug builds register with the sandbox,
// TestFlight and release builds with production.

import http2 from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';

export type ApnsEnvironment = 'sandbox' | 'production';
export type PushType = 'alert' | 'liveactivity';
/** gone: Apple says the token is no longer valid; forget the device. */
export type SendResult = 'ok' | 'gone' | 'error';

export interface ApnsConfig {
  key: string; // the .p8 file's contents
  keyId: string;
  teamId: string;
  topic: string; // the app's bundle id
}

export interface PushMessage {
  payload: object;
  pushType?: PushType;
  /** Replaces an earlier notification with the same id. */
  collapseId?: string;
  /** Live Activities' topic gets a suffix. */
  topicSuffix?: string;
  priority?: 5 | 10;
}

export interface PushSender {
  send(token: string, environment: ApnsEnvironment, message: PushMessage): Promise<SendResult>;
}

const HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};
/** Apple wants a fresh token at least hourly and no more than every 20 minutes. */
const TOKEN_FOR_MS = 40 * 60_000;

/** From APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID (APNS_TOPIC defaults to the bundle id); null when unset. */
export function apnsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ApnsConfig | null {
  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) return null;
  return {
    // Render keeps newlines, but a pasted one-line key has literal \n.
    key: env.APNS_KEY.replace(/\\n/g, '\n'),
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    topic: env.APNS_TOPIC ?? 'com.aaronheo.shorttracklive',
  };
}

export class Apns implements PushSender {
  private jwt: { value: string; at: number } | null = null;
  private sessions = new Map<ApnsEnvironment, http2.ClientHttp2Session>();

  constructor(private readonly config: ApnsConfig, private readonly log: (msg: string) => void = (m) => console.log(`[push] ${m}`)) {}

  async send(token: string, environment: ApnsEnvironment, message: PushMessage): Promise<SendResult> {
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${await this.token()}`,
      'apns-topic': this.config.topic + (message.topicSuffix ?? ''),
      'apns-push-type': message.pushType ?? 'alert',
      'apns-priority': String(message.priority ?? 10),
      'content-type': 'application/json',
    };
    if (message.collapseId) headers['apns-collapse-id'] = message.collapseId;
    try {
      const { status, body } = await this.request(environment, headers, JSON.stringify(message.payload));
      if (status === 200) return 'ok';
      const reason = (() => { try { return (JSON.parse(body) as { reason?: string }).reason ?? body; } catch { return body; } })();
      if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') return 'gone';
      if (reason === 'ExpiredProviderToken') this.jwt = null;
      this.log(`APNs ${status} ${reason} (${environment})`);
      return 'error';
    } catch (err) {
      this.log(`APNs request failed: ${(err as Error).message}`);
      this.sessions.get(environment)?.destroy();
      this.sessions.delete(environment);
      return 'error';
    }
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  private async token(): Promise<string> {
    if (this.jwt && Date.now() - this.jwt.at < TOKEN_FOR_MS) return this.jwt.value;
    const key = await importPKCS8(this.config.key, 'ES256');
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setIssuedAt()
      .sign(key);
    this.jwt = { value, at: Date.now() };
    return value;
  }

  private session(environment: ApnsEnvironment): http2.ClientHttp2Session {
    const open = this.sessions.get(environment);
    if (open && !open.closed && !open.destroyed) return open;
    const session = http2.connect(HOSTS[environment]);
    session.on('error', () => { this.sessions.delete(environment); });
    session.on('close', () => { if (this.sessions.get(environment) === session) this.sessions.delete(environment); });
    // Don't keep the process alive for an idle connection.
    session.unref();
    this.sessions.set(environment, session);
    return session;
  }

  private request(environment: ApnsEnvironment, headers: http2.OutgoingHttpHeaders, body: string) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = this.session(environment).request(headers);
      let status = 0;
      let text = '';
      req.setEncoding('utf8');
      req.setTimeout(15_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
      req.on('response', (h) => { status = Number(h[':status']); });
      req.on('data', (chunk: string) => { text += chunk; });
      req.on('end', () => resolve({ status, body: text }));
      req.on('error', reject);
      // A timed-out or reset stream closes without 'end'.
      req.on('close', () => reject(new Error(status ? 'stream closed' : 'no response')));
      req.end(body);
    });
  }
}
