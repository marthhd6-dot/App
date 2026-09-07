// src/persistence.js
// Speichert und lädt einen Raum-Snapshot in einer SQLite-Datei (via
// better-sqlite3, synchron, keine externe Datenbank-Infrastruktur nötig),
// damit Chip-Stände einen Server-Neustart überleben.
//
// Persistiert wird nur, was einen Neustart sinnvoll überleben kann: Name,
// Chips, Blinds und Dealer-Position pro Raum. Eine laufende Hand (Karten,
// Einsätze, Phase) wird bewusst NICHT gespeichert – nach einem Neustart
// müssen Spieler eine neue Hand starten, behalten aber ihre Chips.
//
// loadSnapshot()/saveSnapshot() haben bewusst dieselbe Signatur wie die
// vorherige JSON-Datei-Version, damit rooms.js und server.js unverändert
// bleiben konnten.
//
// Zusätzlich verwaltet diese Datei die player_ranks-Tabelle für den
// 1v1-Ranked-Modus (siehe ranking.js): Rating und Sieg/Niederlage-Zähler
// je Spielername, dauerhaft über Neustarts hinweg.
//
// Und die users-Tabelle für echte Accounts mit festem Nutzernamen (siehe
// server.js#register-account/login-account): Passwörter werden nie im
// Klartext gespeichert, sondern per crypto.scrypt gehasht (Node-Bordmittel,
// keine zusätzliche Abhängigkeit nötig) mit einem pro Account zufälligen
// Salt.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    small_blind INTEGER NOT NULL,
    big_blind INTEGER NOT NULL,
    dealer_index INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS players (
    room_code TEXT NOT NULL,
    seat INTEGER NOT NULL,
    name TEXT NOT NULL,
    chips INTEGER NOT NULL,
    PRIMARY KEY (room_code, seat)
  );
  CREATE TABLE IF NOT EXISTS player_ranks (
    name TEXT PRIMARY KEY,
    rating INTEGER NOT NULL,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

// Eine Verbindung pro Dateipfad wird wiederverwendet, statt bei jedem
// Speichern/Laden neu zu öffnen (spart Overhead bei sehr häufigem Speichern).
const connections = new Map();

function getConnection(filePath) {
  let db = connections.get(filePath);
  if (db) return db;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  connections.set(filePath, db);
  return db;
}

function loadSnapshot(filePath) {
  try {
    const db = getConnection(filePath);
    const rooms = db.prepare('SELECT code, small_blind, big_blind, dealer_index FROM rooms').all();
    const players = db.prepare('SELECT room_code, name, chips FROM players ORDER BY room_code, seat').all();

    const snapshot = {};
    for (const room of rooms) {
      snapshot[room.code] = {
        smallBlind: room.small_blind,
        bigBlind: room.big_blind,
        dealerIndex: room.dealer_index,
        players: [],
      };
    }
    for (const p of players) {
      snapshot[p.room_code]?.players.push({ name: p.name, chips: p.chips });
    }
    return snapshot;
  } catch (err) {
    console.error(`Konnte gespeicherten Zustand nicht laden (${filePath}):`, err.message);
    return {};
  }
}

function saveSnapshot(filePath, snapshot) {
  try {
    const db = getConnection(filePath);
    const insertRoom = db.prepare(
      'INSERT INTO rooms (code, small_blind, big_blind, dealer_index) VALUES (?, ?, ?, ?)'
    );
    const insertPlayer = db.prepare('INSERT INTO players (room_code, seat, name, chips) VALUES (?, ?, ?, ?)');

    // Kompletter Ersatz statt Diff: Bei der überschaubaren Größe eines
    // Heim-Tisch-Snapshots ist "alles löschen, alles neu einfügen" einfacher
    // und robuster als Änderungen nachzuverfolgen. Läuft in einer Transaktion,
    // damit ein Absturz mitten im Speichern nie einen halb geschriebenen
    // Zustand hinterlässt.
    const writeAll = db.transaction((snap) => {
      db.prepare('DELETE FROM players').run();
      db.prepare('DELETE FROM rooms').run();
      for (const [code, room] of Object.entries(snap)) {
        insertRoom.run(code, room.smallBlind, room.bigBlind, room.dealerIndex);
        room.players.forEach((p, seat) => {
          insertPlayer.run(code, seat, p.name, p.chips);
        });
      }
    });
    writeAll(snapshot);
  } catch (err) {
    console.error(`Konnte Zustand nicht speichern (${filePath}):`, err.message);
  }
}

// Liest Rating/Sieg-Niederlage-Zähler eines Spielers, oder null, wenn er
// noch nie gespeichert wurde (der Aufrufer entscheidet dann über den
// Startwert, siehe ranking.js#STARTING_RATING).
function getPlayerRank(filePath, name) {
  try {
    const db = getConnection(filePath);
    return db.prepare('SELECT rating, wins, losses FROM player_ranks WHERE name = ?').get(name) || null;
  } catch (err) {
    console.error(`Konnte Rang nicht laden (${filePath}):`, err.message);
    return null;
  }
}

function savePlayerRank(filePath, name, { rating, wins, losses }) {
  try {
    const db = getConnection(filePath);
    db.prepare(
      `INSERT INTO player_ranks (name, rating, wins, losses) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET rating = excluded.rating, wins = excluded.wins, losses = excluded.losses`
    ).run(name, rating, wins, losses);
  } catch (err) {
    console.error(`Konnte Rang nicht speichern (${filePath}):`, err.message);
  }
}

// Top-Spieler nach Rating absteigend, für eine einfache Bestenliste.
function getLeaderboard(filePath, limit = 20) {
  try {
    const db = getConnection(filePath);
    return db.prepare('SELECT name, rating, wins, losses FROM player_ranks ORDER BY rating DESC LIMIT ?').all(limit);
  } catch (err) {
    console.error(`Konnte Bestenliste nicht laden (${filePath}):`, err.message);
    return [];
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

// Legt einen neuen Account an. Nutzernamen sind case-insensitive eindeutig
// (damit "Anna" und "anna" nicht denselben Ranked-Namen doppelt
// beanspruchen können) – gibt bei einem bereits vergebenen Namen false
// zurück, sonst true.
function createUser(filePath, username, password) {
  try {
    const db = getConnection(filePath);
    const existing = db.prepare('SELECT username FROM users WHERE lower(username) = lower(?)').get(username);
    if (existing) return false;
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    db.prepare('INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)').run(
      username,
      passwordHash,
      salt,
      Date.now()
    );
    return true;
  } catch (err) {
    console.error(`Konnte Account nicht anlegen (${filePath}):`, err.message);
    return false;
  }
}

// Prüft Nutzername + Passwort per zeitkonstantem Vergleich (verhindert
// Timing-Angriffe auf den Hash-Vergleich). Gibt bei Erfolg den exakt
// gespeicherten Nutzernamen zurück (mit ursprünglicher Groß-/
// Kleinschreibung, unabhängig davon, wie er beim Login eingegeben wurde),
// sonst null.
function verifyUser(filePath, username, password) {
  try {
    const db = getConnection(filePath);
    const row = db
      .prepare('SELECT username, password_hash, salt FROM users WHERE lower(username) = lower(?)')
      .get(username);
    if (!row) return null;
    const candidateHash = Buffer.from(hashPassword(password, row.salt), 'hex');
    const storedHash = Buffer.from(row.password_hash, 'hex');
    if (candidateHash.length !== storedHash.length || !crypto.timingSafeEqual(candidateHash, storedHash)) {
      return null;
    }
    return row.username;
  } catch (err) {
    console.error(`Konnte Account nicht prüfen (${filePath}):`, err.message);
    return null;
  }
}

module.exports = {
  loadSnapshot,
  saveSnapshot,
  getPlayerRank,
  savePlayerRank,
  getLeaderboard,
  createUser,
  verifyUser,
};
