import { Client, type Room } from '@colyseus/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action, GameOptions } from '@salem/engine';
import { CLOSE_REPLACED, type ClientMessages, type ClientSnapshot, type ReplayRecord, type ReplaySummary } from '../../server/src/protocol';

export type { ClientSnapshot };

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:2567`;
const HTTP_URL = SERVER_URL.replace(/^ws/, 'http');

/** Close codes after which the SDK has given up resuming the session */
const CONSENTED = 4000;

export function storage(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private browsing etc.: ignore
  }
  return value ?? null;
}

export interface Me {
  id: string;
  name: string;
  picture?: string;
}

/** Read the profile from the token (display only; the server re-verifies the signature) */
function decodeToken(token: string): (Me & { exp: number }) | null {
  try {
    const body = token.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)));
    const p = JSON.parse(json);
    return p.exp * 1000 > Date.now() ? p : null;
  } catch {
    return null;
  }
}

/** After login, the server redirects back with #token=... or #authError=... */
function takeTokenFromUrl(): { token?: string; error?: string } {
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get('token') ?? undefined;
  const error = hash.get('authError') ?? undefined;
  if (token || error) history.replaceState(null, '', location.pathname + location.search);
  return { token, error };
}

export function loginUrl(provider: 'line' | 'dev', name?: string) {
  const redirect = encodeURIComponent(location.origin + location.pathname);
  if (provider === 'line') return `${HTTP_URL}/auth/line/login?redirect=${redirect}`;
  return `${HTTP_URL}/auth/dev/login?redirect=${redirect}&name=${encodeURIComponent(name ?? '')}`;
}

export function useAuthConfig() {
  const [config, setConfig] = useState<{ line: boolean; dev: boolean } | null>(null);
  useEffect(() => {
    fetch(`${HTTP_URL}/auth/config`)
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig({ line: false, dev: false }));
  }, []);
  return config;
}

export type Connection = 'online' | 'reconnecting' | 'offline';

export type Send = <K extends keyof ClientMessages>(type: K, ...payload: ClientMessages[K] extends undefined ? [] : [ClientMessages[K]]) => void;

export function useSalem() {
  const [snap, setSnap] = useState<ClientSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<Connection>('online');
  const [token, setToken] = useState<string | null>(() => {
    const fromUrl = takeTokenFromUrl();
    if (fromUrl.error) queueMicrotask(() => setError(fromUrl.error!));
    if (fromUrl.token) return storage('salem.token', fromUrl.token);
    const saved = storage('salem.token');
    return saved && decodeToken(saved) ? saved : null;
  });
  const me = token ? decodeToken(token) : null;
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const roomRef = useRef<Room | null>(null);

  const join = useCallback(async (mode: 'create' | 'join', code?: string, spectate = false) => {
    if (!tokenRef.current) throw new Error('請先用 LINE 登入');
    const client = new Client(SERVER_URL);
    const opts = { token: tokenRef.current, spectate };
    return mode === 'create' ? client.create('salem', opts) : client.joinById(code!.trim().toUpperCase(), opts);
  }, []);

  const logout = useCallback(() => {
    storage('salem.token', null);
    storage('salem.room', null);
    const room = roomRef.current;
    roomRef.current = null;
    void room?.leave();
    setSnap(null);
    setToken(null);
  }, []);

  const attach = useCallback((room: Room) => {
    roomRef.current = room;
    storage('salem.room', room.roomId);
    setConnection('online');
    room.onMessage('snapshot', (s: ClientSnapshot) => setSnap(s));
    room.onMessage('error', (e: { message: string }) => setError(e.message));
    // Short drops: the SDK resumes the same session by itself
    room.onDrop(() => roomRef.current === room && setConnection('reconnecting'));
    room.onReconnect(() => {
      if (roomRef.current !== room) return;
      setConnection('online');
      room.send('sync');
    });
    room.onLeave((code) => {
      if (roomRef.current !== room) return;
      roomRef.current = null;
      if (code === CLOSE_REPLACED) {
        setSnap(null);
        setConnection('online');
        setError('你已經在另一個分頁或裝置進入這個房間。');
        return;
      }
      if (code === CONSENTED) {
        setSnap(null);
        return;
      }
      // The SDK gave up: rejoin with our login token (the server keeps the seat)
      void rejoin(room.roomId);
    });
    room.send('sync');
  }, []);

  const rejoin = useCallback(
    async (code: string) => {
      setConnection('reconnecting');
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15_000)));
        try {
          attach(await join('join', code));
          return;
        } catch (e) {
          // The room no longer exists: stop trying
          if (e instanceof Error && /not found|找不到|無法加入/i.test(e.message)) break;
        }
      }
      storage('salem.room', null);
      setSnap(null);
      setConnection('offline');
      setError('和伺服器的連線中斷了，房間可能已經關閉。');
    },
    [attach, join],
  );

  const connect = useCallback(
    /** bots: computer players to seat right away (solo play) */
    async (mode: 'create' | 'join', code?: string, spectate = false, bots = 0) => {
      setBusy(true);
      setError(null);
      try {
        const room = await join(mode, code, spectate);
        attach(room);
        if (bots > 0) room.send('addBots', { count: bots });
      } catch (e) {
        const msg = e instanceof Error ? e.message : '無法連線到伺服器';
        setError(msg);
        // The token was rejected (expired or tampered with): go back to the login screen
        if (msg.includes('登入')) logout();
        if (mode === 'join') storage('salem.room', null);
      } finally {
        setBusy(false);
      }
    },
    [attach, join, logout],
  );

  // After a refresh, automatically return to the previous room (StrictMode runs this twice; only try once)
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current) return;
    autoTried.current = true;
    const code = storage('salem.room');
    if (code && tokenRef.current) void connect('join', code);
  }, [connect]);

  const leave = useCallback(() => {
    storage('salem.room', null);
    const room = roomRef.current;
    roomRef.current = null;
    void room?.leave();
    setSnap(null);
  }, []);

  const send: Send = useCallback((type, ...payload) => {
    setError(null);
    roomRef.current?.send(type, payload[0]);
  }, []);

  const act = useCallback((a: Action) => send('action', a), [send]);
  const setOptions = useCallback((o: Partial<GameOptions>) => send('options', o), [send]);

  return {
    snap,
    error,
    busy,
    connection,
    me,
    connect,
    leave,
    logout,
    send,
    act,
    setOptions,
    clearError: () => setError(null),
  };
}

export type Salem = ReturnType<typeof useSalem>;

export async function fetchReplay(id: string): Promise<ReplayRecord> {
  const res = await fetch(`${HTTP_URL}/api/replays/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('找不到這場對戰紀錄');
  return (await res.json()) as ReplayRecord;
}

export async function fetchReplayList(): Promise<ReplaySummary[]> {
  const res = await fetch(`${HTTP_URL}/api/replays`);
  if (!res.ok) throw new Error('無法取得對戰紀錄');
  return (await res.json()) as ReplaySummary[];
}
