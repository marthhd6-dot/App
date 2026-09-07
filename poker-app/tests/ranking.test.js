// tests/ranking.test.js
// Ausführen mit: npm test  (nutzt nur Node's eingebautes assert, kein Framework nötig)

const assert = require('assert');
const { RANK_TIERS, STARTING_RATING, tierForRating, expectedScore, applyMatchResult } = require('../src/ranking');

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

run('tierForRating ordnet Ratings den richtigen Rängen zu', () => {
  assert.strictEqual(tierForRating(0), 'Bronze');
  assert.strictEqual(tierForRating(499), 'Bronze');
  assert.strictEqual(tierForRating(500), 'Silber');
  assert.strictEqual(tierForRating(999), 'Silber');
  assert.strictEqual(tierForRating(1000), 'Gold');
  assert.strictEqual(tierForRating(1499), 'Gold');
  assert.strictEqual(tierForRating(1500), 'Platin');
  assert.strictEqual(tierForRating(1999), 'Platin');
  assert.strictEqual(tierForRating(2000), 'Diamant');
  assert.strictEqual(tierForRating(2499), 'Diamant');
  assert.strictEqual(tierForRating(2500), 'Champion');
  assert.strictEqual(tierForRating(9999), 'Champion');
});

run('Neue Spieler starten mit STARTING_RATING solide in Bronze', () => {
  assert.strictEqual(tierForRating(STARTING_RATING), 'Bronze');
});

run('RANK_TIERS ist aufsteigend sortiert (Bronze zuerst, Champion zuletzt)', () => {
  assert.strictEqual(RANK_TIERS[0].name, 'Bronze');
  assert.strictEqual(RANK_TIERS[RANK_TIERS.length - 1].name, 'Champion');
  for (let i = 1; i < RANK_TIERS.length; i++) {
    assert.ok(RANK_TIERS[i].min > RANK_TIERS[i - 1].min);
  }
});

run('expectedScore ist bei gleichem Rating exakt 0.5 und symmetrisch', () => {
  assert.strictEqual(expectedScore(1000, 1000), 0.5);
  const a = expectedScore(1200, 1000);
  const b = expectedScore(1000, 1200);
  assert.ok(a > 0.5); // der Favorit gewinnt öfter
  assert.ok(Math.abs(a + b - 1) < 1e-9); // Wahrscheinlichkeiten ergänzen sich zu 1
});

run('applyMatchResult: Sieg gegen einen gleich starken Gegner bringt +16/-16 (halber K-Faktor)', () => {
  const { winnerRating, loserRating } = applyMatchResult(1000, 1000);
  assert.strictEqual(winnerRating, 1016);
  assert.strictEqual(loserRating, 984);
});

run('applyMatchResult: Der Außenseiter gewinnt mehr Punkte als der Favorit bei einem Sieg', () => {
  const underdogWins = applyMatchResult(900, 1100); // Rating 900 schlägt Rating 1100
  const favoriteWins = applyMatchResult(1100, 900); // Rating 1100 schlägt Rating 900
  const underdogGain = underdogWins.winnerRating - 900;
  const favoriteGain = favoriteWins.winnerRating - 1100;
  assert.ok(underdogGain > favoriteGain);
});

run('applyMatchResult: Rating fällt nie unter 0', () => {
  const { loserRating } = applyMatchResult(1000, 5);
  assert.ok(loserRating >= 0);
});

console.log('\nAlle Tests durchgelaufen.');
