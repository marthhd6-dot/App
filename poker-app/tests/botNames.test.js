// tests/botNames.test.js
// Ausführen mit: npm test  (nutzt nur Node's eingebautes assert, kein Framework nötig)

const assert = require('assert');
const { BOT_NAME_POOL, pickBotNames } = require('../src/botNames');

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

run('pickBotNames: liefert die verlangte Anzahl an Namen', () => {
  assert.strictEqual(pickBotNames(1).length, 1);
  assert.strictEqual(pickBotNames(3).length, 3);
});

run('pickBotNames: alle gelieferten Namen kommen aus dem Pool', () => {
  const names = pickBotNames(3);
  names.forEach((n) => assert.ok(BOT_NAME_POOL.includes(n), `${n} sollte im Pool sein`));
});

run('pickBotNames: liefert bei einem Aufruf keine doppelten Namen', () => {
  const names = pickBotNames(3);
  assert.strictEqual(new Set(names).size, 3);
});

run('pickBotNames: schließt übergebene Namen aus', () => {
  const names = pickBotNames(5, ['Nico92', 'LeaM']);
  assert.ok(!names.includes('Nico92'));
  assert.ok(!names.includes('LeaM'));
});

run('pickBotNames: bleibt eindeutig, auch wenn count größer als der Pool ist', () => {
  const names = pickBotNames(BOT_NAME_POOL.length + 5);
  assert.strictEqual(names.length, BOT_NAME_POOL.length + 5);
  assert.strictEqual(new Set(names).size, names.length);
});

console.log('\nAlle Tests durchgelaufen.');
