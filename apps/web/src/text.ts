import type { CardType, TryalKind } from '@salem/engine';

export const CARD_DESC: Record<CardType, string> = {
  accusation: '對一名玩家放 1 點指控。累積 7 點就翻開他一張審判牌。',
  evidence: '對一名玩家放 3 點指控。',
  witness: '對一名玩家放 7 點指控，立刻審判。',
  alibi: '移除一名玩家身上最多 3 張指控（沒有指控時改移除 1 張證據）。',
  arson: '燒掉一名玩家的所有手牌。',
  curse: '棄掉一名玩家面前的一張藍牌。先選詛咒，再點那張藍牌。',
  robbery: '把一名玩家的所有手牌交給另一名玩家。依序點兩位玩家。',
  scapegoat: '把一名玩家面前的紅牌、藍牌全部轉給另一名玩家。依序點兩位玩家。',
  stocks: '拘留：讓一名玩家跳過下一個回合。',
  matchmaker: '情侶：兩張分別放在兩人面前後，一人死亡另一人也會死。',
  asylum: '避難：持有者在夜晚不會被女巫殺死。',
  piety: '信徒：其他人不能對持有者打紅牌。',
  black_cat: '黑貓：抽到傳染時，持有者會先被翻開一張審判牌。',
  night: '夜晚降臨。',
  conspiracy: '傳染：每人從左手邊玩家拿走一張審判牌。',
};

export const TRYAL_LABEL: Record<TryalKind, string> = {
  witch: '巫',
  constable: '警',
  not_a_witch: '民',
};

export const TRYAL_FULL: Record<TryalKind, string> = {
  witch: '女巫',
  constable: '警長',
  not_a_witch: '平民',
};
