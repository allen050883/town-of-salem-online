/**
 * Regression check for the AI prompt: re-ask the model about decisions saved by ai-selfplay (decisions.jsonl), once with the
 * prompt of an older commit and once with the current one, and compare what it picks. The saved game is the ground truth:
 * the actors whose team was "witch" are the Witches, so each pick can be scored (accused a Witch? protected one?).
 *
 * Usage (OLLAMA_URL / OLLAMA_MODEL / OLLAMA_THINK as for the server):
 *   OUT=<selfplay output dir> PROBE=4,18,80 SAMPLES=3 OLD_REF=<git ref of the older prompt> npx tsx scripts/ai-probe.ts
 * The saved game only keeps the player-facing prompt text, so the current prompt is rebuilt from it: the facts line, the
 * role tip, the clue list and the "done this turn" notes are added the same way the live code adds them.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES } from '@salem/engine';
import { askModel, aiEnabled, chanceClue, clueBlock, factsLine, helpClue, ROLE_TIPS, SYSTEM } from '../src/aiBot';

const OUT = process.env.OUT!;
const PROBE = (process.env.PROBE ?? '').split(',').map(Number).filter(Boolean);
const SAMPLES = Number(process.env.SAMPLES ?? 3);
/** When set, the older prompt is only asked for these probes (the other probes reuse earlier results) */
const OLD_ONLY = (process.env.OLD ?? '').split(',').map(Number).filter(Boolean);
const OLD_REF = process.env.OLD_REF ?? 'HEAD';
if (!aiEnabled() || !OUT || PROBE.length === 0) {
  console.error('Set OLLAMA_URL, OLLAMA_MODEL, OUT and PROBE');
  process.exit(1);
}

interface Saved {
  actor: string;
  team: string;
  phase: string;
  label: string;
  reason: string;
  prompt: string;
  menuLabels: string[];
}
const L = readFileSync(join(OUT, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Saved);
const witches = new Set(L.filter((d) => d.team === 'witch').map((d) => d.actor));

/** The system prompt of an older commit */
const oldSystem = (() => {
  const src = execFileSync('git', ['show', `${OLD_REF}:apps/server/src/aiBot.ts`], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const m = src.match(/const SYSTEM = `([\s\S]*?)`;\n/);
  if (!m) throw new Error('cannot find the old SYSTEM prompt');
  return m[1]!;
})();

const MENU_HEAD = '現在輪到你決定，可以選的動作：';

/** Rebuild what the current code would have sent for this saved decision */
function upgrade(i: number): string {
  const d = L[i]!;
  const lines = d.prompt.split('\n');
  // 1. facts line right after the first line
  const players = lines.filter((l) => /^- .+｜(存活|已死亡)/.test(l)).length;
  lines.splice(1, 0, factsLine(players, false));
  // 2. how to use the character, right after its description
  const ri = lines.findIndex((l) => l.startsWith('你的角色：'));
  if (ri >= 0) {
    const title = lines[ri]!.match(/^你的角色：(\S+?)(?:（|，)/)?.[1];
    const id = Object.entries(ROLES).find(([, r]) => r.title === title)?.[0] as keyof typeof ROLE_TIPS | undefined;
    if (id) lines.splice(ri + 1, 0, `這個能力的用法：${ROLE_TIPS[id]}`);
  }
  let text = lines.join('\n');
  // 3. clear clues (town only): the witch-chance lines and repeated help, read back out of the saved text
  if (d.team !== 'witch') {
    const out: string[] = [];
    for (const l of text.split('\n')) {
      const m = l.match(/^- (\S+?)(?:（你）)?｜存活.*女巫的機率約 (\d+)%/);
      if (m && !l.includes('（你）') && Number(m[2]) >= 60) out.push(chanceClue(m[1]!, Number(m[2])));
    }
    const help = new Map<string, number>();
    for (const m of text.matchAll(/^- (\S+) 幫 (\S+)：(?:辯護|避難|信徒) (\d+) 次$/gm)) help.set(`${m[1]}>${m[2]}`, (help.get(`${m[1]}>${m[2]}`) ?? 0) + Number(m[3]));
    for (const [k, n] of help) if (n >= 2) out.push(helpClue(k.split('>')[0]!, n, k.split('>')[1]!));
    text = text.replace('最近的事件（舊→新）：', `${clueBlock(out)}\n\n最近的事件（舊→新）：`);
  }
  // 4. what this actor already did earlier in the same turn (the decisions right before this one, by the same player)
  const notes: string[] = [];
  if (d.phase === 'turn') {
    for (let j = i - 1; j >= 0 && L[j]!.actor === d.actor && L[j]!.phase === 'turn'; j--) notes.unshift(`${L[j]!.label}（理由：${L[j]!.reason}）`);
  }
  const head = text.indexOf(MENU_HEAD);
  const menu = d.menuLabels.map((label, k) => `${k + 1}. ${label}`);
  return [text.slice(0, head).trimEnd(), '', ...(notes.length ? ['你這回合已經做過的事（先後順序）：', ...notes.map((n) => `- ${n}`), ''] : []), MENU_HEAD, ...menu].join('\n');
}

/** Score a pick against the ground truth of the saved game */
function classify(label: string): string {
  const target = label.match(/^對 (\S+?) 打出/)?.[1] ?? label.match(/打給 (\S+)/)?.[1];
  const side = target ? (witches.has(target) ? '女巫' : '鎮民') : '';
  if (/「(指控|證據|目擊)」/.test(label)) return `指控${side}`;
  if (/「(辯護|避難|信徒)」/.test(label)) return `保護${side}`;
  if (/^抽兩張牌|^結束回合|^不自首/.test(label)) return '不出手';
  return target ? `其他牌→${side}` : '其他';
}

for (const n of PROBE) {
  const d = L[n - 1];
  if (!d) continue;
  if (process.env.DRY) {
    console.log(`===== #${n} ${d.actor} (${d.team}) =====
${upgrade(n - 1)}
`);
    continue;
  }
  const arms: [string, string, string][] = [
    ...(OLD_ONLY.length === 0 || OLD_ONLY.includes(n) ? ([['old', oldSystem, d.prompt]] as [string, string, string][]) : []),
    ['new', SYSTEM, upgrade(n - 1)],
  ];
  const row: Record<string, string[]> = { old: [], new: [] };
  for (const [arm, system, user] of arms) {
    for (let k = 0; k < SAMPLES; k++) {
      const a = await askModel([{ role: 'system', content: system }, { role: 'user', content: user }], d.menuLabels.length, `#${n} ${d.actor} ${arm}`);
      const label = a ? d.menuLabels[a.choice]! : '(沒有答案)';
      row[arm]!.push(classify(label));
      appendFileSync(join(OUT, 'probe-results.jsonl'), JSON.stringify({ n, actor: d.actor, arm, label, reason: a?.reason, thinking: a?.thinking, ms: a?.ms }) + '\n');
    }
  }
  console.log(`#${n} ${d.actor}（${d.team}）原本選：${classify(d.label)}｜舊提示：${row.old.join('、')}｜新提示：${row.new.join('、')}`);
}
