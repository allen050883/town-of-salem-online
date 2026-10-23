/**
 * Computer players that think with a self-hosted model through Ollama's chat API.
 * The model only picks a number from a menu of legal moves (see candidateActions in the engine); anything else —
 * no answer in time, a bad answer, Ollama unreachable — falls back to the built-in rule bot.
 * Enabled only when both OLLAMA_URL and OLLAMA_MODEL are set.
 * The model writes a short analysis before its pick (a bounded "think first"); OLLAMA_THINK (low / medium / high) also turns
 * on the model's own thinking, which on long game prompts usually runs far past the timeout. OLLAMA_TIMEOUT_MS sets how
 * long to wait for an answer (default 15s).
 */
import { ACCUSATION_VALUE, CARD_NAME, ROLES, tryalCounts, type Candidate, type CardType, type PlayerId, type PlayerView, type RoleId } from '@salem/engine';

const OLLAMA_URL = process.env.OLLAMA_URL?.replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL;
const THINK = process.env.OLLAMA_THINK && process.env.OLLAMA_THINK !== 'false' ? process.env.OLLAMA_THINK : false;
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 15_000;
/** Cap on the answer length: a short analysis keeps each move to a few seconds (thinking tokens count too) */
const MAX_ANSWER_TOKENS = Number(process.env.OLLAMA_NUM_PREDICT) || (THINK ? 2000 : 320);
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

