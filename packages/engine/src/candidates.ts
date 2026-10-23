import { ACCUSATION_VALUE, CARD_COLOR, CARD_NAME, isDisabledInEndgame, isRed } from './cards';
import { CARD_WORTH } from './bot';
import type { PlayerView } from './projection';
import type { Action, Card, PlayerId, TryalKind } from './types';

/** One choice offered to an AI player: the action, and how to describe it to the model */
export interface Candidate {
  action: Action;
  label: string;
}

/** Longest list offered at once; a long menu makes a model choose worse */
export const MAX_CANDIDATES = 40;

const TRYAL_NAME: Record<TryalKind, string> = { witch: '女巫', constable: '警長', not_a_witch: '平民' };

/**
 * The strategic choices open to this player right now, for an AI to pick from: the cards and targets of a turn,
 * the black cat, the Witches' vote, the gavel and confessing. Other decisions (roles, reveals, Tituba, Proctor, Parris)
 * return an empty list and stay with the built-in bot. Built only from the player's own view, so it never reveals
 * more than the seat can see; a few entries may still be refused by the engine, so callers validate with `reduce`.
 */
export function candidateActions(v: PlayerView): Candidate[] {
  const me = v.players[v.me];
  if (!me?.alive || v.spectator) return [];
  const name = (id: PlayerId) => v.players[id]!.name;
  const alive = v.seats.filter((id) => v.players[id]!.alive);
  const others = alive.filter((id) => id !== v.me);
  const ph = v.phase;

  switch (ph.kind) {
    case 'dawn':
      if (!ph.mustAct) return [];
      return alive.map((id) => ({
        action: { type: 'DAWN_GIVE_CAT', target: id },
        label: `把黑貓放到 ${id === v.me ? '你自己' : name(id)} 面前`,
      }));
    case 'night':
      if (!ph.mustAct) return [];
      if (ph.step === 'witches') {
        return alive.map((id) => ({ action: { type: 'WITCH_VOTE', target: id }, label: `今晚殺 ${id === v.me ? '你自己' : name(id)}` }));
      }
      if (ph.step === 'constable') {
        return others.map((id) => ({ action: { type: 'CONSTABLE_GAVEL', target: id }, label: `保護 ${name(id)}（他今晚不會被女巫殺死）` }));
      }
      return confessChoices(v);
    case 'turn': {
      if (v.turn.player !== v.me || v.turn.mode === 'drawing') return [];
      const first: Candidate =
        v.turn.mode === 'idle'
          ? { action: { type: 'DRAW' }, label: '抽兩張牌（這回合就不能再出牌）' }
          : { action: { type: 'END_TURN' }, label: '結束回合' };
      const abilities = v.turn.mode === 'idle' ? abilityChoices(v, others.length + 1) : [];
      return [first, ...abilities, ...playChoices(v, others)].slice(0, MAX_CANDIDATES);
    }
    default:
      return [];
  }
}

/**
 * The character abilities that replace drawing: Samuel Parris takes cards from the discard pile (twice per game) and Tituba
 * rearranges the deck before drawing (once). Without these on the menu the model could never use them.
 */
function abilityChoices(v: PlayerView, alive: number): Candidate[] {
  const out: Candidate[] = [];
  const parris = v.myAbilities.parris ?? 0;
  if (parris > 0) {
    const usable = v.discard
      .filter((c) => CARD_COLOR[c.type] !== 'black' && !(alive === 2 && isDisabledInEndgame(c.type)))
      .sort((a, b) => (CARD_WORTH[b.type] ?? 0) - (CARD_WORTH[a.type] ?? 0));
    const names = (cs: typeof usable) => cs.map((c) => `「${CARD_NAME[c.type]}」`).join('');
    if (usable.length >= 2) {
      out.push({ action: { type: 'DRAW_DISCARD', cardIds: usable.slice(0, 2).map((c) => c.id) }, label: `從棄牌堆拿 ${names(usable.slice(0, 2))}（取代抽牌，還剩 ${parris} 次）` });
    }
    if (usable.length >= 1) {
      out.push({ action: { type: 'DRAW_DISCARD', cardIds: [usable[0]!.id] }, label: `從棄牌堆拿 ${names(usable.slice(0, 1))}（取代抽牌，還剩 ${parris} 次）` });
    }
  }
  if ((v.myAbilities.tituba ?? 0) > 0 && v.deckCount > 3) {
    out.push({ action: { type: 'ARRANGE_START' }, label: '查看並重排牌堆（說書人能力，全場一次；排好後接著抽兩張牌）' });
  }
  return out;
}

