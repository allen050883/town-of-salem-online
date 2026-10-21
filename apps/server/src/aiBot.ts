/**
 * Computer players that think with a self-hosted model through Ollama's chat API.
 * The model only picks a number from a menu of legal moves (see candidateActions in the engine); anything else —
 * no answer in time, a bad answer, Ollama unreachable — falls back to the built-in rule bot.
 * Enabled only when both OLLAMA_URL and OLLAMA_MODEL are set.
 * The model writes a short analysis before its pick (a bounded "think first"); OLLAMA_THINK (low / medium / high) also turns
 * on the model's own thinking, which on long game prompts usually runs far past the timeout. OLLAMA_TIMEOUT_MS sets how
 * long to wait for an answer (default 15s).
 */
import { ACCUSATION_VALUE, CARD_NAME, ROLES, tryalCounts, type Candidate, type CardType, type PlayerId, type PlayerView } from '@salem/engine';

const OLLAMA_URL = process.env.OLLAMA_URL?.replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL;
const THINK = process.env.OLLAMA_THINK && process.env.OLLAMA_THINK !== 'false' ? process.env.OLLAMA_THINK : false;
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 15_000;
/** Cap on the answer length: a short analysis keeps each move to a few seconds (thinking tokens count too) */
const MAX_ANSWER_TOKENS = THINK ? 2000 : 320;
/** After Ollama can't be reached, skip it for this long so a sleeping PC doesn't stall every move */
const COOLDOWN_MS = 60_000;
const HISTORY_LIMIT = 30;

let downUntil = 0;

export function aiEnabled(): boolean {
  return !!OLLAMA_URL && !!OLLAMA_MODEL;
}

/** A card played on someone, kept by the room for the stats section (card plays are public) */
export interface Play {
  actor: PlayerId;
  type: CardType;
  target: PlayerId;
  second?: PlayerId;
  asWitness?: boolean;
}

const SYSTEM = `你是桌遊《獵巫鎮 1692》（Salem 1692）的玩家，要替自己的陣營贏得勝利。

規則摘要：
- 陣營：女巫陣營 vs 鎮民陣營（平民、警長）。
- 審判牌：每人有好幾張面朝下的審判牌（例如 5 人局每人 5 張），自己看得到自己的。所有審判牌是洗混後平分的，所以女巫通常是「1 張女巫牌 + 幾張平民牌」。持有女巫牌的人就是女巫。
- 輪到你時，二選一：抽兩張牌（之後不能出牌），或打出任意張手牌，再結束回合。
- 紅牌是指控：指控 +1、證據 +3、目擊 +7 點。某人累積到門檻（通常 7 點）就翻開他一張審判牌；翻到女巫牌他就死亡，審判牌全部翻開也會死亡。
- 綠牌立即生效：辯護（移除最多 3 點指控）、縱火（燒掉對方所有手牌）、詛咒（棄掉對方面前一張藍牌）、搶劫（把一人的手牌全交給另一人）、代罪羔羊（把一人面前的牌全轉給另一人）。
- 藍牌放在對方面前持續生效：拘留（跳過下回合）、情侶（兩人同生共死）、避難（夜晚不會被女巫殺）、信徒（不能被打紅牌）。
- 夜晚：女巫一起選一人殺害；警長把法槌交給一人保護他（不能給自己）；天亮前每人可以自首，翻開自己一張審判牌換取當晚免死。
- 黎明：女巫把黑貓放在某人面前；之後抽到「傳染」時，黑貓持有者要先翻開自己一張審判牌。
- 勝利：所有女巫都死亡 → 鎮民贏；存活者全部是女巫 → 女巫贏。

推理的關鍵（很重要）：
- 翻出平民牌「不代表清白」，只代表那一張不是女巫牌。女巫牌藏在還沒翻開的牌裡：一個人沒翻開的牌越少，是女巫的機率越低，但只要還有沒翻開的牌，就可能是女巫。不要說「他翻出平民所以可信」。
- 黑貓是女巫放的，通常放在鎮民面前。持有黑貓不是可疑的理由，反而偏向是鎮民。
- 真正的線索是行為：誰替誰辯護、誰從不指控某些人、誰的指控總落在後來被證明不是女巫的人身上、誰帶頭推動對某人的審判、誰在夜晚從不被殺（女巫不會殺同伴）。

策略重點：
- 鎮民：依行為線索判斷誰像女巫，把指控集中在你真的懷疑的人身上。不要因為某人「只差 1 點」就跟著打，女巫會刻意把指控引到鎮民身上，讓鎮民幫他們完成審判；只有在你也懷疑他時才完成審判。辯護、避難、信徒只給你有理由相信的人。
- 女巫：絕不指控女巫同伴；把指控引到鎮民身上，特別是快到門檻的鎮民；夜晚優先殺掉一直指控你或你同伴的人，其次是看起來最可信、沒有避難的鎮民；必要時替同伴辯護，但別太明顯。
- 警長：保護最可能被女巫殺的可信鎮民（例如一直在指控可疑者的人）。
- 自首會翻開自己一張審判牌，翻光就會死，而且翻出平民不能證明清白。只有在你今晚很可能被殺、還有多張沒翻開的牌、而且翻開的不是女巫牌時才考慮。

回覆格式：只回 JSON。先在 reason 用 80 字以內的中文分析局勢（你的陣營目標、誰最可疑或威脅最大、這一步要達成什麼），再寫選項編號，例如 {"reason":"我是鎮民。Bob 一直替 Amy 辯護，Amy 又避開 Bob 的指控，兩人像女巫同伴；Bob 只差 1 點就會被審判，先完成審判","choice":3}`;

