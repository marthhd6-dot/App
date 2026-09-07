// src/server.js
// Server für mehrere gleichzeitige Poker-Tische ("Räume"). Jeder Raum hat
// einen eigenen Tisch-Zustand (src/rooms.js) und wird über einen kurzen
// Code erreicht, den Spieler zum Beitreten eingeben.
//
// Zusätzlich gibt es zwei automatische 4-Spieler-Modi ("1v1v1v1"), die
// beide ohne manuellen Raum-Code über eine Matchmaking-Warteschlange
// zusammenfinden und bei denen ein Match läuft, bis nur noch ein Spieler
// Chips übrig hat (siehe trackEliminations()):
// - **Ranked**: Spieler werden nach Rating gruppiert (siehe
//   findMatchmakingGroup() in src/ranking.js). Die Platzierung nach
//   Matchende aktualisiert die Ratings paarweise (siehe
//   applyMultiwayMatchResult()); der Rang wird über den Spielernamen
//   dauerhaft gespeichert (src/persistence.js).
// - **Casual**: Die ersten vier wartenden Spieler werden ohne
//   Rating-Bezug zusammengelegt (reines FIFO), ohne Auswirkung auf den
//   Rang – nur zum entspannten Spielen zu viert.
// Siehe README für bekannte Vereinfachungen (keine echte Authentifizierung).

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');
const { loadSnapshot, saveSnapshot, getPlayerRank, savePlayerRank, getLeaderboard } = require('./persistence');
const { STARTING_RATING, tierForRating, findMatchmakingGroup, applyMultiwayMatchResult } = require('./ranking');
const { blindsForHandsPlayed } = require('./blinds');

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

// Startkapital für ein Ranked-Match, wie bei einem Casual-Tisch. Die
// Blinds starten klein (siehe blindsForHandsPlayed() in blinds.js) und
// steigen turnierartig, damit ein Match trotzdem in endlicher Zeit zu
// einem Ergebnis kommt.
const RANKED_STARTING_CHIPS = 1000;
// Anzahl Spieler pro Ranked-Tisch ("1v1v1v1").
const RANKED_GROUP_SIZE = 4;

// Wartende Spieler für den Ranked-Modus: { socket, name, rating,
// joinedAt }, in Beitritts-Reihenfolge. findMatchmakingGroup() (ranking.js)
// bevorzugt den am längsten Wartenden und sucht dafür die (RANKED_GROUP_SIZE
// - 1) ratingmäßig ähnlichsten verfügbaren Mitspieler; die akzeptierte
// Rating-Spanne wächst mit der Wartezeit, damit niemand unbegrenzt hängen
// bleibt.
const rankedQueue = [];
// Wie oft erneut nach Gruppen gesucht wird, auch ohne dass jemand neu
// beitritt – nötig, damit wartende Spieler von der wachsenden Toleranz
// profitieren, statt nur bei einem neuen Beitritt geprüft zu werden.
const MATCHMAKING_INTERVAL_MS = 2000;
// Räume, die aus dem Ranked-Matchmaking stammen: code -> { eliminatedOrder,
// handsPlayed }. eliminatedOrder enthält die bereits ausgeschiedenen
// Spieler in Bust-Reihenfolge (zuerst ausgeschieden zuerst); handsPlayed
// zählt die in diesem Match bereits gestarteten Hände und steuert den
// Blind-Zeitplan (blindsForHandsPlayed() in blinds.js). Nur für diese
// Codes wird nach jeder Hand geprüft, ob das Match schon entschieden ist.
const rankedRooms = new Map();