export const SYSTEM = `你是桌遊《獵巫鎮 1692》（Salem 1692）的玩家，要替自己的陣營贏得勝利。

規則摘要：
- 陣營：女巫陣營 vs 鎮民陣營（平民、警長）。
- 審判牌：每人有好幾張面朝下的審判牌，自己看得到自己的。所有審判牌洗混後平分給大家，持有女巫牌的人就是女巫。場上女巫牌「總共幾張」會寫在局面資訊的開頭，一定要以那個數字為準，不要自己猜。
- 輪到你時，二選一：抽兩張牌（之後不能出牌），或打出任意張手牌，再結束回合。
- 紅牌是指控：指控 +1、證據 +3、目擊 +7 點。某人累積到門檻（通常 7 點）就翻開他一張審判牌；翻到女巫牌他就死亡，審判牌全部翻開也會死亡。
- 綠牌立即生效：辯護（移除最多 3 點指控）、縱火（燒掉對方所有手牌）、詛咒（棄掉對方面前一張藍牌）、搶劫（把一人的手牌全交給另一人）、代罪羔羊（把一人面前的牌全轉給另一人）。
- 藍牌放在對方面前持續生效：拘留（跳過下回合）、情侶（兩人同生共死）、避難（夜晚不會被女巫殺）、信徒（不能被打紅牌）。
- 夜晚：女巫一起選一人殺害；警長選一人保護他（不能選自己）；天亮時會公布警長保護了誰；天亮前每人可以自首，翻開自己一張審判牌換取當晚免死。
- 黎明：女巫把黑貓放在某人面前；之後抽到「傳染」時，黑貓持有者要先翻開自己一張審判牌。
- 勝利：所有女巫都死亡 → 鎮民贏；存活者全部是女巫 → 女巫贏。

推理的關鍵（很重要）：
- 翻出平民牌「不代表清白」，只代表那一張不是女巫牌。女巫牌藏在還沒翻開的牌裡：一個人沒翻開的牌越少，是女巫的機率越低，但只要還有沒翻開的牌，就可能是女巫。
- 黑貓是女巫放的，通常放在鎮民面前，所以持有黑貓的人偏向是鎮民。但這只是機率：不代表他的指控可信，也不能拿來證明別人是女巫。
- 行為線索要小心使用：某人隨手打了別人 1~2 點指控不是證據；「很低調」「沒有指控」也不是女巫的證據。比較強的線索只有：一個人一再替同一個人辯護或給保護牌；一個人的指控總是落在後來被證明不是女巫的人身上。
- 規則上沒寫的事不要自己編（例如女巫有幾個、某張牌有什麼效果），以本訊息和局面資訊為準。

策略重點：
- 鎮民（自保 + 平均分散）：
  · 鎮民只能靠審判把女巫牌翻出來才會贏，所以不能一直不出手。沒有明確線索時，預設做「平均分散」：把指控打在「未翻開審判牌最多」的人身上（局面資訊會寫每個人未翻開幾張，同票的都算候選人）。候選人之中，挑目前累積指控最多的那位繼續打，讓審判真的完成；他被翻開一張牌後再換下一個人。全場鎮民都這樣做，就會自然集中在同一個人。這樣不會把鎮民審死，每次審判也在縮小女巫的藏身範圍。
  · 反過來，不要專打「未翻開牌最少」的人：那是女巫殺鎮民的做法。
  · 沒有紅牌可出時就抽牌；手上的辯護、避難這類牌先留著，等有人（尤其是你信任的人）被集火時再用。
  · 自保：有人針對你（一直打你指控、對你出手）時才反擊，用拘留、縱火、詛咒削弱那個人，不要亂打無關的人；夜晚覺得自己會被殺時可以自首保命。
  · 「明確線索」只有這些（局面資訊裡的「明確線索」區會列出）：某人是女巫的機率 ≥ 60%；某人一再（至少 2 次）替同一個人辯護或給保護牌；某人的指控總是落在後來被證明不是女巫的人身上。出現明確線索時，放棄平均分散，集中火力攻擊那個人；如果打不到（有信徒保護），先用詛咒拆掉保護再動手。
  · 隨手的指控、持黑貓、「很低調」都不算線索。辯護、避難、信徒只給你有充分理由相信不是女巫的人。
- 女巫（積極、會誤導）：
  · 每個回合都要推進一件事，不要只抽牌或結束回合；手上有可用的牌就找機會用。
  · 目標：用審判殺鎮民（優先沒翻開的牌很少、一次審判就會死的人），夜晚殺最有威脅的人（一直指控你的人優先）。
  · 偽裝與誤導：黎明時把黑貓放在自己面前（持黑貓的人看起來像鎮民，傳染翻牌時你可以自己選翻平民牌）；偶爾替快被審判的鎮民辯護，或給鎮民保護牌，建立好人形象；跟著群眾去指控「大家已經在打的人」，不要總是第一個出手；用嫁禍、搶劫把指控轉到鎮民身上；對一直盯著你的鎮民，用拘留、縱火削弱他。
  · 絕不指控女巫同伴；別讓人看出固定模式（例如總是在最後補刀、總是先動手）。
- 警長：保護最可能被女巫殺的可信鎮民（例如一直在指控可疑者的人）。
- 角色能力：局面資訊的「你的角色」旁邊寫了用法，要主動用好它（例如牧師從棄牌堆拿好牌、說書人在抽牌前重排牌堆、醫生把辯護當目擊收割、官員自首不翻牌）。候選動作裡有對應的選項。
- 自首會翻開自己一張審判牌，翻光就會死，而且翻出平民不能證明清白。只有在你今晚很可能被殺、還有多張沒翻開的牌、而且翻開的不是女巫牌時才考慮。你還有 3 張以上沒翻開的牌時，花一張換一晚平安很划算（平民尤其應該），可以常常自首；只剩 2 張就要保守。
- 同一回合內的行動要前後一致：「你這回合已經做過的事」會列在下面，不要剛打了某人，又在同一回合替他辯護。

回覆格式：只回 JSON。先在 reason 用 80 字以內的中文分析局勢（你的陣營目標、誰最可疑或威脅最大、這一步要達成什麼），再寫選項編號，例如 {"reason":"我是鎮民。Bob 一直替 Amy 辯護，Amy 又避開 Bob 的指控，兩人像女巫同伴；Bob 只差 1 點就會被審判，先完成審判","choice":3}`;

function identity(v: PlayerView): string {
  if (v.amWitch) return '女巫陣營';
  if (v.amConstable) return '鎮民陣營（你是警長）';
  return '鎮民陣營（平民）';
}

