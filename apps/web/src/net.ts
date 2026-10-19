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

function playerId(): string {
  let id = storage('salem.playerId');
  if (!id) id = storage('salem.playerId', crypto.randomUUID())!;
  return id;
}

export type Connection = 'online' | 'reconnecting' | 'offline';

export type Send = <K extends keyof ClientMessages>(type: K, ...payload: ClientMessages[K] extends undefined ? [] : [ClientMessages[K]]) => void;

export function useSalem() {
  const [snap, setSnap] = useState<ClientSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<Connection>('online');
  const roomRef = useRef<Room | null>(null);
  /** Listeners for relayed WebRTC signals (voice chat) */
  const rtcListeners = useRef(new Set<(m: unknown) => void>());

  const join = useCallback(async (mode: 'create' | 'join', name: string, code?: string, spectate = false) => {
    const client = new Client(SERVER_URL);
    const opts = { playerId: playerId(), name, spectate };
    return mode === 'create' ? client.create('salem', opts) : client.joinById(code!.trim().toUpperCase(), opts);
  }, []);

  const attach = useCallback((room: Room) => {
    roomRef.current = room;
    storage('salem.room', room.roomId);
    setConnection('online');
    room.onMessage('snapshot', (s: ClientSnapshot) => setSnap(s));
    room.onMessage('error', (e: { message: string }) => setError(e.message));
    room.onMessage('rtc', (m: unknown) => rtcListeners.current.forEach((fn) => fn(m)));
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
      // The SDK gave up: rejoin with our player id (the server keeps the seat)
      void rejoin(room.roomId);
    });
    room.send('sync');
  }, []);

  const rejoin = useCallback(
    async (code: string) => {
      setConnection('reconnecting');
      const name = storage('salem.name') ?? '';
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15_000)));
        try {
          attach(await join('join', name, code));
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
    async (mode: 'create' | 'join', name: string, code?: string, spectate = false, bots = 0) => {
      setBusy(true);
      setError(null);
      storage('salem.name', name);
      try {
        const room = await join(mode, name, code, spectate);
        attach(room);
        if (bots > 0) room.send('addBots', { count: bots });
      } catch (e) {
        setError(e instanceof Error ? e.message : '無法連線到伺服器');
        if (mode === 'join') storage('salem.room', null);
      } finally {
        setBusy(false);
      }
    },
    [attach, join],
  );

  // After a refresh, automatically return to the previous room (StrictMode runs this twice; only try once)
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current) return;
    autoTried.current = true;
    const code = storage('salem.room');
    const name = storage('salem.name');
    if (code && name) void connect('join', name, code);
  }, [connect]);

  const leave = useCallback(() => {
    storage('salem.room', null);
    const room = roomRef.current;
    roomRef.current = null;
    void room?.leave();
    setSnap(null);
  }, []);

  const send: Send = useCallback((type, ...payload) => {
    if (type !== 'rtc') setError(null);
    roomRef.current?.send(type, payload[0]);
  }, []);

  const act = useCallback((a: Action) => send('action', a), [send]);
  const setOptions = useCallback((o: Partial<GameOptions>) => send('options', o), [send]);

  const onRtc = useCallback((fn: (m: unknown) => void) => {
    rtcListeners.current.add(fn);
    return () => void rtcListeners.current.delete(fn);
  }, []);

  return {
    snap,
    error,
    busy,
    connection,
    connect,
    leave,
    send,
    act,
    setOptions,
    onRtc,
    clearError: () => setError(null),
    savedName: storage('salem.name') ?? '',
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
