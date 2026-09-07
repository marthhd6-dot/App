// src/server.js
// Server für mehrere gleichzeitige Poker-Tische ("Räume"). Jeder Raum hat
// einen eigenen Tisch-Zustand (src/rooms.js) und wird über einen kurzen
// Code erreicht, den Spieler zum Beitreten eingeben.
//
// Zusätzlich gibt es einen 1v1-Ranked-Modus: Spieler treten einer
// Matchmaking-Warteschlange bei (statt einen Raum-Code zu teilen) und
// werden automatisch mit dem nächsten wartenden Spieler zusammengelegt.
// Der Rang (src/ranking.js) wird über den Spielernamen dauerhaft
// gespeichert (src/persistence.js) – siehe README für bekannte
// Vereinfachungen (keine echte Authentifizierung).

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');
const { loadSnapshot, saveSnapshot, getPlayerRank, savePlayerRank, getLeaderboard } = require('./persistence');
const { STARTING_RATING, tierForRating, applyMatchResult } = require('./ranking');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Wo Chip-Stände und Ränge zwischen Server-Neustarts gespeichert werden.
// Über POKER_DATA_FILE überschreibbar (z. B. für Tests, um nicht die
// echten Spielstände zu überschreiben).
const DATA_FILE = process.env.POKER_DATA_FILE || path.join(__dirname, '..', 'data', 'rooms.db');

const rooms = new RoomManager();
rooms.restoreSnapshot(loadSnapshot(DATA_FILE));

function persist() {
  saveSnapshot(DATA_FILE, rooms.exportSnapshot());
}

// Startkapital für ein Ranked-1v1-Match (bewusst kleiner als die 1000 Chips
// eines Casual-Tisches, damit ein Match zügig zu einem Ergebnis kommt).
const RANKED_STARTING_CHIPS = 200;

// Wartende Spieler für den Ranked-1v1-Modus, in Beitritts-Reihenfolge.
// Sobald zwei da sind, werden die ersten beiden sofort zusammengelegt
// (bekannte Vereinfachung: kein Rating-basiertes Matchmaking, reines FIFO).
const rankedQueue = [];
// Codes von Räumen, die aus dem Ranked-Matchmaking stammen. Nur für diese
// wird nach jeder Hand geprüft, ob das Match durch einen Bust entschieden ist.
const rankedRooms = new Set();

function getOrCreateRank(name) {
  return getPlayerRank(DATA_FILE, name) || { rating: STARTING_RATING, wins: 0, losses: 0 };
}

// Wie lange ein getrennter Spieler seinen Platz behält, bevor er endgültig
// entfernt wird. Läuft die Zeit ab, ohne dass sich jemand mit demselben
// Namen erneut verbindet, verhält es sich wie ein sofortiges Verlassen.
// Über RECONNECT_GRACE_MS überschreibbar (z. B. für Tests).
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 30_000;
// key: `${roomCode}:${socketId}` -> Timeout-Handle für den ausstehenden
// endgültigen Rauswurf dieses (getrennten) Spielers.
const disconnectTimers = new Map();

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

