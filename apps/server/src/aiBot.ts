/**
 * Computer players that think with a self-hosted model through Ollama's chat API.
 * The model only picks a number from a menu of legal moves (see candidateActions in the engine); anything else —
 * no answer in time, a bad answer, Ollama unreachable — falls back to the built-in rule bot.
 * Enabled only when both OLLAMA_URL and OLLAMA_MODEL are set.
 */
import { ACCUSATION_VALUE, CARD_NAME, ROLES, type Candidate, type CardType, type PlayerId, type PlayerView } from '@salem/engine';

const OLLAMA_URL = process.env.OLLAMA_URL?.replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL;
const TIMEOUT_MS = 12_000;
/** Cap on the answer length: a short reason keeps each move to a few seconds */
const MAX_ANSWER_TOKENS = 120;
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
- 陣營：女巫陣營 vs 鎮民陣營（平民、警長）。每人有數張面朝下的審判牌（女巫／警長／平民），自己看得到自己的。
- 輪到你時，二選一：抽兩張牌（之後不能出牌），或打出任意張手牌，再結束回合。
- 紅牌是指控：指控 +1、證據 +3、目擊 +7 點。某人累積到門檻（通常 7 點）就翻開他一張審判牌；翻到女巫牌他就死亡，審判牌全部翻開也會死亡。
- 綠牌立即生效：辯護（移除最多 3 點指控）、縱火（燒掉對方所有手牌）、詛咒（棄掉對方面前一張藍牌）、搶劫（把一人的手牌全交給另一人）、代罪羔羊（把一人面前的牌全轉給另一人）。
- 藍牌放在對方面前持續生效：拘留（跳過下回合）、情侶（兩人同生共死）、避難（夜晚不會被女巫殺）、信徒（不能被打紅牌）。
- 夜晚：女巫一起選一人殺害；警長把法槌交給一人保護他（不能給自己）；天亮前每人可以自首，翻開自己一張審判牌換取當晚免死。
- 黎明：女巫把黑貓放在某人面前；之後抽到「傳染」時，黑貓持有者要先翻開自己一張審判牌。
- 勝利：所有女巫都死亡 → 鎮民贏；存活者全部是女巫 → 女巫贏。

策略重點：
- 鎮民：根據紀錄推理誰像女巫（誰一直替別人辯護、誰的指控總避開某些人、誰被翻出平民後是誰帶頭指控他）；優先完成快到門檻的審判；保護已經翻出平民牌的人。
- 女巫：絕不指控女巫同伴；把指控引到鎮民身上，特別是快到門檻的鎮民；夜晚殺看起來最可信、沒有避難的鎮民；必要時替同伴辯護，但別太明顯。
- 警長：保護最可能被女巫殺的可信鎮民。
- 自首只有在你今晚很可能被殺、而且翻開的牌不是女巫牌時才划算。

回覆格式：只回 JSON，先用一句 30 字以內的中文寫理由，再寫選項編號，例如 {"reason":"Bob 只差 1 點就會被審判","choice":3}`;

function identity(v: PlayerView): string {
  if (v.amWitch) return '女巫陣營';
  if (v.amConstable) return '鎮民陣營（你是警長）';
  return '鎮民陣營（平民）';
}

const TRYAL = { witch: '女巫', constable: '警長', not_a_witch: '平民' } as const;

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
  for (const id of v.seats) {
    const p = v.players[id]!;
    const parts = [p.id === v.me ? `${p.name}（你）` : p.name, p.alive ? '存活' : '已死亡'];
    if (p.role) parts.push(`角色 ${ROLES[p.role].title}`);
    if (p.alive) parts.push(`指控 ${p.accusations}/${p.threshold} 點`, `手牌 ${p.handCount} 張`);
    const front = p.front.filter((c) => !ACCUSATION_VALUE[c.type]).map((c) => CARD_NAME[c.type]);
    if (front.length) parts.push(`面前：${front.join('、')}`);
    const shown = p.tryals.filter((t) => t.revealed && t.kind).map((t) => TRYAL[t.kind!]);
    if (shown.length) parts.push(`已翻開：${shown.join('、')}`);
    if (p.alive) parts.push(`未翻開 ${p.tryals.filter((t) => !t.revealed).length} 張`);
    if (v.amWitch && p.isWitch && p.id !== v.me) parts.push('女巫同伴');
    lines.push(`- ${parts.join('｜')}`);
  }
  return lines.join('\n');
}

/** Who did what to whom, summed from the public card plays */
function describeStats(v: PlayerView, plays: Play[]): string {
  const name = (id: PlayerId) => v.players[id]?.name ?? '?';
  const acc = new Map<string, number>();
  const other: string[] = [];
  for (const p of plays) {
    const value = p.asWitness ? 7 : ACCUSATION_VALUE[p.type];
    if (value) {
      const k = `${p.actor}>${p.target}`;
      acc.set(k, (acc.get(k) ?? 0) + value);
    } else if (p.type === 'robbery' || p.type === 'scapegoat') {
      other.push(`${name(p.actor)} 用${CARD_NAME[p.type]}把 ${name(p.target)} 的牌轉給 ${name(p.second!)}`);
    } else {
      other.push(`${name(p.actor)} 對 ${name(p.target)} 打出${CARD_NAME[p.type]}`);
    }
  }
  const lines = [...acc].map(([k, n]) => {
    const [a, t] = k.split('>') as [PlayerId, PlayerId];
    return `${name(a)} 對 ${name(t)} 累計打了 ${n} 點指控`;
  });
  return [...lines, ...other.slice(-20)].join('\n') || '（還沒有人出牌）';
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

/** Ask the model; returns the index into `menu`, or null to fall back to the rule bot */
export async function aiChoose(v: PlayerView, history: string[], plays: Play[], menu: Candidate[]): Promise<number | null> {
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
        think: false,
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
    console.log(`[ai] ${who}: ${i + 1}/${menu.length} ${menu[i]!.label} — ${String(answer.reason ?? '')} (${ms}ms)`);
    return i;
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