function identity(v: PlayerView): string {
  if (v.amWitch) return '女巫陣營';
  if (v.amConstable) return '鎮民陣營（你是警長）';
  return '鎮民陣營（平民）';
}

const TRYAL = { witch: '女巫', constable: '警長', not_a_witch: '平民' } as const;

/**
 * For a town viewer: the chance each living player holds at least one Witch card, judging only by how many of their
 * cards are still face down (the Witch cards not yet seen are spread at random over everyone else's hidden cards).
 */
function witchChances(v: PlayerView): Map<PlayerId, number> {
  const out = new Map<PlayerId, number>();
  if (v.amWitch) return out;
  const total = tryalCounts(v.seats.length, v.options.extraWitch).witch;
  let seen = 0;
  for (const id of v.seats) {
    for (const t of v.players[id]!.tryals) if (t.kind === 'witch' && (t.revealed || id === v.me)) seen++;
  }
  const left = Math.max(0, total - seen);
  const others = v.seats.filter((id) => id !== v.me && v.players[id]!.alive);
  const hidden = (id: PlayerId) => v.players[id]!.tryals.filter((t) => !t.revealed).length;
  const pool = others.reduce((n, id) => n + hidden(id), 0);
  for (const id of others) {
    // 1 − C(pool − u, left) / C(pool, left)
    let none = 1;
    for (let i = 0; i < left; i++) none *= Math.max(0, pool - hidden(id) - i) / (pool - i);
    out.set(id, left > 0 && pool > 0 ? 1 - none : 0);
  }
  return out;
}

function describeView(v: PlayerView): string {
  const me = v.players[v.me]!;
  const lines: string[] = [];
  lines.push(`你是 ${me.name}，${identity(v)}。`);
  if (me.role) {
    const r = ROLES[me.effectiveRole ?? me.role];
    lines.push(`你的角色：${ROLES[me.role].title}${me.effectiveRole && me.effectiveRole !== me.role ? `（目前複製${r.title}）` : ''}，能力：${r.desc}`);
  }
  lines.push(`你的審判牌：${me.tryals.map((t) => `${t.kind ? TRYAL[t.kind] : '?'}${t.revealed ? '（已翻開）' : ''}`).join('、')}`);
  lines.push(`你的手牌：${v.myHand.map((c) => CARD_NAME[c.type]).join('、') || '（沒有）'}`);
  if (v.amWitch) {
    const allies = v.seats.filter((id) => id !== v.me && v.players[id]!.isWitch && v.players[id]!.alive).map((id) => v.players[id]!.name);
    lines.push(`女巫同伴：${allies.join('、') || '（沒有存活的同伴）'}`);
  }
  lines.push(`牌堆剩 ${v.deckCount} 張。`, '', '所有玩家（依座位順序，下一位是左手邊）：');
  const chances = witchChances(v);
  for (const id of v.seats) {
    const p = v.players[id]!;
    const parts = [p.id === v.me ? `${p.name}（你）` : p.name, p.alive ? '存活' : '已死亡'];
    if (p.role) parts.push(`角色 ${ROLES[p.role].title}`);
    if (p.alive) parts.push(`指控 ${p.accusations}/${p.threshold} 點`, `手牌 ${p.handCount} 張`);
    const front = p.front
      .filter((c) => !ACCUSATION_VALUE[c.type])
      .map((c) => (c.type === 'black_cat' ? '黑貓（女巫放的，持有者偏向是鎮民）' : CARD_NAME[c.type]));
    if (front.length) parts.push(`面前：${front.join('、')}`);
    const shown = p.tryals.filter((t) => t.revealed && t.kind).map((t) => TRYAL[t.kind!]);
    if (shown.length) parts.push(`已翻開：${shown.join('、')}`);
    if (p.alive) parts.push(`未翻開 ${p.tryals.filter((t) => !t.revealed).length} 張`);
    const chance = chances.get(id);
    if (chance !== undefined) parts.push(`只看牌數，是女巫的機率約 ${Math.round(chance * 100)}%`);
    if (v.amWitch && p.isWitch && p.id !== v.me) parts.push('女巫同伴');
    lines.push(`- ${parts.join('｜')}`);
  }
  return lines.join('\n');
}

