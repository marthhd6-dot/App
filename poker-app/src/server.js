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
    try {
      table.startHand();
      broadcastState();
    } catch (err) {
      socket.emit('error-message', err.message);
    }
  });

  // TODO: 'bet', 'fold', 'check', 'call' Events – rufen table.placeBet() etc. auf,
  //       sobald diese Methoden implementiert sind.

  socket.on('disconnect', () => {
    console.log(`Spieler getrennt: ${socket.id}`);
    table.removePlayer(socket.id);
    broadcastState();
  });
});

function broadcastState() {
  for (const socket of io.sockets.sockets.values()) {
    socket.emit('state', table.getPublicState(socket.id));
  }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Poker-Server läuft auf Port ${PORT}`);
});