const TRYAL = { witch: '女巫', constable: '警長', not_a_witch: '平民' } as const;

/** The facts the model must not guess: table size and how many Witch cards exist */
export function factsLine(players: number, extraWitch: boolean): string {
  const k = tryalCounts(players, extraWitch).witch;
  return `本局共 ${players} 人，場上總共只有 ${k} 張女巫牌（全部藏在大家的審判牌裡）。${k === 1 ? '只有 1 個女巫：找到他並讓他死亡，鎮民就贏了。' : `有 ${k} 個女巫。`}`;
}

/** What a player has already done this turn (and why), so the next decision in the same turn stays consistent */
const turnNotes = new Map<PlayerId, string[]>();

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

/** How to get the most out of each character (shown next to the player's own character) */
export const ROLE_TIPS: Record<RoleId, string> = {
  abigail: '別人對你的指控（你面前的紅牌）太多時，主動發起審判，審判後會全部丟掉。',
  ann: '發起審判時先抽 2 張、當回合就能用：手牌少時可以積極發起審判。',
  cotton: '別人對你打的證據只算 1 點，不用太怕證據；指控和目擊照算。',
  giles: '抽牌時若抽到 2 張指控會再抽 1 張：手牌缺指控時多抽牌。',
  george: '要 8 點才能審判你，你比別人耐打，可以承受更多指控。',
  proctor: '有玩家死亡時會自動收下他的手牌（最多 3 張），不必操作。',
  martha: '複製右手邊第一位存活玩家的能力，注意他的角色有什麼用。',
  mary: '黑貓與情侶對你無效：抽到傳染時你不必翻牌，可以放心持有黑貓。',
  rebecca: '別人因審判被翻牌時你會自動抽 1 張，不必操作。',
  parris: '全場 2 次：抽牌時可改從棄牌堆拿最多 2 張非黑牌（候選動作有「從棄牌堆拿」）。棄牌堆有證據、目擊、縱火、搶劫、避難等好牌時就用。',
  sarah: '搶劫、縱火對你無效：不怕被燒手牌，可以多存牌。',
  danforth: '你打出的指控累積 6 點就能審判（比別人少 1 點）：想發起審判時挑你打過的人。',
  tituba: '全場 1 次：抽牌前可查看並重排牌堆（候選動作有「查看並重排牌堆」），手牌少、需要好牌時用，排好後會接著抽兩張。',
  griggs: '辯護可以當作目擊（+7 點）打出：對手只差幾點就能審判時用來收割。',
  phips: '全場 1 次：夜晚自首時不必翻開審判牌（候選動作有「自首但不翻牌」）：覺得自己今晚會被殺就用它。',
};

