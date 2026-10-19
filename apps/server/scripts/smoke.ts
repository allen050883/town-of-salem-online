/**
 * End-to-end smoke test: connect N bot clients to a running server, create a room, start a game,
 * and act randomly from each player's snapshot until the game ends.
 * Usage: npm run smoke -w @salem/server (start the server first)
 */
import { Client, type Room } from '@colyseus/sdk';
import { createGame, reduce, type Action, type PlayerView } from '@salem/engine';
import type { ClientSnapshot, ReplayRecord } from '../src/protocol';

const N = Number(process.env.N ?? 5);
const url = process.env.URL ?? 'ws://localhost:2567';
const httpUrl = url.replace(/^ws/, 'http');
const ROLES_ON = process.env.ROLES !== '0';
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;

function botAction(v: PlayerView): Action | null {
  const me = v.players[v.me]!;
  if (!me.alive) return null;
  const alive = v.seats.filter((id) => v.players[id]!.alive);
  const others = alive.filter((id) => id !== v.me);
  const ph = v.phase;
  switch (ph.kind) {
    case 'roles':
      return ph.picked ? null : { type: 'PICK_ROLE', role: pick(ph.offers) };
    case 'arrange':
      return ph.deck ? { type: 'ARRANGE_DECK', order: [...ph.deck].reverse().map((c) => c.id) } : null;
    case 'salvage':
      return ph.cards ? { type: 'SALVAGE', cardIds: ph.cards.slice(0, 3).map((c) => c.id) } : null;
    case 'dawn':
      return ph.mustAct ? { type: 'DAWN_GIVE_CAT', target: pick(alive) } : null;
    case 'turn': {
      if (v.turn.player !== v.me) return null;
      if (v.turn.mode === 'idle' && v.myAbilities.tituba && Math.random() < 0.5) return { type: 'ARRANGE_START' };
      if (v.turn.mode === 'idle' && v.myAbilities.parris && v.discard.length && Math.random() < 0.5) {
        const ids = v.discard.filter((c) => c.type !== 'conspiracy').slice(0, 2).map((c) => c.id);
        if (ids.length) return { type: 'DRAW_DISCARD', cardIds: ids };
      }
      if (v.turn.mode === 'idle' && (v.myHand.length === 0 || Math.random() < 0.4)) return { type: 'DRAW' };
      if (v.turn.mode === 'playing' && (v.myHand.length === 0 || Math.random() < 0.5)) return { type: 'END_TURN' };
      if (v.myHand.length === 0) return { type: 'DRAW' };
      const c = pick(v.myHand);
      const target = pick(others);
      const front = v.players[target]!.front;
      return { type: 'PLAY_CARD', cardId: c.id, target, secondTarget: pick(others), targetCardId: front.length ? pick(front).id : undefined };
    }
    case 'reveal': {
      if (ph.chooser !== v.me) return null;
      return { type: 'CHOOSE_REVEAL', tryalId: pick(v.players[ph.target]!.tryals.filter((t) => !t.revealed)).id };
    }
    case 'night':
      if (!ph.mustAct) return null;
      if (ph.step === 'witches') return { type: 'WITCH_VOTE', target: pick(alive) };
      if (ph.step === 'constable') return { type: 'CONSTABLE_GAVEL', target: pick(others) };
      if (v.myAbilities.phips && Math.random() < 0.3) return { type: 'CONFESS' };
      return Math.random() < 0.1
        ? { type: 'CONFESS', tryalId: pick(me.tryals.filter((t) => !t.revealed)).id }
        : { type: 'NIGHT_PASS' };
    case 'conspiracy':
      if (!ph.mustPick) return null;
      return { type: 'CONSPIRACY_PICK', tryalId: pick(v.players[ph.leftOf]!.tryals.filter((t) => !t.revealed)).id };
    case 'game_over':
      return null;
  }
}

