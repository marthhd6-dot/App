// src/persistence.js
// Speichert und lädt einen Raum-Snapshot als JSON-Datei, damit Chip-Stände
// einen Server-Neustart überleben. Bewusst einfach gehalten (keine
// Datenbank nötig): eine JSON-Datei reicht für einen Heim-Tisch locker aus.
//
// Persistiert wird nur, was einen Neustart sinnvoll überleben kann: Name,
// Chips, Blinds und Dealer-Position pro Raum. Eine laufende Hand (Karten,
// Einsätze, Phase) wird bewusst NICHT gespeichert – nach einem Neustart
// müssen Spieler eine neue Hand starten, behalten aber ihre Chips.

const fs = require('fs');
const path = require('path');

function loadSnapshot(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Konnte gespeicherten Zustand nicht laden (${filePath}):`, err.message);
    }
    return {};
  }
}

function saveSnapshot(filePath, snapshot) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  } catch (err) {
    console.error(`Konnte Zustand nicht speichern (${filePath}):`, err.message);
  }
}

module.exports = { loadSnapshot, saveSnapshot };
