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
}

module.exports = { RoomManager, generateCode, CODE_LENGTH, CODE_CHARS };
