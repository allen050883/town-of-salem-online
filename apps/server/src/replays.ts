import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReplayRecord, ReplaySummary } from './protocol';

const DIR = process.env.REPLAY_DIR ?? join(process.cwd(), 'data', 'replays');
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** Recent summaries kept in memory for the listing */
const LIST_LIMIT = 50;

const summaries: ReplaySummary[] = [];

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
    console.warn('無法讀取對戰紀錄資料夾', e);
  }
}

export function saveReplay(r: ReplayRecord) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${r.id}.json`), JSON.stringify(r));
  } catch (e) {
    console.warn('無法儲存對戰紀錄', e);
  }
  summaries.unshift(summarize(r));
  summaries.splice(LIST_LIMIT);
}

export function listReplays(): ReplaySummary[] {
  return summaries;
}

export function getReplay(id: string): ReplayRecord | null {
  if (!ID_PATTERN.test(id)) return null;
  try {
    return JSON.parse(readFileSync(join(DIR, `${id}.json`), 'utf8')) as ReplayRecord;
  } catch {
    return null;
  }
}
