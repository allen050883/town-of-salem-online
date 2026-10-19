import type { LimitedAbility, RoleId } from './types';

export interface RoleInfo {
  name: string;
  /** Traditional Chinese edition title */
  title: string;
  desc: string;
}

/** Abilities as decided in docs/design.md (cross-checked between the zh-TW and Japanese editions) */
export const ROLES: Record<RoleId, RoleInfo> = {
  abigail: { name: 'Abigail Williams', title: '小孩', desc: '由你發起審判時，審判結束後丟棄你面前所有紅牌。' },
  ann: { name: 'Ann Putnam', title: '少女', desc: '由你發起審判時，先抽 2 張牌，這回合就能使用。' },
  cotton: { name: 'Cotton Mather', title: '部長', desc: '別人對你打出的證據只算 1 點。' },
  giles: { name: 'Giles Corey', title: '地主', desc: '抽牌時若抽到 2 張指控，展示後再抽 1 張。' },
  george: { name: 'George Burroughs', title: '大力士', desc: '要累積 8 點指控才能審判你。' },
  proctor: { name: 'John Proctor', title: '農民', desc: '有玩家死亡時，從他的手牌挑最多 3 張收下，其餘丟棄。' },
  martha: { name: 'Martha Corey', title: '裁縫', desc: '複製右手邊第一位存活玩家的能力。' },
  mary: { name: 'Mary Warren', title: '女僕', desc: '黑貓與情侶對你無效。' },
  rebecca: { name: 'Rebecca Nurse', title: '家庭主婦', desc: '其他人因指控被翻開審判牌時，你抽 1 張牌。' },
  parris: { name: 'Samuel Parris', title: '牧師', desc: '全場 2 次：抽牌時改從棄牌堆選最多 2 張非黑牌。' },
  sarah: { name: 'Sarah Good', title: '乞丐', desc: '搶劫、縱火對你無效。' },
  danforth: { name: 'Thomas Danforth', title: '法官', desc: '你打出的指控累積到 6 點就能審判。' },
  tituba: { name: 'Tituba', title: '說書人', desc: '全場 1 次：抽牌前查看並任意重排牌堆。' },
  griggs: { name: 'Will Griggs', title: '醫生', desc: '你的辯護可以當作目擊（7 點）打出。' },
  phips: { name: 'William Phips', title: '官員', desc: '全場 1 次：夜晚自首時不必翻開審判牌。' },
};

export const ROLE_IDS = Object.keys(ROLES) as RoleId[];

export const ABILITY_LIMIT: Record<LimitedAbility, number> = { parris: 2, tituba: 1, phips: 1 };

/** Players at or below this count are dealt 2 characters and keep 1 */
export const ROLE_CHOICE_MAX_PLAYERS = 7;