io.on('connection', (socket) => {
  console.log(`Spieler verbunden: ${socket.id}`);

  socket.on('create-room', ({ name } = {}) => {
    if (socket.data.roomCode) {
      socket.emit('error-message', 'Du bist bereits einem Raum beigetreten.');
      return;
    }
    const code = rooms.createRoom();
    joinTable(socket, code, name);
  });

  socket.on('join-room', ({ code, name } = {}) => {
    if (socket.data.roomCode) {
      socket.emit('error-message', 'Du bist bereits einem Raum beigetreten.');
      return;
    }
    const normalizedCode = String(code || '').trim().toUpperCase();
    if (!rooms.roomExists(normalizedCode)) {
      socket.emit('error-message', `Raum "${normalizedCode}" wurde nicht gefunden.`);
      return;
    }

    // Reconnect-Versuch: Ein getrennter Spieler mit demselben Namen im
    // selben Raum bekommt seinen Platz, seine Chips und seine Karten zurück,
    // statt als neuer Spieler zu gelten.
    const table = rooms.getTable(normalizedCode);
    const trimmedName = String(name || '').trim();
    const oldSocketId = trimmedName && table.reconnectPlayer(socket.id, trimmedName);
    if (oldSocketId) {
      socket.data.roomCode = normalizedCode;
      clearDisconnectTimer(normalizedCode, oldSocketId);
      socket.join(normalizedCode);
      socket.emit('room-joined', { code: normalizedCode, ranked: rankedRooms.has(normalizedCode) });
      broadcastRoomState(normalizedCode);
      return;
    }

    joinTable(socket, normalizedCode, name);
  });

  socket.on('join-ranked-queue', ({ name } = {}) => {
    if (socket.data.roomCode) {
      socket.emit('error-message', 'Du bist bereits einem Raum beigetreten.');
      return;
    }
    if (rankedQueue.some((entry) => entry.socket === socket)) {
      socket.emit('error-message', 'Du suchst bereits nach einem Gegner.');
      return;
    }
    const trimmedName = String(name || '').trim();
    if (!trimmedName) {
      socket.emit('error-message', 'Bitte gib zuerst einen Namen ein.');
      return;
    }

    rankedQueue.push({ socket, name: trimmedName });
    socket.emit('queue-status', { waiting: true });

    if (rankedQueue.length >= 2) {
      const [a, b] = rankedQueue.splice(0, 2);
      startRankedMatch(a, b);
    }
  });

  socket.on('leave-ranked-queue', () => {
    const idx = rankedQueue.findIndex((entry) => entry.socket === socket);
    if (idx !== -1) {
      rankedQueue.splice(idx, 1);
      socket.emit('queue-status', { waiting: false });
    }
  });

  socket.on('get-rank', ({ name } = {}) => {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) return;
    const rank = getOrCreateRank(trimmedName);
    socket.emit('rank-info', { name: trimmedName, ...rank, tier: tierForRating(rank.rating) });
  });

  socket.on('get-leaderboard', () => {
    const entries = getLeaderboard(DATA_FILE, 20).map((p) => ({ ...p, tier: tierForRating(p.rating) }));
    socket.emit('leaderboard', entries);
  });

  socket.on('start-hand', () => {
    handleAction(socket, (table) => table.startHand());
  });

  socket.on('fold', () => {
    handleAction(socket, (table) => table.fold(socket.id));
  });

  socket.on('check', () => {
    handleAction(socket, (table) => table.check(socket.id));
  });

  socket.on('call', () => {
    handleAction(socket, (table) => table.call(socket.id));
  });

  socket.on('bet', ({ amount } = {}) => {
    handleAction(socket, (table) => table.placeBet(socket.id, amount));
  });

  socket.on('raise', ({ amount } = {}) => {
    handleAction(socket, (table) => table.raise(socket.id, amount));
  });

  socket.on('disconnect', () => {
    console.log(`Spieler getrennt: ${socket.id}`);

    const queueIdx = rankedQueue.findIndex((entry) => entry.socket === socket);
    if (queueIdx !== -1) rankedQueue.splice(queueIdx, 1);

    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    const table = rooms.getTable(roomCode);
    if (!table) return;

    // Spieler bleibt für die Gnadenfrist am Tisch sitzen (Chips/Karten
    // erhalten), damit ein Reconnect über join-room ihn zurückholen kann.
    table.markDisconnected(socket.id);
    broadcastRoomState(roomCode);

    const timer = setTimeout(() => {
      disconnectTimers.delete(timerKey(roomCode, socket.id));
      const currentTable = rooms.getTable(roomCode);
      if (!currentTable) return;
      currentTable.removePlayer(socket.id);
      if (currentTable.players.length === 0) {
        rooms.removeRoom(roomCode);
        rankedRooms.delete(roomCode);
      } else {
        broadcastRoomState(roomCode);
      }
      persist();
    }, RECONNECT_GRACE_MS);
    disconnectTimers.set(timerKey(roomCode, socket.id), timer);
  });
});

function timerKey(roomCode, socketId) {
  return `${roomCode}:${socketId}`;
}

function clearDisconnectTimer(roomCode, socketId) {
  const key = timerKey(roomCode, socketId);
  const timer = disconnectTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(key);
  }
}

function joinTable(socket, code, name) {
  const table = rooms.getTable(code);
  table.addPlayer(socket.id, name || `Spieler-${socket.id.slice(0, 4)}`);
  socket.data.roomCode = code;
  socket.join(code);
  socket.emit('room-joined', { code, ranked: rankedRooms.has(code) });
  broadcastRoomState(code);
  persist();
}

// Legt für zwei wartende Spieler einen neuen Raum an, setzt ein kleineres
// Ranked-Startkapital und markiert den Raum für die Bust-Erkennung nach
// jeder Hand (siehe maybeFinishRankedMatch).
function startRankedMatch(entryA, entryB) {
  const code = rooms.createRoom();
  rankedRooms.add(code);
  const table = rooms.getTable(code);
  table.addPlayer(entryA.socket.id, entryA.name, RANKED_STARTING_CHIPS);
  table.addPlayer(entryB.socket.id, entryB.name, RANKED_STARTING_CHIPS);

  for (const entry of [entryA, entryB]) {
    entry.socket.data.roomCode = code;
    entry.socket.join(code);
    entry.socket.emit('room-joined', { code, ranked: true, opponentName: entry === entryA ? entryB.name : entryA.name });
  }

  broadcastRoomState(code);
  persist();
}

