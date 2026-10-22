import { accessSync, constants, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReplayRecord, ReplaySummary } from './protocol';

const DIR = process.env.REPLAY_DIR ?? join(process.cwd(), 'data', 'replays');
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** Recent summaries kept in memory for the listing */
const LIST_LIMIT = 50;

const summaries: ReplaySummary[] = [];
/** Records that couldn't be written to disk: still viewable until the server restarts */
const unsaved = new Map<string, ReplayRecord>();
const UNSAVED_LIMIT = 20;
/** null until the first check or save */
let writable: boolean | null = null;

function whyNotWritable(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code ?? String(e);
  const uid = typeof process.getuid === 'function' ? `uid ${process.getuid()}` : '';
  return `${code}（資料夾 ${DIR}，執行身分 ${uid}）。對戰紀錄只會暫存在記憶體，伺服器重啟就沒了：請確認這個資料夾存在而且執行身分可以寫入`;
}

/** For the health check: whether games can be saved to disk, and how many are only in memory */
export function replayStatus() {
  return { writable, savedInMemoryOnly: unsaved.size, listed: summaries.length };
}

function summarize(r: ReplayRecord): ReplaySummary {
  return {
    id: r.id,
    roomCode: r.roomCode,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    players: r.seats.map((s) => s.name),
    winner: r.winner,
  };
}

/** Load summaries of games saved by earlier server runs */
export function loadReplays() {
  try {
    mkdirSync(DIR, { recursive: true });
    accessSync(DIR, constants.W_OK);
    writable = true;
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        summaries.push(summarize(JSON.parse(readFileSync(join(DIR, f), 'utf8')) as ReplayRecord));
      } catch {
        // Skip unreadable files
      }
    }
    summaries.sort((a, b) => b.startedAt - a.startedAt);
    summaries.splice(LIST_LIMIT);
  } catch (e) {
    writable = false;
    console.error(`[replay] 對戰紀錄資料夾有問題：${whyNotWritable(e)}`);
  }
}

export function saveReplay(r: ReplayRecord) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${r.id}.json`), JSON.stringify(r));
    writable = true;
  } catch (e) {
    // Keep it in memory so the replay still opens, and say loudly why it isn't on disk
    writable = false;
    unsaved.set(r.id, r);
    for (const old of [...unsaved.keys()].slice(0, Math.max(0, unsaved.size - UNSAVED_LIMIT))) unsaved.delete(old);
    console.error(`[replay] 無法儲存對戰紀錄 ${r.id}：${whyNotWritable(e)}`);
  }
  summaries.unshift(summarize(r));
  summaries.splice(LIST_LIMIT);
}

export function listReplays(): ReplaySummary[] {
  return summaries;
}

export function getReplay(id: string): ReplayRecord | null {
  if (!ID_PATTERN.test(id)) return null;
  const memory = unsaved.get(id);
  if (memory) return memory;
  try {
    return JSON.parse(readFileSync(join(DIR, `${id}.json`), 'utf8')) as ReplayRecord;
  } catch {
    return null;
  }
}