/** Cards that help their target: who keeps helping whom is the clearest sign of Witch partners */
const HELPS: Partial<Record<CardType, string>> = { alibi: '辯護', asylum: '避難', piety: '信徒' };

/** Who did what to whom, summed from the public card plays */
function describeStats(v: PlayerView, plays: Play[]): string {
  const name = (id: PlayerId) => v.players[id]?.name ?? '?';
  const acc = new Map<string, number>();
  const helped = new Map<string, number>();
  const other: string[] = [];
  for (const p of plays) {
    const value = p.asWitness ? 7 : ACCUSATION_VALUE[p.type];
    if (value) {
      const k = `${p.actor}>${p.target}`;
      acc.set(k, (acc.get(k) ?? 0) + value);
    } else if (HELPS[p.type]) {
      const k = `${p.actor}>${p.target}>${p.type}`;
      helped.set(k, (helped.get(k) ?? 0) + 1);
    } else if (p.type === 'robbery' || p.type === 'scapegoat') {
      other.push(`${name(p.actor)} 用${CARD_NAME[p.type]}把 ${name(p.target)} 的牌轉給 ${name(p.second!)}`);
    } else {
      other.push(`${name(p.actor)} 對 ${name(p.target)} 打出${CARD_NAME[p.type]}`);
    }
  }
  const sections: string[] = [];
  const accLines = [...acc].map(([k, n]) => {
    const [a, t] = k.split('>') as [PlayerId, PlayerId];
    return `- ${name(a)} 對 ${name(t)} 累計打了 ${n} 點指控`;
  });
  if (accLines.length) sections.push('指控：', ...accLines);
  const helpLines = [...helped].map(([k, n]) => {
    const [a, t, type] = k.split('>') as [PlayerId, PlayerId, CardType];
    return `- ${name(a)} 幫 ${name(t)}：${HELPS[type]} ${n} 次`;
  });
  if (helpLines.length) sections.push('保護別人（一直保護同一個人，可能是女巫同伴）：', ...helpLines);
  if (other.length) sections.push('其他：', ...other.slice(-15).map((l) => `- ${l}`));
  return sections.join('\n') || '（還沒有人出牌）';
}

export function buildMessages(v: PlayerView, history: string[], plays: Play[], menu: Candidate[]) {
  const user = [
    describeView(v),
    '',
    '出牌統計：',
    describeStats(v, plays),
    '',
    `最近的事件（舊→新）：`,
    history.slice(-HISTORY_LIMIT).join('\n') || '（沒有）',
    '',
    '現在輪到你決定，可以選的動作：',
    ...menu.map((c, i) => `${i + 1}. ${c.label}`),
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

const FORMAT = {
  type: 'object',
  properties: { reason: { type: 'string' }, choice: { type: 'integer' } },
  required: ['reason', 'choice'],
};

export interface AiAnswer {
  /** Index into the menu */
  choice: number;
  reason: string;
  ms: number;
}

/** Ask the model; returns its pick from `menu`, or null to fall back to the rule bot */
export async function aiChoose(v: PlayerView, history: string[], plays: Play[], menu: Candidate[]): Promise<AiAnswer | null> {
  if (!aiEnabled() || Date.now() < downUntil) return null;
  const started = Date.now();
  const who = v.players[v.me]?.name ?? v.me;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: buildMessages(v, history, plays, menu),
        stream: false,
        think: THINK,
        format: FORMAT,
        options: { temperature: 0.4, num_predict: MAX_ANSWER_TOKENS },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { message?: { content?: string } };
    const ms = Date.now() - started;
    let answer: { reason?: unknown; choice?: unknown };
    try {
      answer = JSON.parse(body.message?.content ?? '') as typeof answer;
    } catch {
      // A garbled answer is the model's fault, not the connection's: no cooldown
      console.warn(`[ai] ${who}: unreadable answer (${ms}ms)`);
      return null;
    }
    const i = Number(answer.choice) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= menu.length) {
      console.warn(`[ai] ${who}: invalid choice ${String(answer.choice)} (${ms}ms)`);
      return null;
    }
    // The reason may mention secrets (a Witch's plan), so it only goes to the server log
    const reason = String(answer.reason ?? '');
    console.log(`[ai] ${who}: ${i + 1}/${menu.length} ${menu[i]!.label} — ${reason} (${ms}ms)`);
    return { choice: i, reason, ms };
  } catch (e) {
    // Too slow this once: play this move with the built-in bot but keep asking the model
    if (e instanceof Error && e.name === 'TimeoutError') {
      console.warn(`[ai] ${who}: no answer within ${TIMEOUT_MS / 1000}s`);
      return null;
    }
    downUntil = Date.now() + COOLDOWN_MS;
    console.warn(`[ai] ${who}: Ollama unreachable, using the built-in bot for ${COOLDOWN_MS / 1000}s (${e instanceof Error ? e.message : e})`);
    return null;
  }
}