function confessChoices(v: PlayerView): Candidate[] {
  const out: Candidate[] = [{ action: { type: 'NIGHT_PASS' }, label: '不自首' }];
  for (const t of v.players[v.me]!.tryals) {
    if (t.revealed || !t.kind) continue;
    out.push({ action: { type: 'CONFESS', tryalId: t.id }, label: `自首：翻開自己一張「${TRYAL_NAME[t.kind]}」審判牌，換取今晚免死` });
  }
  if (v.myAbilities.phips) out.push({ action: { type: 'CONFESS' }, label: '自首但不翻牌（官員能力，全場一次）' });
  return out;
}

function playChoices(v: PlayerView, others: PlayerId[]): Candidate[] {
  const out: Candidate[] = [];
  const endgame = others.length === 1;
  const p = (id: PlayerId) => v.players[id]!;
  const name = (id: PlayerId) => p(id).name;
  const hasFront = (id: PlayerId, type: Card['type']) => p(id).front.some((c) => c.type === type);
  const role = (id: PlayerId) => p(id).effectiveRole;
  const meGriggs = role(v.me) === 'griggs';
  // One entry per card type is enough: two Accusations in hand are the same choice
  const seen = new Set<string>();

  for (const c of v.myHand) {
    const t = c.type;
    if (CARD_COLOR[t] === 'black' || (endgame && isDisabledInEndgame(t)) || seen.has(t)) continue;
    seen.add(t);
    const card = `「${CARD_NAME[t]}」`;
    const play = (target: PlayerId, label: string, extra: Partial<Extract<Action, { type: 'PLAY_CARD' }>> = {}) =>
      out.push({ action: { type: 'PLAY_CARD', cardId: c.id, target, ...extra }, label });
    const points = (id: PlayerId) => `${p(id).accusations}/${p(id).threshold} 點`;

    if (isRed(t) || (t === 'alibi' && meGriggs)) {
      const value = isRed(t) ? ACCUSATION_VALUE[t]! : 7;
      for (const id of others) {
        if (hasFront(id, 'piety') || !p(id).tryals.some((x) => !x.revealed)) continue;
        if (isRed(t)) play(id, `對 ${name(id)} 打出${card}（+${value} 點，他目前 ${points(id)}）`);
        else play(id, `把${card}當作「目擊」打給 ${name(id)}（+7 點，他目前 ${points(id)}）`, { asWitness: true });
      }
      if (isRed(t)) continue;
    }

    switch (t) {
      case 'alibi':
        for (const id of others) {
          if (p(id).front.some((x) => x.type === 'accusation' || x.type === 'evidence')) {
            play(id, `對 ${name(id)} 打出${card}，移除他最多 3 點指控（他目前 ${points(id)}）`);
          }
        }
        break;
      case 'arson':
        for (const id of others) {
          if (role(id) !== 'sarah' && p(id).handCount > 0) play(id, `對 ${name(id)} 打出${card}，燒掉他 ${p(id).handCount} 張手牌`);
        }
        break;
      case 'robbery':
        for (const from of others) {
          if (role(from) === 'sarah' || p(from).handCount === 0) continue;
          for (const to of others) {
            if (to !== from) play(from, `${card}：把 ${name(from)} 的 ${p(from).handCount} 張手牌全部交給 ${name(to)}`, { secondTarget: to });
          }
        }
        break;
      case 'scapegoat':
        for (const from of others) {
          const moving = p(from).front.filter((x) => CARD_COLOR[x.type] !== 'black');
          if (moving.length === 0) continue;
          for (const to of others) {
            if (to !== from) {
              play(from, `${card}：把 ${name(from)} 面前的 ${moving.length} 張牌（${points(from)}）全部轉給 ${name(to)}`, { secondTarget: to });
            }
          }
        }
        break;
      case 'curse':
        for (const id of others) {
          for (const b of p(id).front) {
            if (CARD_COLOR[b.type] === 'blue') play(id, `對 ${name(id)} 打出${card}，棄掉他面前的「${CARD_NAME[b.type]}」`, { targetCardId: b.id });
          }
        }
        break;
      case 'stocks':
      case 'matchmaker':
      case 'asylum':
      case 'piety':
        for (const id of others) {
          if (!hasFront(id, t)) play(id, `對 ${name(id)} 打出${card}`);
        }
        break;
    }
  }
  // Robbery and Scapegoat list every pair of players; put them last so they never crowd simpler plays off the menu
  const pair = (c: Candidate) => c.action.type === 'PLAY_CARD' && !!c.action.secondTarget;
  return [...out.filter((c) => !pair(c)), ...out.filter(pair)];
}
