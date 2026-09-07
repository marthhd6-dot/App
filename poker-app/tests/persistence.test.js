// tests/persistence.test.js
// Ausführen mit: npm test  (nutzt nur Node's eingebautes assert, kein Framework nötig)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSnapshot, saveSnapshot } = require('../src/persistence');

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

function tempFilePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poker-persist-')), 'rooms.db');
}

run('loadSnapshot gibt ein leeres Objekt zurück, wenn die Datei noch nicht existiert', () => {
  const file = tempFilePath(); // Verzeichnis existiert, Datenbankdatei selbst noch nicht
  assert.deepStrictEqual(loadSnapshot(file), {});
});

run('loadSnapshot gibt ein leeres Objekt zurück, wenn der Ordner nicht existiert', () => {
  const file = path.join(os.tmpdir(), 'poker-persist-does-not-exist', 'rooms.db');
  assert.deepStrictEqual(loadSnapshot(file), {});
});

run('loadSnapshot gibt bei einer beschädigten Datenbankdatei ein leeres Objekt zurück statt zu crashen', () => {
  const file = tempFilePath();
  fs.writeFileSync(file, 'das ist keine SQLite-Datei');
  assert.deepStrictEqual(loadSnapshot(file), {});
});

run('saveSnapshot + loadSnapshot: Round-Trip erhält den Inhalt exakt', () => {
  const file = tempFilePath();
  const snapshot = {
    ABCD: {
      smallBlind: 5,
      bigBlind: 10,
      dealerIndex: 1,
      players: [
        { name: 'Alice', chips: 990 },
        { name: 'Bob', chips: 1010 },
      ],
    },
  };
  saveSnapshot(file, snapshot);
  assert.deepStrictEqual(loadSnapshot(file), snapshot);
});

run('saveSnapshot ersetzt einen vorherigen Snapshot vollständig (kein Datenmüll von früheren Räumen)', () => {
  const file = tempFilePath();
  saveSnapshot(file, {
    OLD1: { smallBlind: 5, bigBlind: 10, dealerIndex: 0, players: [{ name: 'Alt', chips: 500 }] },
  });
  saveSnapshot(file, {
    NEW1: { smallBlind: 5, bigBlind: 10, dealerIndex: 0, players: [{ name: 'Neu', chips: 1000 }] },
  });

  const restored = loadSnapshot(file);
  assert.deepStrictEqual(Object.keys(restored), ['NEW1']);
});

run('saveSnapshot legt fehlende Verzeichnisse automatisch an', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-persist-'));
  const file = path.join(dir, 'nested', 'deeper', 'rooms.db');
  saveSnapshot(file, { X: { smallBlind: 5, bigBlind: 10, dealerIndex: 0, players: [] } });
  assert.strictEqual(fs.existsSync(file), true);
});

console.log('\nAlle Tests durchgelaufen.');
