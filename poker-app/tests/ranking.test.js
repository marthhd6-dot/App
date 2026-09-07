// tests/ranking.test.js
// Ausführen mit: npm test  (nutzt nur Node's eingebautes assert, kein Framework nötig)

const assert = require('assert');
const {
  RANK_TIERS,
  STARTING_RATING,
  tierForRating,
  expectedScore,
  applyMatchResult,
  matchTolerance,
  findMatchmakingPair,
} = require('../src/ranking');

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

run('matchTolerance wächst mit der Wartezeit und ist nie negativ', () => {
  assert.strictEqual(matchTolerance(0), 100);
  assert.strictEqual(matchTolerance(10_000), 250); // 100 + 10s * 15/s
  assert.strictEqual(matchTolerance(-5000), 100); // negative Wartezeit wird wie 0 behandelt
});

run('findMatchmakingPair: leere oder einelementige Warteschlange ergibt kein Paar', () => {
  assert.strictEqual(findMatchmakingPair([]), null);
  assert.strictEqual(findMatchmakingPair([{ rating: 1000, joinedAt: 0 }], 0), null);
});

run('findMatchmakingPair: ähnliche Ratings werden sofort gepaart', () => {
  const now = 1_000_000;
  const queue = [
    { rating: 1000, joinedAt: now },
    { rating: 1050, joinedAt: now },
  ];
  assert.deepStrictEqual(findMatchmakingPair(queue, now), [0, 1]);
});

run('findMatchmakingPair: großer Rating-Unterschied wird ohne Wartezeit noch nicht gepaart', () => {
  const now = 1_000_000;
  const queue = [
    { rating: 300, joinedAt: now },
    { rating: 2000, joinedAt: now },
  ];
  assert.strictEqual(findMatchmakingPair(queue, now), null);
});

run('findMatchmakingPair: derselbe große Unterschied wird nach genug Wartezeit gepaart', () => {
  const joinedAt = 0;
  const now = 200_000; // 200s gewartet -> Toleranz 100 + 200*15 = 3100, deckt 1700 locker ab
  const queue = [
    { rating: 300, joinedAt },
    { rating: 2000, joinedAt },
  ];
  assert.deepStrictEqual(findMatchmakingPair(queue, now), [0, 1]);
});

run('findMatchmakingPair: wählt unter mehreren möglichen Gegnern den mit dem ähnlichsten Rating', () => {
  const now = 1_000_000;
  const queue = [
    { rating: 1000, joinedAt: now }, // sucht einen Gegner
    { rating: 1090, joinedAt: now }, // Unterschied 90
    { rating: 1030, joinedAt: now }, // Unterschied 30 -> sollte gewählt werden
  ];
  assert.deepStrictEqual(findMatchmakingPair(queue, now), [0, 2]);
});

run('findMatchmakingPair: hat der am längsten Wartende keinen Partner, werden trotzdem andere gepaart', () => {
  const now = 1_000_000;
  const queue = [
    { rating: 3000, joinedAt: now }, // passt zu niemandem
    { rating: 1000, joinedAt: now },
    { rating: 1050, joinedAt: now },
  ];
  assert.deepStrictEqual(findMatchmakingPair(queue, now), [1, 2]);
});

console.log('\nAlle Tests durchgelaufen.');
