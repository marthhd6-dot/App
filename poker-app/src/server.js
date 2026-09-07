// src/server.js
// Server für mehrere gleichzeitige Poker-Tische ("Räume"). Jeder Raum hat
// einen eigenen Tisch-Zustand (src/rooms.js) und wird über einen kurzen
// Code erreicht, den Spieler zum Beitreten eingeben.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = new RoomManager();

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
  let roomCode = null;

  socket.on('create-room', ({ name } = {}) => {
    if (roomCode) {
      socket.emit('error-message', 'Du bist bereits einem Raum beigetreten.');
      return;
    }
    roomCode = rooms.createRoom();
    joinTable(socket, roomCode, name);
  });

  socket.on('join-room', ({ code, name } = {}) => {
    if (roomCode) {
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
      roomCode = normalizedCode;
      clearDisconnectTimer(roomCode, oldSocketId);
      socket.join(roomCode);
      socket.emit('room-joined', { code: roomCode });
      broadcastRoomState(roomCode);
      return;
    }

    roomCode = normalizedCode;
    joinTable(socket, roomCode, name);
  });

  socket.on('start-hand', () => {
    handleAction(socket, roomCode, (table) => table.startHand());
  });

  socket.on('fold', () => {
    handleAction(socket, roomCode, (table) => table.fold(socket.id));
  });

  socket.on('check', () => {
    handleAction(socket, roomCode, (table) => table.check(socket.id));
  });

  socket.on('call', () => {
    handleAction(socket, roomCode, (table) => table.call(socket.id));
  });

  socket.on('bet', ({ amount } = {}) => {
    handleAction(socket, roomCode, (table) => table.placeBet(socket.id, amount));
  });

  socket.on('raise', ({ amount } = {}) => {
    handleAction(socket, roomCode, (table) => table.raise(socket.id, amount));
  });

  socket.on('disconnect', () => {
    console.log(`Spieler getrennt: ${socket.id}`);
    if (!roomCode) return;
    const table = rooms.getTable(roomCode);
    if (!table) return;

    // Spieler bleibt für die Gnadenfrist am Tisch sitzen (Chips/Karten
    // erhalten), damit ein Reconnect über join-room ihn zurückholen kann.
    table.markDisconnected(socket.id);
    broadcastRoomState(roomCode);

    const code = roomCode;
    const socketId = socket.id;
    const timer = setTimeout(() => {
      disconnectTimers.delete(timerKey(code, socketId));
      const currentTable = rooms.getTable(code);
      if (!currentTable) return;
      currentTable.removePlayer(socketId);
      if (currentTable.players.length === 0) {
        rooms.removeRoom(code);
      } else {
        broadcastRoomState(code);
      }
    }, RECONNECT_GRACE_MS);
    disconnectTimers.set(timerKey(code, socketId), timer);
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
  socket.join(code);
  socket.emit('room-joined', { code });
  broadcastRoomState(code);
}

// Führt eine Tisch-Aktion aus, meldet Validierungsfehler nur an den
// auslösenden Client zurück und lässt danach automatisch die nächste
// Straße austeilen (Flop/Turn/River/Showdown), falls die Wettrunde
// abgeschlossen ist.
function handleAction(socket, roomCode, action) {
  const table = roomCode && rooms.getTable(roomCode);
  if (!table) {
    socket.emit('error-message', 'Du bist in keinem Raum.');
    return;
  }
  try {
    action(table);
    advancePhaseIfRoundComplete(table);
    broadcastRoomState(roomCode);
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