function describeView(v: PlayerView): string {
  const me = v.players[v.me]!;
  const lines: string[] = [];
  lines.push(`你是 ${me.name}，${identity(v)}。`);
  lines.push(factsLine(v.seats.length, v.options.extraWitch));
  if (me.role) {
    const r = ROLES[me.effectiveRole ?? me.role];
    lines.push(`你的角色：${ROLES[me.role].title}${me.effectiveRole && me.effectiveRole !== me.role ? `（目前複製${r.title}）` : ''}，能力：${r.desc}`);
    lines.push(`這個能力的用法：${ROLE_TIPS[me.effectiveRole ?? me.role]}`);
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

/** The wording of the clue lines, shared with scripts/ai-probe.ts */
export const chanceClue = (name: string, pct: number) => `- ${name} 是女巫的機率約 ${pct}%（已經超過 60%）`;
export const helpClue = (a: string, n: number, t: string) => `- ${a} 已經 ${n} 次替 ${t} 辯護或給保護牌（兩人之中可能有女巫）`;
export function clueBlock(lines: string[]): string {
  return ['明確線索：', ...(lines.length ? lines : ['（目前沒有。沒有明確線索時，照「平均分散」的預設做法。）'])].join('\n');
}

/** Clear clues against someone, for a town viewer: the only grounds for a hard attack (see the strategy text) */
export function describeClues(v: PlayerView, plays: Play[]): string {
  if (v.amWitch) return '';
  const name = (id: PlayerId) => v.players[id]?.name ?? '?';
  const out: string[] = [];
  for (const [id, c] of witchChances(v)) if (c >= 0.6) out.push(chanceClue(name(id), Math.round(c * 100)));
  const helped = new Map<string, number>();
  for (const p of plays) if (HELPS[p.type]) helped.set(`${p.actor}>${p.target}`, (helped.get(`${p.actor}>${p.target}`) ?? 0) + 1);
  for (const [k, n] of helped) {
    if (n < 2) continue;
    const [a, t] = k.split('>') as [PlayerId, PlayerId];
    out.push(helpClue(name(a), n, name(t)));
  }
  return clueBlock(out);
}

/** The reply-format paragraph differs by mode: thinking mode analyses in up to 80 characters, fast mode in about 15 */
const REPLY_FORMAT_MARK = '回覆格式：只回 JSON。';
const FAST_REPLY_FORMAT = `回覆格式：只回 JSON。reason 用 15 字以內的中文簡述（誰、為什麼），再寫選項編號，例如 {"reason":"Bob 未翻開牌最多","choice":3}`;
export function systemPrompt(mode: AiMode): string {
  if (mode !== 'fast') return SYSTEM;
  return SYSTEM.slice(0, SYSTEM.indexOf(REPLY_FORMAT_MARK)) + FAST_REPLY_FORMAT;
}

export function buildMessages(v: PlayerView, history: string[], plays: Play[], menu: Candidate[], notes: string[] = [], mode: AiMode = DEFAULT_MODE) {
  const clues = describeClues(v, plays);
  const user = [
    describeView(v),
    '',
    '出牌統計：',
    describeStats(v, plays),
    '',
    ...(clues ? [clues, ''] : []),
    `最近的事件（舊→新）：`,
    history.slice(-HISTORY_LIMIT).join('\n') || '（沒有）',
    '',
    ...(notes.length ? ['你這回合已經做過的事（先後順序）：', ...notes.map((n) => `- ${n}`), ''] : []),
    '現在輪到你決定，可以選的動作：',
    ...menu.map((c, i) => `${i + 1}. ${c.label}`),
  ].join('\n');
  return [
    { role: 'system', content: systemPrompt(mode) },
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
  /** The model's own thinking, when thinking mode is on (empty otherwise) */
  thinking: string;
  /** Tokens the model produced (thinking included) */
  tokens: number;
  /** The player-facing part of the prompt that was sent (for review) */
  prompt: string;
}

/**
 * How hard the computers think, chosen by the host: fast mode answers in a few seconds; thinking mode lets the model reason
 * first (a sharper pick, but each step can take a minute and keeps the GPU busy).
 */
export type AiMode = 'fast' | 'think';
const THINK_TIMEOUT_MS = 300_000;
/** Fast mode answers with a very short reason, so a small cap keeps each answer around a second */
const FAST_TOKENS = 120;
const MODE_SETTINGS: Record<AiMode, { think: string | false; timeoutMs: number; numPredict: number }> = {
  fast: { think: false, timeoutMs: THINK ? 15_000 : TIMEOUT_MS, numPredict: THINK ? FAST_TOKENS : Number(process.env.OLLAMA_NUM_PREDICT) || FAST_TOKENS },
  think: { think: THINK || 'low', timeoutMs: THINK ? TIMEOUT_MS : THINK_TIMEOUT_MS, numPredict: Number(process.env.OLLAMA_NUM_PREDICT) || 8000 },
};
/** Scripts that set OLLAMA_THINK keep thinking on by default; the live game starts in fast mode */
export const DEFAULT_MODE: AiMode = THINK ? 'think' : 'fast';

/** Send a prompt to the model; returns its pick (an index into a menu of `menuLength`), or null when there is no usable answer */
export async function askModel(
  messages: { role: string; content: string }[],
  menuLength: number,
  who: string,
  mode: AiMode = DEFAULT_MODE,
): Promise<Omit<AiAnswer, 'prompt'> | null> {
  if (!aiEnabled() || Date.now() < downUntil) return null;
  const settings = MODE_SETTINGS[mode];
  const started = Date.now();
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        stream: false,
        think: settings.think,
        format: FORMAT,
        options: { temperature: 0.4, num_predict: settings.numPredict },
      }),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { message?: { content?: string; thinking?: string }; eval_count?: number };
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
    if (!Number.isInteger(i) || i < 0 || i >= menuLength) {
      console.warn(`[ai] ${who}: invalid choice ${String(answer.choice)} (${ms}ms)`);
      return null;
    }
    return { choice: i, reason: String(answer.reason ?? ''), ms, thinking: body.message?.thinking ?? '', tokens: body.eval_count ?? 0 };
  } catch (e) {
    // Too slow this once: play this move with the built-in bot but keep asking the model
    if (e instanceof Error && e.name === 'TimeoutError') {
      console.warn(`[ai] ${who}: no answer within ${settings.timeoutMs / 1000}s`);
      return null;
    }
    downUntil = Date.now() + COOLDOWN_MS;
    console.warn(`[ai] ${who}: Ollama unreachable, using the built-in bot for ${COOLDOWN_MS / 1000}s (${e instanceof Error ? e.message : e})`);
    return null;
  }
}

