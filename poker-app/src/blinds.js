// src/blinds.js
// Blind-Zeitplan für Ranked-Matches: Turnier-artig steigende Blinds statt
// fixer Blinds wie an einem Casual-Tisch. Reine Funktion ohne Bezug zu
// Sockets oder Tisch-Zustand, damit sie unabhängig testbar bleibt.

const RANKED_INITIAL_SMALL_BLIND = 5;
const RANKED_MAX_SMALL_BLIND = 160; // -> Big Blind 320
const RANKED_BLIND_INCREASE_EVERY_HANDS = 2;

// Verdoppelt die Blinds alle RANKED_BLIND_INCREASE_EVERY_HANDS Hände,
// startend bei RANKED_INITIAL_SMALL_BLIND, gedeckelt bei
// RANKED_MAX_SMALL_BLIND (Big Blind ist immer das Doppelte des Small
// Blind). handsPlayed zählt die in diesem Match bereits gestarteten Hände
// (0 = vor der ersten Hand).
function blindsForHandsPlayed(handsPlayed) {
  const level = Math.floor(Math.max(0, handsPlayed) / RANKED_BLIND_INCREASE_EVERY_HANDS);
  const smallBlind = Math.min(RANKED_INITIAL_SMALL_BLIND * 2 ** level, RANKED_MAX_SMALL_BLIND);
  return { smallBlind, bigBlind: smallBlind * 2 };
}

module.exports = {
  RANKED_INITIAL_SMALL_BLIND,
  RANKED_MAX_SMALL_BLIND,
  RANKED_BLIND_INCREASE_EVERY_HANDS,
  blindsForHandsPlayed,
};
