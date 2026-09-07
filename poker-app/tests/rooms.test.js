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

console.log('\nAlle Tests durchgelaufen.');