/** Stage one of a turn: only "draw, act, or end the turn" is decided here, from a short view; the details of an action come in stage two */
const STAGE1_SYSTEM = `你是桌遊《獵巫鎮 1692》（Salem 1692）的玩家。這一步只要決定「這回合要做什麼」：抽牌、出牌（含使用角色能力）、還是結束回合。要出什麼牌、打誰，下一步才會給你完整局面再選。

怎麼選：
- 抽兩張牌：手上沒有值得出的牌、沒有明確目標，或手牌太少時。抽牌後這回合就結束，不能再出牌。
- 出牌：手上有能推進你陣營目標的牌（證據、目擊、縱火、搶劫、拘留…）、有人快被審判需要救（辯護），或要使用角色能力。
- 結束回合：已經出過牌，沒有更值得出的牌時。
- 鎮民偏向自保，但不能一直不動（鎮民要靠審判才會贏）；沒有線索時照「打未翻開牌最多的人」的平均分散做法。女巫要積極，每回合都要推進一件事。

回覆格式：只回 JSON，例如 {"reason":"手上有證據","choice":2}。reason 用 8 字以內的中文。`;

function briefView(v: PlayerView, plays: Play[], notes: string[], options: string[]): string {
  const me = v.players[v.me]!;
  const lines = [`你是 ${me.name}，${identity(v)}。`, factsLine(v.seats.length, v.options.extraWitch)];
  if (me.role) lines.push(`你的角色：${ROLES[me.role].title}。${ROLE_TIPS[me.effectiveRole ?? me.role]}`);
  lines.push(`你的審判牌：${me.tryals.map((t) => `${t.kind ? TRYAL[t.kind] : '?'}${t.revealed ? '（已翻開）' : ''}`).join('、')}`);
  lines.push(`你的手牌：${v.myHand.map((c) => CARD_NAME[c.type]).join('、') || '（沒有）'}`);
  if (v.amWitch) {
    const allies = v.seats.filter((id) => id !== v.me && v.players[id]!.isWitch && v.players[id]!.alive).map((id) => v.players[id]!.name);
    lines.push(`女巫同伴：${allies.join('、') || '（沒有存活的同伴）'}`);
  }
  lines.push('', '所有玩家：');
  const chances = witchChances(v);
  for (const id of v.seats) {
    const p = v.players[id]!;
    if (!p.alive) continue;
    const front = p.front.filter((c) => !ACCUSATION_VALUE[c.type]).map((c) => CARD_NAME[c.type]);
    const chance = chances.get(id);
    lines.push(
      `- ${p.id === v.me ? `${p.name}（你）` : p.name}｜指控 ${p.accusations}/${p.threshold}｜手牌 ${p.handCount}｜未翻開 ${p.tryals.filter((t) => !t.revealed).length} 張${front.length ? `｜面前：${front.join('、')}` : ''}${chance !== undefined ? `｜女巫機率約 ${Math.round(chance * 100)}%` : ''}`,
    );
  }
  const clues = describeClues(v, plays);
  if (clues) lines.push('', clues);
  if (notes.length) lines.push('', '你這回合已經做過的事：', ...notes.map((n) => `- ${n}`));
  lines.push('', '現在先決定這回合要做什麼：', ...options.map((o, i) => `${i + 1}. ${o}`));
  return lines.join('\n');
}

