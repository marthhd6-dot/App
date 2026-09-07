// src/server.js
// Minimaler Echtzeit-Server. Ein Prozess = ein Tisch (für den Start bewusst einfach gehalten).
// Nächste Ausbaustufe mit Claude Code: mehrere Tische/Räume, Auth, Persistenz.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Table } = require('./game/table');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const table = new Table({ smallBlind: 5, bigBlind: 10 });

app.get('/health', (req, res) => res.json({ status: 'ok' }));

io.on('connection', (socket) => {
  console.log(`Spieler verbunden: ${socket.id}`);

  socket.on('join', ({ name }) => {
    table.addPlayer(socket.id, name || `Spieler-${socket.id.slice(0, 4)}`);
    broadcastState();
  });

  socket.on('start-hand', () => {
    handleAction(socket, () => table.startHand());
  });

  socket.on('fold', () => {
    handleAction(socket, () => table.fold(socket.id));
  });

  socket.on('check', () => {
    handleAction(socket, () => table.check(socket.id));
  });

  socket.on('call', () => {
    handleAction(socket, () => table.call(socket.id));
  });

  socket.on('bet', ({ amount } = {}) => {
    handleAction(socket, () => table.placeBet(socket.id, amount));
  });

  socket.on('raise', ({ amount } = {}) => {
    handleAction(socket, () => table.raise(socket.id, amount));
  });

  socket.on('disconnect', () => {
    console.log(`Spieler getrennt: ${socket.id}`);
    table.removePlayer(socket.id);
    broadcastState();
  });
});

// Führt eine Tisch-Aktion aus, meldet Validierungsfehler nur an den
// auslösenden Client zurück und lässt danach automatisch die nächste
// Straße austeilen (Flop/Turn/River/Showdown), falls die Wettrunde
// abgeschlossen ist.
function handleAction(socket, action) {
  try {
    action();
    advancePhaseIfRoundComplete();
    broadcastState();
  } catch (err) {
    socket.emit('error-message', err.message);
  }
}

// Wird nach jeder Aktion aufgerufen. Solange die aktuelle Wettrunde fertig
// ist (niemand mehr am Zug) und die Hand noch nicht beendet ist, wird die
// nächste Phase ausgeteilt – das schließt den Fall ein, dass alle
// verbliebenen Spieler all-in sind und mehrere Straßen ohne weitere
// Aktionen nacheinander aufgedeckt werden müssen.
function advancePhaseIfRoundComplete() {
  while (table.phase !== 'showdown' && table.actingIndex === -1) {
    if (table.phase === 'preflop') table.dealFlop();
    else if (table.phase === 'flop') table.dealTurn();
    else if (table.phase === 'turn') table.dealRiver();
    else if (table.phase === 'river') table.showdown();
    else break; // Phase 'waiting': keine Hand läuft, nichts zu tun
  }
}

function broadcastState() {
  for (const socket of io.sockets.sockets.values()) {
    socket.emit('state', table.getPublicState(socket.id));
  }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Poker-Server läuft auf Port ${PORT}`);
});
