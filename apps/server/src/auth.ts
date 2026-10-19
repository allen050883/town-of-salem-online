import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Application, Request, Response } from 'express';

/** Logged-in user; id is namespaced by source (line:Uxxxx / dev:xxx) */
export interface AuthUser {
  id: string;
  name: string;
  picture?: string;
}

interface TokenPayload extends AuthUser {
  exp: number;
}

const env = process.env;
const LINE_CHANNEL_ID = env.LINE_CHANNEL_ID ?? '';
const LINE_CHANNEL_SECRET = env.LINE_CHANNEL_SECRET ?? '';
const PUBLIC_URL = (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 2567}`).replace(/\/$/, '');
const LINE_CALLBACK_URL = `${PUBLIC_URL}/auth/line/callback`;
/** Frontend URLs allowed as post-login redirect targets (prevents open redirects) */
const WEB_ORIGINS = (env.WEB_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);
/** Local-dev test login: lets you open several windows with different identities; never enable in production */
const DEV_LOGIN = env.AUTH_DEV_LOGIN === '1';
const TOKEN_TTL_SECONDS = 30 * 24 * 3600;

const lineEnabled = Boolean(LINE_CHANNEL_ID && LINE_CHANNEL_SECRET);

function loadSecret(): string {
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  if (env.NODE_ENV === 'production') throw new Error('AUTH_SECRET must be set in production');
  console.warn('[auth] AUTH_SECRET is not set; using a temporary key (everyone must log in again after a restart)');
  return randomBytes(32).toString('hex');
}
const SECRET = loadSecret();

if (DEV_LOGIN && env.NODE_ENV === 'production') throw new Error('AUTH_DEV_LOGIN cannot be enabled in production');
if (!lineEnabled) console.warn('[auth] LINE_CHANNEL_ID / LINE_CHANNEL_SECRET not set; LINE login is disabled');

// ---------- Session token (HMAC-signed, same idea as a JWT but with no extra dependency) ----------

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

function sign(data: string) {
  return createHmac('sha256', SECRET).update(data).digest('base64url');
}

export function issueToken(user: AuthUser): string {
  const payload: TokenPayload = { ...user, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: unknown): AuthUser | null {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    if (p.exp < Date.now() / 1000) return null;
    return { id: p.id, name: p.name, picture: p.picture };
  } catch {
    return null;
  }
}

// ---------- Routes ----------

/** OAuth state → { nonce, redirect }, valid for 10 minutes */
const pending = new Map<string, { nonce: string; redirect: string; expires: number }>();

function safeRedirect(raw: unknown): string | null {
  if (typeof raw !== 'string') return WEB_ORIGINS[0] ?? null;
  try {
    const u = new URL(raw);
    return WEB_ORIGINS.includes(u.origin) ? `${u.origin}${u.pathname}` : null;
  } catch {
    return null;
  }
}

function finish(res: Response, redirect: string, user: AuthUser) {
  // Put the token in the fragment so it doesn't land in server or proxy logs
  res.redirect(`${redirect}#token=${encodeURIComponent(issueToken(user))}`);
}

function fail(res: Response, redirect: string | null, message: string) {
  if (redirect) res.redirect(`${redirect}#authError=${encodeURIComponent(message)}`);
  else res.status(400).send(message);
}

export function mountAuthRoutes(app: Application) {
  app.use('/auth', (req, res, next) => {
    // The frontend and API are on different origins (different ports/subdomains); allow only listed frontends to read /auth/config
    const origin = req.headers.origin;
    if (origin && WEB_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    next();
  });

  app.get('/auth/config', (_req, res) => {
    res.json({ line: lineEnabled, dev: DEV_LOGIN });
  });

  app.get('/auth/line/login', (req: Request, res: Response) => {
    const redirect = safeRedirect(req.query.redirect);
    if (!redirect) return fail(res, null, '不允許的登入返回網址');
    if (!lineEnabled) return fail(res, redirect, '伺服器尚未設定 LINE 登入');
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    pending.set(state, { nonce, redirect, expires: now + 10 * 60_000 });
    const url = new URL('https://access.line.me/oauth2/v2.1/authorize');
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: LINE_CHANNEL_ID,
      redirect_uri: LINE_CALLBACK_URL,
      state,
      scope: 'profile openid',
      nonce,
    }).toString();
    res.redirect(url.toString());
  });

  app.get('/auth/line/callback', async (req: Request, res: Response) => {
    const state = String(req.query.state ?? '');
    const entry = pending.get(state);
    pending.delete(state);
    if (!entry || entry.expires < Date.now()) return fail(res, WEB_ORIGINS[0] ?? null, '登入逾時，請再試一次');
    if (req.query.error) return fail(res, entry.redirect, '你取消了 LINE 登入');
    const code = String(req.query.code ?? '');

    try {
      const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: LINE_CALLBACK_URL,
          client_id: LINE_CHANNEL_ID,
          client_secret: LINE_CHANNEL_SECRET,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
      const { id_token } = (await tokenRes.json()) as { id_token?: string };
      if (!id_token) throw new Error('missing id_token');

      // Have LINE verify the ID token (signature, aud, exp, nonce)
      const verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token, client_id: LINE_CHANNEL_ID, nonce: entry.nonce }),
      });
      if (!verifyRes.ok) throw new Error(`verify ${verifyRes.status}`);
      const claims = (await verifyRes.json()) as { sub: string; name?: string; picture?: string };

      finish(res, entry.redirect, { id: `line:${claims.sub}`, name: (claims.name ?? 'LINE 使用者').slice(0, 16), picture: claims.picture });
    } catch (e) {
      console.error('[auth] LINE login failed', e);
      fail(res, entry.redirect, 'LINE 登入失敗，請再試一次');
    }
  });

  if (DEV_LOGIN) {
    console.warn('[auth] AUTH_DEV_LOGIN=1: local test login is enabled (for development only)');
    // With redirect: return to the frontend like LINE does; without: return JSON (for the smoke script)
    app.get('/auth/dev/login', (req: Request, res: Response) => {
      const name = String(req.query.name ?? '').trim().slice(0, 16);
      if (!name) return res.status(400).send('需要 name');
      const user: AuthUser = { id: `dev:${name}`, name };
      if (req.query.redirect === undefined) return res.json({ token: issueToken(user) });
      const redirect = safeRedirect(req.query.redirect);
      if (!redirect) return fail(res, null, '不允許的登入返回網址');
      finish(res, redirect, user);
    });
  }
}
