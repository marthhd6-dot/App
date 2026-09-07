// src/rooms.js
// Verwaltet mehrere Poker-Tische gleichzeitig, jeweils über einen kurzen
// Raum-Code erreichbar. Reine In-Memory-Verwaltung ohne Bezug zu Sockets,
// damit sie unabhängig testbar bleibt.

const { Table } = require('./game/table');

// Ohne leicht verwechselbare Zeichen (I, O, 0, 1)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

class RoomManager {
  constructor() {
    this.tables = new Map(); // code -> Table
  }

  createRoom({ smallBlind = 5, bigBlind = 10 } = {}) {
    let code;
    do {
      code = generateCode();
    } while (this.tables.has(code));
    this.tables.set(code, new Table({ smallBlind, bigBlind }));
    return code;
  }

  getTable(code) {
    return this.tables.get(code);
  }

  roomExists(code) {
    return this.tables.has(code);
  }

  removeRoom(code) {
    this.tables.delete(code);
  }

  // Baut einen Raum aus einem gespeicherten Snapshot wieder auf (siehe
  // exportSnapshot()). Spieler werden ohne echte Socket-Verbindung als
  // "disconnected" angelegt – sie kommen über den normalen Reconnect-Weg
  // (join-room mit demselben Namen) zurück an ihren Platz.
  restoreRoom(code, { smallBlind = 5, bigBlind = 10, dealerIndex = 0, players = [] } = {}) {
    const table = new Table({ smallBlind, bigBlind });
    players.forEach((p, i) => {
      const placeholderId = `restored:${code}:${i}`;
      table.addPlayer(placeholderId, p.name, p.chips);
      table.markDisconnected(placeholderId);
    });
    table.dealerIndex = players.length > 0 ? dealerIndex % players.length : 0;
    table._firstHandDealt = players.length > 0;
    this.tables.set(code, table);
  }

  // Baut mehrere Räume auf einmal aus einem zuvor mit exportSnapshot()
  // erzeugten Objekt wieder auf.
  restoreSnapshot(snapshot) {
    for (const [code, roomData] of Object.entries(snapshot || {})) {
      this.restoreRoom(code, roomData);
    }
  }

  // Reduziert alle Räume auf das, was einen Neustart sinnvoll überleben
  // kann: Name, Chips, Blinds und Dealer-Position. Eine laufende Hand
  // (Karten, Einsätze, Phase) wird bewusst nicht mit gespeichert.
  exportSnapshot() {
    const snapshot = {};
    for (const [code, table] of this.tables.entries()) {
      snapshot[code] = {
        smallBlind: table.smallBlind,
        bigBlind: table.bigBlind,
        dealerIndex: table.dealerIndex,
        players: table.players.map((p) => ({ name: p.name, chips: p.chips })),
      };
    }
    return snapshot;
  }
}

module.exports = { RoomManager, generateCode, CODE_LENGTH, CODE_CHARS };
