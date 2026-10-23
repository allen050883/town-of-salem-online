import { describe, expect, it } from 'vitest';
import { Rng } from '../src/rng';
import { MAX_CANDIDATES, botAction, candidateActions, createGame, projectFor, reduce, waitingOn } from '../src';
import type { GameState } from '../src';
import { NAMES, card, scenario } from './helpers';

/** Play bot games and check the AI menu at every decision along the way */
function survey(n: number, seed: number, roles: boolean) {
  const rng = new Rng(seed * 17);
  const rand = () => rng.next();
  let s: GameState = createGame(
    NAMES.slice(0, n).map((id) => ({ id, name: id })),
    seed,
    { roles, extraWitch: false },
  );
  let offered = 0;
  let refused = 0;
  const problems: string[] = [];
  for (let i = 0; i < 4000 && s.phase.kind !== 'game_over'; i++) {
    let moved = false;
    for (const pid of waitingOn(s)) {
      const v = projectFor(s, pid);
      const menu = candidateActions(v);
      expect(menu.length).toBeLessThanOrEqual(MAX_CANDIDATES);
      for (const c of menu) {
        offered++;
        if (!reduce(s, { actor: pid, action: c.action }).ok) refused++;
      }
      const ph = v.phase;
      if (ph.kind === 'turn' && v.turn.player === pid && v.turn.mode === 'idle' && !menu.some((c) => c.action.type === 'DRAW')) {
        problems.push(`${pid}: idle turn without DRAW`);
      }
      if ((ph.kind === 'dawn' || ph.kind === 'night') && ph.mustAct && menu.length === 0) problems.push(`${pid}: empty menu in ${ph.kind}`);

      const a = botAction(v, rand);
      if (!a) continue;
      const r = reduce(s, { actor: pid, action: a });
      if (r.ok) {
        s = r.state;
        moved = true;
        break;
      }
    }
    if (!moved) s = (reduce(s, { actor: 'system', action: { type: 'TIMEOUT' } }) as { state: GameState }).state;
  }
  return { offered, refused, problems };
}

describe('candidateActions', () => {
  it('offers legal choices at every strategic decision', () => {
    let offered = 0;
    let refused = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const r = survey(4 + (seed % 7), seed, seed % 2 === 0);
      expect(r.problems).toEqual([]);
      offered += r.offered;
      refused += r.refused;
    }
    console.log(`candidates: ${offered} offered, ${refused} refused`);
    expect(offered).toBeGreaterThan(500);
    // The server filters refused entries with reduce; they should be rare
    expect(refused / offered).toBeLessThan(0.05);
  }, 60_000);

  it('puts the Parris and Tituba abilities on the menu, and only while they are usable', () => {
    const s = scenario();
    s.players.A!.role = 'parris';
    s.discard = [card('alibi'), card('witness'), card('evidence'), card('conspiracy')];
    const menu = candidateActions(projectFor(s, 'A'));
    const take = menu.filter((c) => c.action.type === 'DRAW_DISCARD');
    expect(take.length).toBe(2);
    // The best cards first (witness, evidence), never the black card
    expect(take[0]!.label).toContain('目擊');
    expect(take[0]!.label).not.toContain('傳染');
    for (const c of take) expect(reduce(s, { actor: 'A', action: c.action }).ok).toBe(true);

    const t = scenario();
    t.players.A!.role = 'tituba';
    t.deck = [card('arson'), card('alibi'), card('accusation'), card('evidence'), card('night')];
    const arrange = candidateActions(projectFor(t, 'A')).find((c) => c.action.type === 'ARRANGE_START');
    expect(arrange).toBeTruthy();
    expect(reduce(t, { actor: 'A', action: arrange!.action }).ok).toBe(true);
    // Once used, no longer offered
    const used = reduce(t, { actor: 'A', action: { type: 'ARRANGE_START' } });
    if (!used.ok) throw new Error(used.error);
    expect(candidateActions(projectFor(used.state, 'A')).some((c) => c.action.type === 'ARRANGE_START')).toBe(false);
  });

  it('is empty when nothing strategic is asked of the player', () => {
    const s = createGame(
      NAMES.slice(0, 5).map((id) => ({ id, name: id })),
      3,
      { roles: true, extraWitch: false },
    );
    expect(s.phase.kind).toBe('roles');
    for (const id of s.seats) expect(candidateActions(projectFor(s, id))).toEqual([]);
  });
});