/**
 * Ask the model; returns its pick from `menu`, or null to fall back to the rule bot.
 * A turn is decided in two stages: first draw / act / end the turn (a short prompt, always fast), and only when it chooses to act
 * does it get the full picture and the list of actions, answered in the host's mode.
 */
export async function aiChoose(v: PlayerView, history: string[], plays: Play[], menu: Candidate[], mode: AiMode = DEFAULT_MODE): Promise<AiAnswer | null> {
  if (!aiEnabled() || Date.now() < downUntil) return null;
  const who = v.players[v.me]?.name ?? v.me;
  // A new turn starts with nothing done yet
  const mine = v.phase.kind === 'turn' && v.turn.player === v.me;
  if (mine && v.turn.mode === 'idle') turnNotes.set(v.me, []);
  const notes = mine ? (turnNotes.get(v.me) ?? []) : [];

  let pool = menu.map((_, i) => i);
  let first: { reason: string; ms: number; tokens: number; prompt: string } | null = null;
  if (mine) {
    const draw = menu.findIndex((c) => c.action.type === 'DRAW');
    const end = menu.findIndex((c) => c.action.type === 'END_TURN');
    const act = menu.map((_, i) => i).filter((i) => i !== draw && i !== end);
    const options: { kind: 'draw' | 'act' | 'end'; label: string }[] = [];
    if (draw >= 0) options.push({ kind: 'draw', label: '抽兩張牌（之後這回合就不能再出牌）' });
    if (act.length > 0) options.push({ kind: 'act', label: `出牌或使用角色能力（有 ${act.length} 種做法，下一步再選）` });
    if (end >= 0) options.push({ kind: 'end', label: '結束回合' });

    let chosen = options[0]!;
    first = { reason: '', ms: 0, tokens: 0, prompt: '' };
    if (options.length > 1) {
      const prompt = briefView(v, plays, notes, options.map((o) => o.label));
      const a = await askModel([{ role: 'system', content: STAGE1_SYSTEM }, { role: 'user', content: prompt }], options.length, `${who}（先決定做什麼）`, 'fast');
      if (!a) return null;
      chosen = options[a.choice]!;
      first = { reason: a.reason, ms: a.ms, tokens: a.tokens, prompt };
      console.log(`[ai] ${who}: 先決定「${chosen.label}」 — ${a.reason} (${a.ms}ms)`);
    }
    if (chosen.kind !== 'act') {
      const choice = chosen.kind === 'draw' ? draw : end;
      return { choice, reason: first.reason, ms: first.ms, thinking: '', tokens: first.tokens, prompt: first.prompt };
    }
    pool = act;
  }

  // Stage two (and every other kind of decision): the full picture and the list of actions
  const options = pool.map((i) => menu[i]!);
  const messages = buildMessages(v, history, plays, options, notes, mode);
  const answer = await askModel(messages, options.length, who, mode);
  if (!answer) return null;
  const choice = pool[answer.choice]!;
  // The reason may mention secrets (a Witch's plan), so it only goes to the server log
  console.log(`[ai] ${who}: ${answer.choice + 1}/${options.length} ${menu[choice]!.label} — ${answer.reason} (${answer.ms}ms)`);
  if (mine) turnNotes.set(v.me, [...notes, `${menu[choice]!.label}（理由：${answer.reason}）`]);
  return { ...answer, choice, ms: answer.ms + (first?.ms ?? 0), tokens: answer.tokens + (first?.tokens ?? 0), prompt: messages[1]!.content };
}
