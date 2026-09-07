// src/game/handEvaluator.js
// Bewertet Poker-Hände. Nimmt 2 Hole Cards + bis zu 5 Community Cards
// und findet die beste 5-Karten-Kombination.

const HAND_RANKS = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
  ROYAL_FLUSH: 9,
};

const HAND_NAMES = {
  0: 'High Card',
  1: 'Pair',
  2: 'Two Pair',
  3: 'Three of a Kind',
  4: 'Straight',
  5: 'Flush',
  6: 'Full House',
  7: 'Four of a Kind',
  8: 'Straight Flush',
  9: 'Royal Flush',
};

// Alle Kombinationen von k Elementen aus einem Array
function combinations(arr, k) {
  const results = [];
  function helper(start, combo) {
    if (combo.length === k) {
      results.push([...combo]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return results;
}

function rankCounts(cards) {
  const map = {};
  for (const c of cards) map[c.rank] = (map[c.rank] || 0) + 1;
  return map;
}

function isFlush(cards) {
  return cards.every((c) => c.suit === cards[0].suit);
}

// Gibt die höchste Karte einer Straße zurück, oder null wenn keine Straße
function straightHighCard(cards) {
  const ranks = [...new Set(cards.map((c) => c.rank))].sort((a, b) => b - a);
  // Ass kann auch als 1 zählen (A-2-3-4-5)
  if (ranks.includes(14)) ranks.push(1);
  for (let i = 0; i <= ranks.length - 5; i++) {
    if (ranks[i] - ranks[i + 4] === 4) {
      return ranks[i] === 1 ? 5 : ranks[i]; // Rad (A-5) zählt als 5-hoch
    }
  }
  return null;
}

// Bewertet genau 5 Karten. Gibt { rank, name, tiebreakers } zurück.
// tiebreakers ist ein Array, das lexikographisch verglichen werden kann.
function evaluate5(cards) {
  const counts = rankCounts(cards);
  const flush = isFlush(cards);
  const straightHigh = straightHighCard(cards);

  const grouped = Object.entries(counts)
    .map(([rank, count]) => ({ rank: Number(rank), count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  const countPattern = grouped.map((g) => g.count).join('');
  const tiebreak = grouped.map((g) => g.rank);

  if (flush && straightHigh === 14 && cards.some((c) => c.rank === 14)) {
    // Prüfen ob es wirklich Royal ist (10-J-Q-K-A)
    const ranks = cards.map((c) => c.rank).sort((a, b) => a - b);
    if (ranks.join(',') === '10,11,12,13,14') {
      return { rank: HAND_RANKS.ROYAL_FLUSH, name: HAND_NAMES[9], tiebreakers: [14] };
    }
  }
  if (flush && straightHigh) {
    return { rank: HAND_RANKS.STRAIGHT_FLUSH, name: HAND_NAMES[8], tiebreakers: [straightHigh] };
  }
  if (countPattern === '41') {
    return { rank: HAND_RANKS.FOUR_OF_A_KIND, name: HAND_NAMES[7], tiebreakers: tiebreak };
  }
  if (countPattern === '32') {
    return { rank: HAND_RANKS.FULL_HOUSE, name: HAND_NAMES[6], tiebreakers: tiebreak };
  }
  if (flush) {
    const sorted = cards.map((c) => c.rank).sort((a, b) => b - a);
    return { rank: HAND_RANKS.FLUSH, name: HAND_NAMES[5], tiebreakers: sorted };
  }
  if (straightHigh) {
    return { rank: HAND_RANKS.STRAIGHT, name: HAND_NAMES[4], tiebreakers: [straightHigh] };
  }
  if (countPattern === '311') {
    return { rank: HAND_RANKS.THREE_OF_A_KIND, name: HAND_NAMES[3], tiebreakers: tiebreak };
  }
  if (countPattern === '221') {
    return { rank: HAND_RANKS.TWO_PAIR, name: HAND_NAMES[2], tiebreakers: tiebreak };
  }
  if (countPattern === '2111') {
    return { rank: HAND_RANKS.PAIR, name: HAND_NAMES[1], tiebreakers: tiebreak };
  }
  const sorted = cards.map((c) => c.rank).sort((a, b) => b - a);
  return { rank: HAND_RANKS.HIGH_CARD, name: HAND_NAMES[0], tiebreakers: sorted };
}

function compareHands(a, b) {
  if (a.rank !== b.rank) return b.rank - a.rank; // höherer rank gewinnt
  for (let i = 0; i < Math.max(a.tiebreakers.length, b.tiebreakers.length); i++) {
    const av = a.tiebreakers[i] || 0;
    const bv = b.tiebreakers[i] || 0;
    if (av !== bv) return bv - av;
  }
  return 0; // exaktes Unentschieden (Split Pot)
}

// Nimmt 2 Hole Cards + 0-5 Community Cards, findet beste 5-Karten-Hand
function bestHand(holeCards, communityCards) {
  const allCards = [...holeCards, ...communityCards];
  if (allCards.length < 5) {
    throw new Error('Mindestens 5 Karten nötig, um eine Hand zu bewerten.');
  }
  const combos = combinations(allCards, 5);
  let best = null;
  for (const combo of combos) {
    const evaluated = evaluate5(combo);
    if (!best || compareHands(evaluated, best) < 0) {
      best = evaluated;
    }
  }
  return best;
}

// Ermittelt Gewinner unter mehreren Spielern. Gibt Array der Sieger-Indizes zurück (>1 bei Split Pot).
function determineWinners(players, communityCards) {
  const results = players.map((p) => bestHand(p.holeCards, communityCards));
  let bestResult = results[0];
  for (const r of results) {
    if (compareHands(r, bestResult) < 0) bestResult = r;
  }
  const winnerIndexes = [];
  results.forEach((r, i) => {
    if (compareHands(r, bestResult) === 0) winnerIndexes.push(i);
  });
  return { winnerIndexes, results };
}

module.exports = {
  HAND_RANKS,
  HAND_NAMES,
  evaluate5,
  bestHand,
  compareHands,
  determineWinners,
  combinations,
};
