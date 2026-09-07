// tests/rooms.test.js
// Ausführen mit: npm test  (nutzt nur Node's eingebautes assert, kein Framework nötig)

const assert = require('assert');
const { RoomManager, generateCode, CODE_LENGTH, CODE_CHARS } = require('../src/rooms');
const { Table } = require('../src/game/table');

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

run('generateCode erzeugt einen Code der richtigen Länge aus dem erlaubten Alphabet', () => {
  const code = generateCode();
  assert.strictEqual(code.length, CODE_LENGTH);
  for (const char of code) {
    assert.ok(CODE_CHARS.includes(char), `Zeichen "${char}" nicht im erlaubten Alphabet`);
  }
});

run('createRoom legt einen neuen Tisch an und liefert einen gültigen Code', () => {
  const rooms = new RoomManager();
  const code = rooms.createRoom();
  assert.strictEqual(code.length, CODE_LENGTH);
  assert.ok(rooms.getTable(code) instanceof Table);
  assert.strictEqual(rooms.roomExists(code), true);
});

run('createRoom reicht Blind-Optionen an den Tisch weiter', () => {
  const rooms = new RoomManager();
  const code = rooms.createRoom({ smallBlind: 1, bigBlind: 2 });
  const table = rooms.getTable(code);
  assert.strictEqual(table.smallBlind, 1);
  assert.strictEqual(table.bigBlind, 2);
});

run('Jeder createRoom-Aufruf liefert einen eigenen, unabhängigen Tisch', () => {
  const rooms = new RoomManager();
  const codeA = rooms.createRoom();
  const codeB = rooms.createRoom();
  assert.notStrictEqual(codeA, codeB);

  const tableA = rooms.getTable(codeA);
  const tableB = rooms.getTable(codeB);
  assert.notStrictEqual(tableA, tableB);

  tableA.addPlayer('p1', 'Alice');
  assert.strictEqual(tableA.players.length, 1);
  assert.strictEqual(tableB.players.length, 0);
});

run('getTable/roomExists liefern für unbekannten Code undefined/false', () => {
  const rooms = new RoomManager();
  assert.strictEqual(rooms.getTable('ZZZZ'), undefined);
  assert.strictEqual(rooms.roomExists('ZZZZ'), false);
});

run('removeRoom entfernt den Tisch wieder', () => {
  const rooms = new RoomManager();
  const code = rooms.createRoom();
  rooms.removeRoom(code);
  assert.strictEqual(rooms.roomExists(code), false);
  assert.strictEqual(rooms.getTable(code), undefined);
});

run('exportSnapshot reduziert einen Raum auf Name, Chips, Blinds und Dealer-Position', () => {
  const rooms = new RoomManager();
  const code = rooms.createRoom({ smallBlind: 1, bigBlind: 2 });
  const table = rooms.getTable(code);
  table.addPlayer('socket-a', 'Alice', 990);
  table.addPlayer('socket-b', 'Bob', 1010);
  table.dealerIndex = 1;

  const snapshot = rooms.exportSnapshot();

  assert.deepStrictEqual(snapshot[code], {
    smallBlind: 1,
    bigBlind: 2,
    dealerIndex: 1,
    players: [
      { name: 'Alice', chips: 990 },
      { name: 'Bob', chips: 1010 },
    ],
  });
});

run('restoreRoom baut einen Raum aus einem Snapshot wieder auf, Spieler sind reconnect-bereit', () => {
  const rooms = new RoomManager();
  rooms.restoreRoom('WXYZ', {
    smallBlind: 5,
    bigBlind: 10,
    dealerIndex: 1,
    players: [
      { name: 'Alice', chips: 990 },
      { name: 'Bob', chips: 1010 },
    ],
  });

  const table = rooms.getTable('WXYZ');
  assert.ok(table);
  assert.strictEqual(table.smallBlind, 5);
  assert.strictEqual(table.bigBlind, 10);
  assert.strictEqual(table.dealerIndex, 1);
  assert.strictEqual(table.players.length, 2);
  table.players.forEach((p) => assert.strictEqual(p.disconnected, true));

  // Reconnect über den Namen holt die Chips zurück
  const oldId = table.reconnectPlayer('new-socket-id', 'Bob');
  assert.ok(oldId);
  const bob = table.players.find((p) => p.name === 'Bob');
  assert.strictEqual(bob.id, 'new-socket-id');
  assert.strictEqual(bob.chips, 1010);
  assert.strictEqual(bob.disconnected, false);
});

run('exportSnapshot + restoreSnapshot: Round-Trip über mehrere Räume erhält Chips exakt', () => {
  const original = new RoomManager();
  const codeA = original.createRoom();
  original.getTable(codeA).addPlayer('a1', 'Alice', 750);
  const codeB = original.createRoom({ smallBlind: 25, bigBlind: 50 });
  original.getTable(codeB).addPlayer('b1', 'Carol', 2500);

  const snapshot = original.exportSnapshot();

  const restored = new RoomManager();
  restored.restoreSnapshot(snapshot);

  assert.strictEqual(restored.getTable(codeA).players[0].chips, 750);
  assert.strictEqual(restored.getTable(codeB).players[0].chips, 2500);
  assert.strictEqual(restored.getTable(codeB).bigBlind, 50);
});

console.log('\nAlle Tests durchgelaufen.');
