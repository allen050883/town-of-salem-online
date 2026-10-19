import type { CardColor, CardType } from './types';

export const CARD_COLOR: Record<CardType, CardColor> = {
  accusation: 'red',
  evidence: 'red',
  witness: 'red',
  alibi: 'green',
  arson: 'green',
  curse: 'green',
  robbery: 'green',
  scapegoat: 'green',
  stocks: 'blue',
  matchmaker: 'blue',
  asylum: 'blue',
  piety: 'blue',
  black_cat: 'blue',
  night: 'black',
  conspiracy: 'black',
};

/** Traditional Chinese edition names */
export const CARD_NAME: Record<CardType, string> = {
  accusation: '指控',
  evidence: '證據',
  witness: '目擊',
  alibi: '辯護',
  arson: '縱火',
  curse: '詛咒',
  robbery: '搶劫',
  scapegoat: '嫁禍',
  stocks: '拘留',
  matchmaker: '情侶',
  asylum: '避難',
  piety: '信徒',
  black_cat: '黑貓',
  night: '夜晚',
  conspiracy: '傳染',
};

export const ACCUSATION_VALUE: Partial<Record<CardType, number>> = {
  accusation: 1,
  evidence: 3,
  witness: 7,
};

export const ACCUSATION_THRESHOLD = 7;

/**
 * Card counts for the shuffled play deck (excludes the black cat, night and conspiracy, which are handled separately).
 * Totals 61 including those three, matching the Traditional Chinese edition.
 * TODO: verify each count against a physical copy; only accusation 35 is confirmed by more than one source.
 */
export const DECK_COUNTS: Partial<Record<CardType, number>> = {
  accusation: 35,
  evidence: 6,
  witness: 1,
  alibi: 3,
  arson: 1,
  curse: 1,
  robbery: 1,
  scapegoat: 2,
  stocks: 3,
  matchmaker: 2,
  asylum: 1,
  piety: 2,
};

export function isRed(t: CardType) {
  return CARD_COLOR[t] === 'red';
}

export function isBlue(t: CardType) {
  return CARD_COLOR[t] === 'blue';
}

/** Cards that can't be played when only 2 players remain (treated as blue cards) */
export function isDisabledInEndgame(t: CardType) {
  return isBlue(t) || t === 'scapegoat' || t === 'robbery';
}
