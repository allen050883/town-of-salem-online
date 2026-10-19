/**
 * End-to-end smoke test: connect N bot clients to a running server, create a room, start a game,
 * and act randomly from each player's snapshot until the game ends.
 * Usage: npm run smoke -w @salem/server (start the server first)
 */
import { Client, type Room } from '@colyseus/sdk';
import type { Action, PlayerView } from '@salem/engine';
import type { ClientSnapshot } from '../src/SalemRoom';

const N = Number(process.env.N ?? 5);
const url = process.env.URL ?? 'ws://localhost:2567';
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]!;

function botAction(v: PlayerView): Action | null {
  const me = v.players[v.me]!;
  if (!me.alive) return null;
  const alive = v.seats.filter((id) => v.players[id]!.alive);
  const others = alive.filter((id) => id !== v.me);
  const ph = v.phase;
  switch (ph.kind) {
    case 'dawn':
      return ph.mustAct ? { type: 'DAWN_GIVE_CAT', target: pick(alive) } : null;
    case 'turn': {
      if (v.turn.player !== v.me) return null;
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
  let code = '';
  for (let i = 0; i < N; i++) {
    const client = new Client(url);
    const opts = { playerId: `bot-${i}-${Date.now()}`, name: `Bot${i}` };
    const room = i === 0 ? await client.create('salem', opts) : await client.joinById(code, opts);
    if (i === 0) code = room.roomId;
    rooms.push(room);
  }
  console.log('room code', code);

  let errors = 0;
  const last: (ClientSnapshot | null)[] = rooms.map(() => null);
  const act = (i: number) => {
    const v = last[i]?.view;
    if (!v || v.phase.kind === 'game_over') return;
    const a = botAction(v);
    if (a) setTimeout(() => rooms[i]!.send('action', a), 5);
  };
  const done = new Promise<string>((resolve) => {
    rooms.forEach((room, i) => {
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
          if (i === 0) resolve(`${v.phase.winner} (log ${s.log.length} entries)`);
          return;
        }
        last[i] = s;
        act(i);
      });
    });
  });

  rooms[1]!.send('chat', { text: 'hello from bot1' });
  rooms[0]!.send('start');
  const timeout = new Promise<string>((_, rej) => setTimeout(() => rej(new Error('game did not finish within 60s')), 60_000));
  const winner = await Promise.race([done, timeout]);
  console.log('winner:', winner, 'rejected actions:', errors);
  await Promise.all(rooms.map((r) => r.leave()));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
