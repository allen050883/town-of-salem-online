/**
 * AI self-play: computer players play whole games against each other through the engine (no server, no pauses),
 * using the same Ollama prompt as the live game. Every decision and the model's reason are written out for review.
 *
 * Usage (OLLAMA_URL / OLLAMA_MODEL as for the server):
 *   OLLAMA_URL=... OLLAMA_MODEL=... OLLAMA_THINK=low OLLAMA_TIMEOUT_MS=15000 \
 *   GAMES=10 N=5 OUT=<dir> npx tsx scripts/ai-selfplay.ts
 * Writes <OUT>/decisions.jsonl, <OUT>/games.jsonl and one readable log per game.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROLES,
  botAction,
  candidateActions,
  createGame,
  projectFor,
  reduce,
  waitingOn,
  type Action,
  type GameState,
  type PlayerId,
} from '@salem/engine';
import { aiChoose, aiEnabled, type Play } from '../src/aiBot';

const GAMES = Number(process.env.GAMES ?? 10);
const N = Number(process.env.N ?? 5);
const OUT = process.env.OUT ?? 'ai-selfplay-out';
const NAMES = ['Bridget', 'Susannah', 'Elizabeth', 'Margaret', 'Wilmot', 'Lydia', 'Dorcas', 'Alice', 'Mary', 'Samuel', 'Roger', 'Ann'];

if (!aiEnabled()) {
  console.error('Set OLLAMA_URL and OLLAMA_MODEL');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const isWitch = (s: GameState, id: PlayerId) => s.players[id]!.tryals.some((t) => t.kind === 'witch');
const team = (s: GameState, id: PlayerId) => (isWitch(s, id) ? 'witch' : s.players[id]!.tryals.some((t) => t.kind === 'constable') ? 'constable' : 'town');
const targetOf = (a: Action) => ('target' in a ? a.target : undefined);

async function playGame(g: number) {
  const seed = 1000 + g;
  const seats = NAMES.slice(0, N).map((name) => ({ id: name, name }));
  let s = createGame(seats, seed, { roles: true, extraWitch: false });
  const events: { text: string; to?: PlayerId[] }[] = [];
  const plays: Play[] = [];
  const started = Date.now();
  let step = 0;
  let aiCount = 0;
  let fallbacks = 0;
  let msTotal = 0;

  const apply = (actor: PlayerId | 'system', action: Action) => {
    const card = action.type === 'PLAY_CARD' && actor !== 'system' ? s.players[actor]!.hand.find((c) => c.id === action.cardId) : undefined;
    const r = reduce(s, { actor, action });
    if (!r.ok) return false;
    s = r.state;
    for (const e of r.events) events.push({ text: e.text, to: e.visibleTo });
    if (card && action.type === 'PLAY_CARD' && actor !== 'system') {
      plays.push({ actor, type: card.type, target: action.target, second: action.secondTarget, asWitness: action.asWitness });
    }
    return true;
  };

  while (s.phase.kind !== 'game_over' && step < 3000) {
    step++;
    let moved = false;
    for (const id of waitingOn(s)) {
      const view = projectFor(s, id);
      const before = s;
      const menu = candidateActions(view).filter((c) => reduce(before, { actor: id, action: c.action }).ok);
      let action: Action | null = null;
      let source = 'rule';
      let reason = '';
      let ms = 0;
      if (menu.length > 1) {
        const history = events.filter((e) => !e.to || e.to.includes(id)).map((e) => e.text);
        const answer = await aiChoose(view, history, plays, menu);
        if (answer) {
          action = menu[answer.choice]!.action;
          source = 'ai';
          reason = answer.reason;
          ms = answer.ms;
          aiCount++;
          msTotal += ms;
        } else {
          fallbacks++;
          source = 'fallback';
        }
      } else if (menu.length === 1) {
        action = menu[0]!.action;
      }
      action ??= botAction(view);
      if (!action) continue;
      const label = menu.find((c) => c.action === action)?.label ?? action.type;
      const target = targetOf(action);
      if (!apply(id, action)) continue;
      if (menu.length > 1) {
        appendFileSync(
          join(OUT, 'decisions.jsonl'),
          JSON.stringify({
            game: g,
            step,
            actor: id,
            team: team(before, id),
            role: before.players[id]!.role ? ROLES[before.players[id]!.role!].title : null,
            phase: before.phase.kind === 'night' ? `night:${before.phase.step}` : before.phase.kind,
            menu: menu.length,
            source,
            label,
            action: action.type,
            target: target ?? null,
            targetTeam: target ? team(before, target) : null,
            targetAccusations: target ? projectFor(before, id).players[target]!.accusations : null,
            reason,
            ms,
          }) + '\n',
        );
      }
      moved = true;
      break;
    }
    if (!moved) apply('system', { type: 'TIMEOUT' });
  }

  const ph = s.phase;
  const summary = {
    game: g,
    seed,
    winner: ph.kind === 'game_over' ? ph.winner : null,
    steps: step,
    minutes: Math.round((Date.now() - started) / 600) / 100,
    aiDecisions: aiCount,
    fallbacks,
    avgMs: aiCount ? Math.round(msTotal / aiCount) : 0,
    players: s.seats.map((id) => ({
      name: id,
      role: s.players[id]!.role ? ROLES[s.players[id]!.role!].title : null,
      startedAs: s.players[id]!.everWitch ? 'witch' : 'town',
      alive: s.players[id]!.alive,
    })),
  };
  appendFileSync(join(OUT, 'games.jsonl'), JSON.stringify(summary) + '\n');
  writeFileSync(join(OUT, `game-${g}.log`), events.map((e) => (e.to ? `（只有 ${e.to.join('、')} 看得到）` : '') + e.text).join('\n') + '\n');
  console.log(`game ${g}: ${summary.winner} in ${summary.minutes} min, ${aiCount} AI decisions, ${fallbacks} fallbacks, avg ${summary.avgMs}ms`);
}

for (let g = 1; g <= GAMES; g++) await playGame(g);
