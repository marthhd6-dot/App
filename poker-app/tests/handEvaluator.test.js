// tests/handEvaluator.test.js
// Ausführen mit: npm test  (nutzt nur Node's eingebautes assert, kein Framework nötig)

const assert = require('assert');
const { bestHand, compareHands, determineWinners } = require('../src/game/handEvaluator');

function card(rank, suit) {
  return { rank, suit };
}

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}

run('erkennt Royal Flush', () => {
  const hole = [card(14, 'S'), card(13, 'S')];
  const community = [card(12, 'S'), card(11, 'S'), card(10, 'S'), card(2, 'H'), card(3, 'D')];
  const result = bestHand(hole, community);
  assert.strictEqual(result.name, 'Royal Flush');
});

run('erkennt Vierling', () => {
  const hole = [card(9, 'S'), card(9, 'H')];
  const community = [card(9, 'D'), card(9, 'C'), card(2, 'H'), card(5, 'D'), card(7, 'S')];
  const result = bestHand(hole, community);
  assert.strictEqual(result.name, 'Four of a Kind');
});

run('Straße schlägt Drilling', () => {
  const straightHand = bestHand(
    [card(9, 'S'), card(8, 'H')],
    [card(7, 'D'), card(6, 'C'), card(5, 'H'), card(2, 'D'), card(3, 'S')]
  );
  const tripsHand = bestHand(
    [card(4, 'S'), card(4, 'H')],
    [card(4, 'D'), card(6, 'C'), card(5, 'H'), card(2, 'D'), card(9, 'S')]
  );
  assert.ok(compareHands(straightHand, tripsHand) < 0);
});

run('A-2-3-4-5 zählt als Straße (Rad)', () => {
  const hand = bestHand(
    [card(14, 'S'), card(2, 'H')],
    [card(3, 'D'), card(4, 'C'), card(5, 'H'), card(9, 'D'), card(10, 'S')]
  );
  assert.strictEqual(hand.name, 'Straight');
});

run('determineWinners erkennt Split Pot', () => {
  const community = [card(10, 'H'), card(9, 'H'), card(8, 'H'), card(2, 'D'), card(3, 'C')];
  const players = [
    { holeCards: [card(4, 'S'), card(5, 'S')] }, // gleiche Straße über Board
    { holeCards: [card(4, 'C'), card(5, 'C')] },
  ];
  const { winnerIndexes } = determineWinners(players, community);
  assert.strictEqual(winnerIndexes.length, 2);
});

console.log('\nAlle Tests durchgelaufen.');
