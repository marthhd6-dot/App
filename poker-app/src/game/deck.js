// src/game/deck.js
// Erzeugt, mischt und verteilt ein 52-Karten-Deck.
// Karte: { rank: 2-14, suit: 'S'|'H'|'D'|'C' }  (11=J, 12=Q, 13=K, 14=A)

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function rankToLabel(rank) {
  const labels = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  return labels[rank] || String(rank);
}

function suitToSymbol(suit) {
  const symbols = { S: '♠', H: '♥', D: '♦', C: '♣' };
  return symbols[suit];
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

// Fisher-Yates Shuffle
function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function draw(deck, count = 1) {
  const drawn = deck.splice(0, count);
  return { drawn, remaining: deck };
}

module.exports = {
  createDeck,
  shuffle,
  draw,
  rankToLabel,
  suitToSymbol,
};