async function main() {
  const rooms: Room[] = [];
  const playerIds: string[] = [];
  let code = '';
  for (let i = 0; i < N; i++) {
    const client = new Client(url);
    const opts = { playerId: `bot-${i}-${Date.now()}`, name: `Bot${i}` };
    playerIds.push(opts.playerId);
    const room = i === 0 ? await client.create('salem', opts) : await client.joinById(code, opts);
    if (i === 0) code = room.roomId;
    rooms.push(room);
  }
  console.log('room code', code);
  rooms[0]!.send('options', { roles: ROLES_ON });

  // A spectator joins and must only ever see the public view
  const spectator = await new Client(url).joinById(code, { playerId: `spec-${Date.now()}`, name: 'Watcher', spectate: true });
  let spectatorLeak = false;
  spectator.onMessage('snapshot', (s: ClientSnapshot) => {
    if (s.seat !== 'spectator') spectatorLeak = true;
    const v = s.view;
    if (v && v.phase.kind !== 'game_over' && Object.values(v.players).some((p) => p.alive && p.tryals.some((t) => !t.revealed && t.kind))) spectatorLeak = true;
  });

  let errors = 0;
  const last: (ClientSnapshot | null)[] = rooms.map(() => null);
  const act = (i: number) => {
    const v = last[i]?.view;
    if (!v || v.phase.kind === 'game_over') return;
    const a = botAction(v);
    if (a) setTimeout(() => rooms[i]!.send('action', a), 5);
  };
  let resolveDone: (s: ClientSnapshot) => void = () => {};
  const done = new Promise<ClientSnapshot>((resolve) => (resolveDone = resolve));
  const wire = (room: Room, i: number) => {
    room.onMessage('error', (e: { message: string }) => {
      errors++;
      if (errors < 5) console.log(`bot${i} error:`, e.message);
      act(i);
    });
    room.onMessage('snapshot', (s: ClientSnapshot) => {
      const v = s.view;
      if (process.env.DEBUG && i === 0) console.log('snap', v?.phase.kind, v?.turn.player, s.log.at(-1)?.text);
      if (!v) return;
      if (v.phase.kind === 'game_over') {
        if (i === 0 && s.lastReplayId) resolveDone(s);
        return;
      }
      last[i] = s;
      act(i);
    });
  };
  rooms.forEach(wire);

  rooms[1]!.send('chat', { text: 'hello from bot1' });
  await new Promise((r) => setTimeout(r, 100));
  rooms[0]!.send('start');

  // Simulate a dropped connection: bot 1 leaves mid-game and rejoins with the same player id
  setTimeout(async () => {
    const id = playerIds[1]!;
    await rooms[1]!.leave();
    const again = await new Client(url).joinById(code, { playerId: id, name: 'Bot1' });
    rooms[1] = again;
    wire(again, 1);
    again.send('sync');
    console.log('bot1 reconnected');
  }, 300);
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('game did not finish within 90s')), 90_000));
  const final = await Promise.race([done, timeout]);
  const ph = final.view!.phase;
  console.log('winner:', ph.kind === 'game_over' && ph.winner, `(log ${final.log.length} entries)`, 'rejected actions:', errors);

  // The finished game is saved and can be fetched for replay
  const res = await fetch(`${httpUrl}/api/replays/${final.lastReplayId}`);
  const replay = (await res.json()) as ReplayRecord;
  console.log('replay', replay.id, 'actions', replay.actions.length, 'chat', replay.chat.length, 'roles', replay.options.roles);
  if (!replay.actions.length || replay.winner !== (ph.kind === 'game_over' && ph.winner)) throw new Error('replay record is incomplete');
  // Replays are deterministic: rerunning the recorded actions reaches the same ending
  let g = createGame(replay.seats, replay.seed, replay.options);
  for (const a of replay.actions) {
    const r = reduce(g, a);
    if (!r.ok) throw new Error(`replay diverged: ${r.error}`);
    g = r.state;
  }
  if (g.phase.kind !== 'game_over' || g.phase.winner !== replay.winner) throw new Error('replay did not reach the same ending');
  if (spectatorLeak) throw new Error('spectator saw hidden information');

  await Promise.all([...rooms, spectator].map((r) => r.leave()));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
