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
    table.removePlayer(socket.id);
    if (table.players.length === 0) {
      rooms.removeRoom(roomCode);
    } else {
      broadcastRoomState(roomCode);
    }
  });
});

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
