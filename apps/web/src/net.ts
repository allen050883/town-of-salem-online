import { Client, type Room } from '@colyseus/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action } from '@salem/engine';
import type { ClientSnapshot } from '../../server/src/SalemRoom';

export type { ClientSnapshot };

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:2567`;

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

function playerId(): string {
  let id = storage('salem.playerId');
  if (!id) id = storage('salem.playerId', crypto.randomUUID())!;
  return id;
}

export function useSalem() {
  const [snap, setSnap] = useState<ClientSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  const connect = useCallback(
    async (mode: 'create' | 'join', name: string, code?: string) => {
      setBusy(true);
      setError(null);
      storage('salem.name', name);
      try {
        const client = new Client(SERVER_URL);
        const opts = { playerId: playerId(), name };
        const room = mode === 'create' ? await client.create('salem', opts) : await client.joinById(code!.trim().toUpperCase(), opts);
        attach(room);
      } catch (e) {
        setError(e instanceof Error ? e.message : '無法連線到伺服器');
        if (mode === 'join') storage('salem.room', null);
      } finally {
        setBusy(false);
      }
    },
    [attach],
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
    void roomRef.current?.leave();
    roomRef.current = null;
    setSnap(null);
  }, []);

  const send = useCallback((type: 'start' | 'backToLobby' | 'chat' | 'action', payload?: Action | { text: string }) => {
    setError(null);
    roomRef.current?.send(type, payload);
  }, []);

  const act = useCallback((a: Action) => send('action', a), [send]);

  return { snap, error, busy, connect, leave, send, act, clearError: () => setError(null), savedName: storage('salem.name') ?? '' };
}
