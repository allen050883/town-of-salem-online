import type { Announcement } from './types';

/** How long each full-screen announcement stays up (ms); the live game waits that long. 0 = stays until dismissed (the winner) */
export const ANNOUNCE_MS: Record<Announcement['kind'], number> = { protect: 3500, confess: 4500, target: 3200, survive: 3800, peace: 3000, death: 4500, victory: 0, conspiracy: 4500, conspiracyPass: 3500 };

/** An announcement together with how long it is shown */
export type AnnounceItem = Announcement & { ms: number };

export function announceItems(list: Announcement[]): AnnounceItem[] {
  return list.map((a) => ({ ...a, ms: ANNOUNCE_MS[a.kind] }));
}
