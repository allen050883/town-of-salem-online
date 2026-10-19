import { Client, type Room } from '@colyseus/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action } from '@salem/engine';
import type { ClientSnapshot } from '../../server/src/SalemRoom';

export type { ClientSnapshot };

const WS_URL: string =
  import.meta.env.VITE_SERVER_URL ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:2567`;
/** HTTP address of the same server (for login) */
export const API_URL = WS_URL.replace(/^ws/, 'http');

function storage(key: string, value?: string | null): string | null {
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
  if (provider === 'line') return `${API_URL}/auth/line/login?redirect=${redirect}`;
  return `${API_URL}/auth/dev/login?redirect=${redirect}&name=${encodeURIComponent(name ?? '')}`;
}

export function useAuthConfig() {
  const [config, setConfig] = useState<{ line: boolean; dev: boolean } | null>(null);
  useEffect(() => {
    fetch(`${API_URL}/auth/config`)
      .then((r) => r.json())
      .then(setConfig)
      .catch(() => setConfig({ line: false, dev: false }));
  }, []);
  return config;
}

export function useSalem() {
  const [snap, setSnap] = useState<ClientSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(() => {
    const fromUrl = takeTokenFromUrl();
    if (fromUrl.error) queueMicrotask(() => setError(fromUrl.error!));
    if (fromUrl.token) return storage('salem.token', fromUrl.token);
    const saved = storage('salem.token');
    return saved && decodeToken(saved) ? saved : null;
  });
  const me = token ? decodeToken(token) : null;
  const roomRef = useRef<Room | null>(null);

  const attach = useCallback((room: Room) => {
    roomRef.current = room;
    storage('salem.room', room.roomId);
    room.onMessage('snapshot', (s: ClientSnapshot) => setSnap(s));
    room.onMessage('error', (e: { message: string }) => setError(e.message));
    room.onLeave(() => {
      if (roomRef.current === room) {
        roomRef.current = null;
        setSnap(null);
      }
    });
    room.send('sync');
  }, []);

  const logout = useCallback(() => {
    storage('salem.token', null);
    storage('salem.room', null);
    void roomRef.current?.leave();
    roomRef.current = null;
    setSnap(null);
    setToken(null);
  }, []);

  const connect = useCallback(
    async (mode: 'create' | 'join', code?: string) => {
      if (!token) return setError('請先用 LINE 登入');
      setBusy(true);
      setError(null);
      try {
        const client = new Client(WS_URL);
        const opts = { token };
        const room = mode === 'create' ? await client.create('salem', opts) : await client.joinById(code!.trim().toUpperCase(), opts);
        attach(room);
      } catch (e) {
        const msg = e instanceof Error ? e.message : '無法連線到伺服器';
        setError(msg);
        if (msg.includes('登入')) logout();
        if (mode === 'join') storage('salem.room', null);
      } finally {
        setBusy(false);
      }
    },
    [attach, token, logout],
  );

  // After a refresh, automatically return to the previous room (StrictMode runs this twice; only try once)
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || !token) return;
    autoTried.current = true;
    const code = storage('salem.room');
    if (code) void connect('join', code);
  }, [connect, token]);

  const leave = useCallback(() => {
    storage('salem.room', null);
    void roomRef.current?.leave();
    roomRef.current = null;
    setSnap(null);
  }, []);

  const send = useCallback((type: 'start' | 'backToLobby' | 'chat' | 'action' | 'addBot' | 'removeBot', payload?: Action | { text: string } | { id: string }) => {
    setError(null);
    roomRef.current?.send(type, payload);
  }, []);

  const act = useCallback((a: Action) => send('action', a), [send]);

  return { snap, error, busy, me, connect, leave, logout, send, act };
}