// Anzahl Spieler pro Casual-4-Tisch ("1v1v1v1", ohne Rating-Bezug).
const CASUAL_GROUP_SIZE = 4;
// Wartende Spieler für den Casual-4-Modus: { socket, name, joinedAt }.
// Ohne Rating-Konzept genügt reines FIFO: sobald CASUAL_GROUP_SIZE
// Spieler warten, werden die ersten vier sofort zusammengelegt.
const casualQueue = [];
// Räume aus dem Casual-4-Matchmaking: code -> { eliminatedOrder }. Wie
// rankedRooms, aber ohne Blind-Zeitplan (feste Blinds wie an einem
// normalen Casual-Tisch) und ohne Rating-Auswirkung nach Matchende.
const casualMatchRooms = new Map();

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
      socket.emit('room-joined', {
        code: normalizedCode,
        ranked: rankedRooms.has(normalizedCode),
        casual4: casualMatchRooms.has(normalizedCode),
      });
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

    const rank = getOrCreateRank(trimmedName);
    rankedQueue.push({ socket, name: trimmedName, rating: rank.rating, joinedAt: Date.now() });
    socket.emit('queue-status', { waiting: true });

    runMatchmakingPass();
  });

  socket.on('leave-ranked-queue', () => {
    const idx = rankedQueue.findIndex((entry) => entry.socket === socket);
    if (idx !== -1) {
      rankedQueue.splice(idx, 1);
      socket.emit('queue-status', { waiting: false });
    }
  });

  socket.on('join-casual-queue', ({ name } = {}) => {
    if (socket.data.roomCode) {
      socket.emit('error-message', 'Du bist bereits einem Raum beigetreten.');
      return;
    }
    if (casualQueue.some((entry) => entry.socket === socket)) {
      socket.emit('error-message', 'Du suchst bereits nach Mitspielern.');
      return;
    }
    const trimmedName = String(name || '').trim();
    if (!trimmedName) {
      socket.emit('error-message', 'Bitte gib zuerst einen Namen ein.');
      return;
    }

    casualQueue.push({ socket, name: trimmedName, joinedAt: Date.now() });
    socket.emit('queue-status', { waiting: true });

    runCasualMatchmakingPass();
  });

  socket.on('leave-casual-queue', () => {
    const idx = casualQueue.findIndex((entry) => entry.socket === socket);
    if (idx !== -1) {
      casualQueue.splice(idx, 1);
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
    // In Ranked-Räumen vor jeder Hand die Blinds nach dem Turnier-Zeitplan
    // setzen und den Hand-Zähler erhöhen (siehe blindsForHandsPlayed()).
    const rankedEntry = rankedRooms.get(socket.data.roomCode);
    handleAction(socket, (table) => {
      if (rankedEntry) {
        const { smallBlind, bigBlind } = blindsForHandsPlayed(rankedEntry.handsPlayed);
        table.smallBlind = smallBlind;
        table.bigBlind = bigBlind;
        rankedEntry.handsPlayed += 1;
      }
      table.startHand();
    });
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
    const casualQueueIdx = casualQueue.findIndex((entry) => entry.socket === socket);
    if (casualQueueIdx !== -1) casualQueue.splice(casualQueueIdx, 1);

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
        casualMatchRooms.delete(roomCode);
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
  socket.emit('room-joined', { code, ranked: rankedRooms.has(code), casual4: casualMatchRooms.has(code) });
  broadcastRoomState(code);
  persist();
}

// Sucht per findMatchmakingGroup() (ranking.js) so lange nach passenden
// Gruppen von RANKED_GROUP_SIZE Spielern in der Warteschlange, bis keine
// mehr gefunden werden. Wird nach jedem neuen Beitritt sofort aufgerufen
// und zusätzlich periodisch (siehe MATCHMAKING_INTERVAL_MS), damit auch
// wartende Spieler von der mit der Zeit wachsenden Toleranz profitieren.
function runMatchmakingPass() {
  const group = findMatchmakingGroup(rankedQueue, RANKED_GROUP_SIZE);
  if (!group) return;
  // Absteigend entfernen, damit die kleineren Indizes beim Entfernen
  // größerer Indizes gültig bleiben.
  const entries = [...group]
    .sort((a, b) => b - a)
    .map((idx) => rankedQueue.splice(idx, 1)[0])
    .reverse();
  startRankedMatch(entries);
  runMatchmakingPass(); // in der restlichen Warteschlange könnten weitere Gruppen stecken
}
setInterval(runMatchmakingPass, MATCHMAKING_INTERVAL_MS);

// Legt für eine Gruppe wartender Spieler einen neuen Raum an, setzt ein
// kleineres Ranked-Startkapital und markiert den Raum für die
// Bust-Erkennung nach jeder Hand (siehe maybeFinishRankedMatch).
function startRankedMatch(entries) {
  const code = rooms.createRoom();
  rankedRooms.set(code, { eliminatedOrder: [], handsPlayed: 0 });
  const table = rooms.getTable(code);
  for (const entry of entries) {
    table.addPlayer(entry.socket.id, entry.name, RANKED_STARTING_CHIPS);
  }

  for (const entry of entries) {
    entry.socket.data.roomCode = code;
    entry.socket.join(code);
    entry.socket.emit('room-joined', {
      code,
      ranked: true,
      opponentNames: entries.filter((e) => e !== entry).map((e) => e.name),
    });
  }

  broadcastRoomState(code);
  persist();
}

// Legt reine FIFO-Gruppen von CASUAL_GROUP_SIZE wartenden Spielern an,
// solange genug in der Warteschlange stehen – kein Rating-Bezug, daher
// keine Toleranz und kein periodischer Timer nötig wie beim Ranked-Modus.
function runCasualMatchmakingPass() {
  while (casualQueue.length >= CASUAL_GROUP_SIZE) {
    const entries = casualQueue.splice(0, CASUAL_GROUP_SIZE);
    startCasualMatch(entries);
  }
}

// Legt für eine Gruppe wartender Spieler einen neuen Casual-Raum mit dem
// üblichen Startkapital und festen Blinds an (kein Turnier-Zeitplan) und
// markiert ihn für die Bust-Erkennung nach jeder Hand (siehe
// maybeFinishCasualMatch).
function startCasualMatch(entries) {
  const code = rooms.createRoom();
  casualMatchRooms.set(code, { eliminatedOrder: [] });
  const table = rooms.getTable(code);
  for (const entry of entries) {
    table.addPlayer(entry.socket.id, entry.name);
  }

  for (const entry of entries) {
    entry.socket.data.roomCode = code;
    entry.socket.join(code);
    entry.socket.emit('room-joined', {
      code,
      ranked: false,
      casual4: true,
      opponentNames: entries.filter((e) => e !== entry).map((e) => e.name),
    });
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
    if (table.phase === 'showdown') {
      if (rankedRooms.has(roomCode)) maybeFinishRankedMatch(roomCode, table);
      else if (casualMatchRooms.has(roomCode)) maybeFinishCasualMatch(roomCode, table);
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

// Prüft nach einer beendeten Hand in einem 4-Spieler-Match (Ranked oder
// Casual), ob ein oder mehrere Spieler bei 0 Chips stehen (= ausgeschieden),
// entfernt sie vom Tisch und merkt sich ihre Bust-Reihenfolge in
// matchEntry.eliminatedOrder. Läuft das Match noch (mehr als ein Spieler
// übrig), wird nur { finished: false } zurückgegeben, ggf. mit changed:
// true, falls gerade jemand entfernt wurde (Tisch-Ansicht muss dann neu
// verschickt werden). Sobald nur noch ein Spieler übrig ist, steht die
// Platzierung fest (Sieger zuerst, dann die Ausgeschiedenen in
// umgekehrter Bust-Reihenfolge – wer länger durchhält, landet weiter
// vorn) und wird als { finished: true, placements } zurückgegeben (leeres
// placements-Array im Randfall, dass der letzte verbliebene Spieler
// zeitgleich mitbustet – dann gibt es keine Wertung).
function trackEliminations(table, matchEntry) {
  const busted = table.players.filter((p) => p.chips === 0);
  for (const player of busted) {
    matchEntry.eliminatedOrder.push({ id: player.id, name: player.name });
    table.removePlayer(player.id);
  }

  const remaining = table.players;
  if (remaining.length > 1) {
    return { finished: false, changed: busted.length > 0 };
  }
  if (remaining.length === 0) {
    return { finished: true, placements: [] };
  }

  const winner = remaining[0];
  const placements = [{ id: winner.id, name: winner.name }, ...matchEntry.eliminatedOrder.slice().reverse()];
  return { finished: true, placements };
}

// Wertet ein beendetes Ranked-Match aus: aktualisiert alle Ratings
// paarweise anhand der Platzierung (siehe applyMultiwayMatchResult in
// ranking.js) und benachrichtigt jeden Client mit seinem Platz und neuen
// Rang. Der Raum bleibt danach bestehen (die Spieler sehen die letzte
// Hand noch), zählt aber nicht mehr als Ranked.
function maybeFinishRankedMatch(code, table) {
  const entry = rankedRooms.get(code);
  if (!entry) return;

  const result = trackEliminations(table, entry);
  if (!result.finished) {
    if (result.changed) broadcastRoomState(code);
    return;
  }
  rankedRooms.delete(code);
  if (result.placements.length === 0) return;

  const placements = result.placements;
  const placementNames = placements.map((p) => p.name);

  const priorRanks = {};
  const ratings = {};
  for (const name of placementNames) {
    priorRanks[name] = getOrCreateRank(name);
    ratings[name] = priorRanks[name].rating;
  }

  const results = applyMultiwayMatchResult(placementNames, ratings);

  placements.forEach((p, idx) => {
    const prior = priorRanks[p.name];
    const updated = results[p.name];
    savePlayerRank(DATA_FILE, p.name, {
      rating: updated.rating,
      wins: prior.wins + updated.wins,
      losses: prior.losses + updated.losses,
    });

    const clientSocket = io.sockets.sockets.get(p.id);
    if (!clientSocket) return;
    clientSocket.emit('ranked-match-over', {
      place: idx + 1,
      totalPlayers: placements.length,
      newRating: updated.rating,
      newTier: tierForRating(updated.rating),
      ratingChange: updated.rating - prior.rating,
    });
  });
}

// Wertet ein beendetes Casual-4-Match aus: keine Ratings betroffen, jeder
// Client bekommt nur seinen Platz mitgeteilt.
function maybeFinishCasualMatch(code, table) {
  const entry = casualMatchRooms.get(code);
  if (!entry) return;

  const result = trackEliminations(table, entry);
  if (!result.finished) {
    if (result.changed) broadcastRoomState(code);
    return;
  }
  casualMatchRooms.delete(code);
  if (result.placements.length === 0) return;

  result.placements.forEach((p, idx) => {
    const clientSocket = io.sockets.sockets.get(p.id);
    if (!clientSocket) return;
    clientSocket.emit('casual-match-over', { place: idx + 1, totalPlayers: result.placements.length });
  });
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