// Führt eine Tisch-Aktion aus, meldet Validierungsfehler nur an den
// auslösenden Client zurück und lässt danach automatisch die nächste
// Straße austeilen (Flop/Turn/River/Showdown), falls die Wettrunde
// abgeschlossen ist.
function handleAction(socket, action) {
  const roomCode = socket.data.roomCode;
  const table = roomCode && rooms.getTable(roomCode);
  if (!table) {
    socket.emit('error-message', 'Du bist in keinem Raum.');
    return;
  }
  try {
    action(table);
    advancePhaseIfRoundComplete(table);
    broadcastRoomState(roomCode);
    if (rankedRooms.has(roomCode) && table.phase === 'showdown') {
      maybeFinishRankedMatch(roomCode, table);
    }
    persist(); // einfach gehalten: nach jeder Aktion speichern statt nur nach Handende
  } catch (err) {
    socket.emit('error-message', err.message);
  }
}

// Wird nach jeder Aktion aufgerufen. Solange die aktuelle Wettrunde fertig
// ist (niemand mehr am Zug) und die Hand noch nicht beendet ist, wird die
// nächste Phase ausgeteilt – das schließt den Fall ein, dass alle
// verbliebenen Spieler all-in sind und mehrere Straßen ohne weitere
// Aktionen nacheinander aufgedeckt werden müssen.
function advancePhaseIfRoundComplete(table) {
  while (table.phase !== 'showdown' && table.actingIndex === -1) {
    if (table.phase === 'preflop') table.dealFlop();
    else if (table.phase === 'flop') table.dealTurn();
    else if (table.phase === 'turn') table.dealRiver();
    else if (table.phase === 'river') table.showdown();
    else break; // Phase 'waiting': keine Hand läuft, nichts zu tun
  }
}

// Prüft nach einer beendeten Hand in einem Ranked-Raum, ob einer der beiden
// Spieler bei 0 Chips steht (= Match verloren). Aktualisiert dann die
// Ratings beider Spieler (ELO-artig, siehe ranking.js) und benachrichtigt
// beide Clients mit ihrem neuen Rang. Der Raum bleibt danach bestehen (die
// Spieler sehen die letzte Hand noch), zählt aber nicht mehr als Ranked.
function maybeFinishRankedMatch(code, table) {
  if (table.players.length !== 2) return; // unerwartete Spielerzahl: nichts werten

  const busted = table.players.find((p) => p.chips === 0);
  if (!busted) return; // Match läuft weiter
  const winner = table.players.find((p) => p.chips > 0);
  if (!winner) return;

  rankedRooms.delete(code);

  const winnerRank = getOrCreateRank(winner.name);
  const loserRank = getOrCreateRank(busted.name);
  const { winnerRating, loserRating } = applyMatchResult(winnerRank.rating, loserRank.rating);

  savePlayerRank(DATA_FILE, winner.name, {
    rating: winnerRating,
    wins: winnerRank.wins + 1,
    losses: winnerRank.losses,
  });
  savePlayerRank(DATA_FILE, busted.name, {
    rating: loserRating,
    wins: loserRank.wins,
    losses: loserRank.losses + 1,
  });

  const socketsInRoom = io.sockets.adapter.rooms.get(code);
  if (!socketsInRoom) return;
  for (const socketId of socketsInRoom) {
    const clientSocket = io.sockets.sockets.get(socketId);
    if (!clientSocket) continue;
    const isWinner = socketId === winner.id;
    clientSocket.emit('ranked-match-over', {
      result: isWinner ? 'win' : 'loss',
      opponentName: isWinner ? busted.name : winner.name,
      newRating: isWinner ? winnerRating : loserRating,
      newTier: tierForRating(isWinner ? winnerRating : loserRating),
      ratingChange: isWinner ? winnerRating - winnerRank.rating : loserRating - loserRank.rating,
    });
  }
}

// Schickt jedem Socket im Raum seine eigene Sicht auf den Tisch (fremde
// Hole Cards werden von table.getPublicState() ausgeblendet).
function broadcastRoomState(code) {
  const table = rooms.getTable(code);
  if (!table) return;
  const socketsInRoom = io.sockets.adapter.rooms.get(code);
  if (!socketsInRoom) return;
  for (const socketId of socketsInRoom) {
    const clientSocket = io.sockets.sockets.get(socketId);
    if (clientSocket) {
      clientSocket.emit('state', table.getPublicState(socketId));
    }
  }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Poker-Server läuft auf Port ${PORT}`);
});

// Bei einem sauberen Neustart/Deploy (Ctrl+C, SIGTERM) ein letztes Mal
// speichern, statt auf die nächste Aktion zu warten.
function shutdown() {
  persist();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
