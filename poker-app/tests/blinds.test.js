// tests/blinds.test.js
// Ausführen mit: npm test  (nutzt nur Node's eingebautes assert, kein Framework nötig)

const assert = require('assert');
const { blindsForHandsPlayed, RANKED_MAX_SMALL_BLIND } = require('../src/blinds');

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

run('blindsForHandsPlayed: startet bei 5/10 für die ersten beiden Hände', () => {
  assert.deepStrictEqual(blindsForHandsPlayed(0), { smallBlind: 5, bigBlind: 10 });
  assert.deepStrictEqual(blindsForHandsPlayed(1), { smallBlind: 5, bigBlind: 10 });
});

run('blindsForHandsPlayed: verdoppelt sich alle 2 Hände', () => {
  assert.deepStrictEqual(blindsForHandsPlayed(2), { smallBlind: 10, bigBlind: 20 });
  assert.deepStrictEqual(blindsForHandsPlayed(3), { smallBlind: 10, bigBlind: 20 });
  assert.deepStrictEqual(blindsForHandsPlayed(4), { smallBlind: 20, bigBlind: 40 });
  assert.deepStrictEqual(blindsForHandsPlayed(5), { smallBlind: 20, bigBlind: 40 });
  assert.deepStrictEqual(blindsForHandsPlayed(6), { smallBlind: 40, bigBlind: 80 });
  assert.deepStrictEqual(blindsForHandsPlayed(7), { smallBlind: 40, bigBlind: 80 });
  assert.deepStrictEqual(blindsForHandsPlayed(8), { smallBlind: 80, bigBlind: 160 });
  assert.deepStrictEqual(blindsForHandsPlayed(9), { smallBlind: 80, bigBlind: 160 });
});

run('blindsForHandsPlayed: deckelt bei 160/320 und bleibt danach konstant', () => {
  assert.deepStrictEqual(blindsForHandsPlayed(10), { smallBlind: 160, bigBlind: 320 });
  assert.deepStrictEqual(blindsForHandsPlayed(11), { smallBlind: 160, bigBlind: 320 });
  assert.deepStrictEqual(blindsForHandsPlayed(50), { smallBlind: 160, bigBlind: 320 });
  assert.deepStrictEqual(blindsForHandsPlayed(1000), { smallBlind: 160, bigBlind: 320 });
  assert.strictEqual(blindsForHandsPlayed(1000).smallBlind, RANKED_MAX_SMALL_BLIND);
});

run('blindsForHandsPlayed: negative Werte werden wie 0 behandelt', () => {
  assert.deepStrictEqual(blindsForHandsPlayed(-5), { smallBlind: 5, bigBlind: 10 });
});

console.log('\nAlle Tests durchgelaufen.');
