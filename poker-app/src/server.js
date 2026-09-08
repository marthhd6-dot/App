// src/server.js
// Server für mehrere gleichzeitige Poker-Tische ("Räume"). Jeder Raum hat
// einen eigenen Tisch-Zustand (src/rooms.js) und wird über einen kurzen
// Code erreicht, den Spieler zum Beitreten eingeben.
//
// Zusätzlich gibt es vier automatische Matchmaking-Modi, die alle ohne
// manuellen Raum-Code über eine Warteschlange zusammenfinden:
// - **1v1v1v1 Ranked**: 4 Spieler frei-für-sich, nach Rating gruppiert
//   (siehe findMatchmakingGroup() in src/ranking.js). Ein Match läuft, bis
//   nur noch einer Chips übrig hat (siehe trackEliminations()); die
//   Platzierung aktualisiert die Ratings paarweise (siehe
//   applyMultiwayMatchResult()).
// - **1v1v1v1 Casual**: dieselbe Idee wie Ranked, aber reines FIFO ohne
//   Rating-Bezug und ohne Auswirkung auf den Rang.
// - **2v2 Ranked**: 4 nach Rating gruppierte Spieler werden zusätzlich in
//   zwei möglichst ausgeglichene Teams aufgeteilt (siehe
//   balanceIntoTeams()). Ein Match läuft, bis ein ganzes Team ausgeschieden
//   ist (siehe trackTeamEliminations()); die Ratings werden teambasiert
//   aktualisiert (siehe applyTeamMatchResult()).
// - **2v2 Casual**: wie 2v2 Ranked, aber FIFO ohne Rating-Bezug/-Auswirkung
//   – und als Besonderheit sieht jeder Spieler zusätzlich die Hole Cards
//   seines Teammitglieds (siehe extraVisibleIds in broadcastRoomState()).
//
// Gegen Bots üben (play-vs-bots): startet sofort (kein Matchmaking) einen
// eigenen Raum mit 1-3 Bot-Gegnern einer wählbaren Rang-Stufe. Bots haben
// keinen echten Socket – ihre Züge kommen aus decideBotAction() (siehe
// bots.js) und werden nach jeder Aktion automatisch nachgezogen (siehe
// maybeTriggerBotActions()). Rein zum Üben, kein Rating-Bezug.
//
// Freundesliste: Die Liste selbst liegt nur im Browser (localStorage) des
// jeweiligen Spielers – der Server speichert keine Freundschaften, sondern
// nur, welcher Name gerade online ist (onlineByName), damit ein Client
// fragen kann "sind meine Freunde gerade online?" (get-friends-status) und
// einen Online-Freund direkt in den eigenen Raum einladen kann
// (invite-friend -> friend-invite beim Empfänger).
//
// Accounts: Optional kann sich ein Spieler registrieren/anmelden (siehe
// register-account/login-account), um seinen Namen fest mit einem Passwort
// zu schützen (Hash + Salt in der users-Tabelle, siehe persistence.js) –
// ohne Account bleibt der Name weiterhin frei wählbar wie bisher. Ist ein
// Socket eingeloggt (socket.data.authenticatedUsername gesetzt), überschreibt
// resolveName() jeden vom Client mitgeschickten Namen mit dem Account-Namen,
// damit niemand den geschützten Namen eines fremden Accounts "leihen" kann.
// Angemeldet bleiben: login-with-token prüft ein Session-Token, das der
// Client nach dem Login in seinem localStorage ablegt (sessionTokens ist
// rein im Server-Speicher, überlebt also keinen Neustart – ein erneutes
// Login-with-token schlägt dann fehl und der Client zeigt wieder das
// Login-Formular).
// Siehe README für weitere bekannte Vereinfachungen.

const path = require('path');
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');
const {
  loadSnapshot,
  saveSnapshot,
  getPlayerRank,
  savePlayerRank,
  getLeaderboard,
  createUser,
  verifyUser,
} = require('./persistence');
const {
  STARTING_RATING,
  RANK_TIERS,
  tierForRating,
  findMatchmakingGroup,
  applyMultiwayMatchResult,
  applyTeamMatchResult,
} = require('./ranking');
const { blindsForHandsPlayed } = require('./blinds');
const { BOT_TIER_NAMES, decideBotAction } = require('./bots');

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
  // Bot-Übungsräume nicht mit sichern (siehe botRooms weiter unten) – sie
  // sind bewusst flüchtig, damit nach einem Neustart kein nie wieder
  // erreichbarer Bot-Platzhalter an einem Tisch übrig bleibt.
  const snapshot = rooms.exportSnapshot();
  for (const code of botRooms.keys()) delete snapshot[code];
  saveSnapshot(DATA_FILE, snapshot);
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

// Anzahl Spieler pro 2v2-Tisch (2 Teams à 2 Spieler).
const TEAM_SIZE = 2;
const TEAM_GROUP_SIZE = TEAM_SIZE * 2;

// Wartende Spieler für 2v2 Ranked: { socket, name, rating, joinedAt }.
// findMatchmakingGroup() sucht wie beim 1v1v1v1-Ranked-Modus die
// TEAM_GROUP_SIZE ratingmäßig nächsten Spieler; balanceIntoTeams() teilt
// die gefundene Gruppe danach in zwei möglichst ausgeglichene Teams auf.
const rankedTeamQueue = [];
// Räume aus dem 2v2-Ranked-Matchmaking: code -> { teams, members,
// handsPlayed }. teams ordnet jede Spieler-ID (0 oder 1) einem Team zu;
// members ist [{ id, name, team }, ...] – nötig, weil nach einem Bust der
// Spieler-Name aus table.players verschwindet, aber für die
// Rating-Auswertung noch gebraucht wird. handsPlayed steuert wie bei
// rankedRooms den Turnier-Blind-Zeitplan.
const rankedTeamRooms = new Map();

// Wartende Spieler für 2v2 Casual: { socket, name, joinedAt }. Reines FIFO
// wie beim 1v1v1v1-Casual-Modus.
const casualTeamQueue = [];
// Räume aus dem 2v2-Casual-Matchmaking: code -> { teams, members }. Für
// diese Räume zeigt broadcastRoomState() jedem Spieler zusätzlich die Hole
// Cards seines Teammitglieds.
const casualTeamRooms = new Map();

// Übungs-Räume gegen Bots (siehe play-vs-bots weiter unten): code -> {
// bots: Map(botId -> Rang-Stufe), eliminatedOrder }. eliminatedOrder wird
// von der bereits für Ranked/Casual genutzten trackEliminations()
// wiederverwendet, um Bust-Reihenfolge und Match-Ende einheitlich zu
// behandeln. Bots haben keinen echten Socket – nur der menschliche Spieler
// bekommt Ergebnisse gemeldet (siehe maybeFinishBotMatch()). Bot-Räume
// werden bewusst NICHT persistiert (siehe persist()): nach einem
// Server-Neustart gäbe es sonst einen "verwaisten", nie wieder
// verbindbaren Bot-Platzhalter am Tisch. Für eine reine Übungsrunde ist
// das ein vertretbarer Kompromiss.
const botRooms = new Map();
let botIdCounter = 0;
function nextBotId() {
  botIdCounter += 1;
  return `bot-${botIdCounter}`;
}

function getOrCreateRank(name) {
  return getPlayerRank(DATA_FILE, name) || { rating: STARTING_RATING, wins: 0, losses: 0 };
}

// Welcher Name ist gerade online: name -> Set<socket.id>. Ein Name kann
// mehrfach vertreten sein (mehrere Tabs, oder zwei Personen mit demselben
// Namen – siehe README, keine echte Authentifizierung); "online" heißt
// hier nur "mindestens ein verbundener Socket kennt aktuell diesen Namen".
const onlineByName = new Map();

function markOnline(socket, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return;
  socket.data.name = trimmed;
  if (!onlineByName.has(trimmed)) onlineByName.set(trimmed, new Set());
  onlineByName.get(trimmed).add(socket.id);
}

function markOffline(socket) {
  const name = socket.data.name;
  if (!name) return;
  const sockets = onlineByName.get(name);
  if (!sockets) return;
  sockets.delete(socket.id);
  if (sockets.size === 0) onlineByName.delete(name);
}

// Token -> Nutzername für eingeloggte Sessions (rein im Server-Speicher,
// überlebt also keinen Neustart). Der Client legt sein Token nach dem Login
// im localStorage ab und schickt es bei jedem neuen Verbindungsaufbau
// erneut (login-with-token), um automatisch angemeldet zu bleiben.
const sessionTokens = new Map();
const USERNAME_MAX_LENGTH = 20; // wie maxlength des Namensfelds im Frontend
const PASSWORD_MIN_LENGTH = 4;

function createSessionToken(username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessionTokens.set(token, username);
  return token;
}

// Gemeinsamer Abschluss für Registrierung, Login und automatisches
// Wieder-Einloggen per Token: markiert den Socket als eingeloggt, erzeugt
// ein frisches Session-Token und meldet den Account-Namen als online.
function logInSocket(socket, username) {
  socket.data.authenticatedUsername = username;
  const token = createSessionToken(username);
  markOnline(socket, username);
  socket.emit('login-success', { username, token });
}

// Liefert den Namen, der für diesen Socket tatsächlich verwendet werden
// soll: ist der Socket eingeloggt (socket.data.authenticatedUsername
// gesetzt), gilt immer der Account-Name – ein vom Client mitgeschickter,
// womöglich abweichender Name wird dann ignoriert, damit niemand den
// geschützten Namen eines fremden Accounts "leihen" kann. Ohne Account
// gilt weiterhin einfach der übergebene (getrimmte) Name wie bisher.
function resolveName(socket, suppliedName) {
  if (socket.data.authenticatedUsername) return socket.data.authenticatedUsername;
  return String(suppliedName || '').trim();
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
    const trimmedName = resolveName(socket, name);
    const oldSocketId = trimmedName && table.reconnectPlayer(socket.id, trimmedName);
    if (oldSocketId) {
      markOnline(socket, trimmedName);
      socket.data.roomCode = normalizedCode;
      clearDisconnectTimer(normalizedCode, oldSocketId);
      remapTeamEntryId(rankedTeamRooms.get(normalizedCode), oldSocketId, socket.id);
      remapTeamEntryId(casualTeamRooms.get(normalizedCode), oldSocketId, socket.id);
      socket.join(normalizedCode);
      socket.emit('room-joined', { code: normalizedCode, ...roomModeInfo(normalizedCode, socket.id) });
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
    const trimmedName = resolveName(socket, name);
    if (!trimmedName) {
      socket.emit('error-message', 'Bitte gib zuerst einen Namen ein.');
      return;
    }

    markOnline(socket, trimmedName);
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
    const trimmedName = resolveName(socket, name);
    if (!trimmedName) {
      socket.emit('error-message', 'Bitte gib zuerst einen Namen ein.');
      return;
    }

    markOnline(socket, trimmedName);
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

  socket.on('join-ranked-team-queue', ({ name } = {}) => {
    if (socket.data.roomCode) {
      socket.emit('error-message', 'Du bist bereits einem Raum beigetreten.');
      return;
    }
    if (rankedTeamQueue.some((entry) => entry.socket === socket)) {
      socket.emit('error-message', 'Du suchst bereits nach Mitspielern.');
      return;
    }
    const trimmedName = resolveName(socket, name);
    if (!trimmedName) {
      socket.emit('error-message', 'Bitte gib zuerst einen Namen ein.');
      return;
    }

    markOnline(socket, trimmedName);
    const rank = getOrCreateRank(trimmedName);
    rankedTeamQueue.push({ socket, name: trimmedName, rating: rank.rating, joinedAt: Date.now() });
    socket.emit('queue-status', { waiting: true });

    runRankedTeamMatchmakingPass();
  });

  socket.on('leave-ranked-team-queue', () => {
    const idx = rankedTeamQueue.findIndex((entry) => entry.socket === socket);
    if (idx !== -1) {
      rankedTeamQueue.splice(idx, 1);
      socket.emit('queue-status', { waiting: false });
    }
  });

  socket.on('join-casual-team-queue', ({ name } = {}) => {
    if (socket.data.roomCode) {
      socket.emit('error-message', 'Du bist bereits einem Raum beigetreten.');
      return;
    }
    if (casualTeamQueue.some((entry) => entry.socket === socket)) {
      socket.emit('error-message', 'Du suchst bereits nach Mitspielern.');
      return;
    }
    const trimmedName = resolveName(socket, name);
    if (!trimmedName) {
      socket.emit('error-message', 'Bitte gib zuerst einen Namen ein.');
      return;
    }

    markOnline(socket, trimmedName);
    casualTeamQueue.push({ socket, name: trimmedName, joinedAt: Date.now() });
    socket.emit('queue-status', { waiting: true });

    runCasualTeamMatchmakingPass();
  });

  socket.on('leave-casual-team-queue', () => {
    const idx = casualTeamQueue.findIndex((entry) => entry.socket === socket);
    if (idx !== -1) {
      casualTeamQueue.splice(idx, 1);
      socket.emit('queue-status', { waiting: false });
    }
  });

  // Startet sofort (kein Matchmaking/Warteschlange nötig) einen eigenen
  // Raum mit 1-3 Bot-Gegnern einer gewählten Rang-Stufe (siehe bots.js).
  // Kein Rating-Bezug – reiner Übungsmodus, echte Ranked/Casual-Läufe mit
  // Menschen bleiben davon unberührt.
  socket.on('play-vs-bots', ({ name, botCount, difficulty } = {}) => {
    if (socket.data.roomCode) {
      socket.emit('error-message', 'Du bist bereits einem Raum beigetreten.');
      return;
    }
    const trimmedName = resolveName(socket, name);
    if (!trimmedName) {
      socket.emit('error-message', 'Bitte gib zuerst einen Namen ein.');
      return;
    }
    const tierName = BOT_TIER_NAMES.includes(difficulty) ? difficulty : BOT_TIER_NAMES[0];
    const count = Math.min(3, Math.max(1, Math.round(Number(botCount)) || 1));

    const code = rooms.createRoom();
    const table = rooms.getTable(code);
    table.addPlayer(socket.id, trimmedName);
    markOnline(socket, trimmedName);

    const bots = new Map();
    for (let i = 0; i < count; i++) {
      const botId = nextBotId();
      const botName = count > 1 ? `${tierName}-Bot ${i + 1}` : `${tierName}-Bot`;
      table.addPlayer(botId, botName);
      bots.set(botId, tierName);
    }
    botRooms.set(code, { bots, eliminatedOrder: [] });

    socket.data.roomCode = code;
    socket.join(code);
    socket.emit('room-joined', { code, vsBots: true, botDifficulty: tierName });
    broadcastRoomState(code);
  });

  socket.on('get-rank', ({ name } = {}) => {
    const trimmedName = resolveName(socket, name);
    if (!trimmedName) return;
    const rank = getOrCreateRank(trimmedName);
    // RANK_TIERS wird mitgeschickt, damit das Frontend den kompletten
    // Rang-Pfad (Bronze bis Champion) zeichnen kann, ohne die Schwellenwerte
    // selbst zu duplizieren (siehe "Mein Rang" in app.js).
    socket.emit('rank-info', { name: trimmedName, ...rank, tier: tierForRating(rank.rating), tiers: RANK_TIERS });
  });

  socket.on('get-leaderboard', () => {
    const entries = getLeaderboard(DATA_FILE, 20).map((p) => ({ ...p, tier: tierForRating(p.rating) }));
    socket.emit('leaderboard', entries);
  });

  socket.on('register-account', ({ username, password } = {}) => {
    const trimmedUsername = String(username || '').trim();
    if (!trimmedUsername || trimmedUsername.length > USERNAME_MAX_LENGTH) {
      socket.emit('account-error', { message: `Nutzername muss 1–${USERNAME_MAX_LENGTH} Zeichen lang sein.` });
      return;
    }
    if (!password || String(password).length < PASSWORD_MIN_LENGTH) {
      socket.emit('account-error', { message: `Passwort muss mindestens ${PASSWORD_MIN_LENGTH} Zeichen lang sein.` });
      return;
    }
    const created = createUser(DATA_FILE, trimmedUsername, String(password));
    if (!created) {
      socket.emit('account-error', { message: `Nutzername "${trimmedUsername}" ist bereits vergeben.` });
      return;
    }
    logInSocket(socket, trimmedUsername);
  });

  socket.on('login-account', ({ username, password } = {}) => {
    const trimmedUsername = String(username || '').trim();
    const verifiedUsername = trimmedUsername && verifyUser(DATA_FILE, trimmedUsername, String(password || ''));
    if (!verifiedUsername) {
      socket.emit('account-error', { message: 'Nutzername oder Passwort falsch.' });
      return;
    }
    logInSocket(socket, verifiedUsername);
  });

  // Meldet einen Socket automatisch wieder an, wenn der Client noch ein
  // gültiges Session-Token aus einem früheren Login besitzt (siehe
  // sessionTokens weiter unten). Ungültiges/abgelaufenes Token wird still
  // ignoriert – der Client bleibt dann einfach im Gast-Modus.
  socket.on('login-with-token', ({ token } = {}) => {
    const username = token && sessionTokens.get(token);
    if (!username) return;
    socket.data.authenticatedUsername = username;
    markOnline(socket, username);
    socket.emit('login-success', { username, token });
  });

  socket.on('logout-account', ({ token } = {}) => {
    if (token) sessionTokens.delete(token);
    socket.data.authenticatedUsername = null;
  });

  // Registriert den Namen als "online", auch ohne dass der Spieler schon
  // einem Raum/einer Warteschlange beigetreten ist (z. B. direkt nach dem
  // Eintippen auf dem Startbildschirm) – nötig, damit Freunde diesen
  // Spieler in der Freundesliste als online sehen können.
  socket.on('set-name', ({ name } = {}) => {
    markOnline(socket, resolveName(socket, name));
  });

  // Beantwortet für eine Liste von Namen (die Freundesliste des Clients,
  // die nur lokal im Browser gespeichert ist), welche davon gerade online
  // sind.
  socket.on('get-friends-status', ({ names } = {}) => {
    const list = Array.isArray(names) ? names : [];
    const online = list.filter((n) => {
      const sockets = onlineByName.get(String(n || '').trim());
      return sockets && sockets.size > 0;
    });
    socket.emit('friends-status', { online });
  });

  // Lädt einen (laut onlineByName) gerade online befindlichen Freund in den
  // eigenen aktuellen Raum ein. Der Absender muss selbst in einem Raum
  // sein; Namensgleichheit genügt wie überall in dieser App als "Freund
  // gefunden" (keine echte Authentifizierung).
  socket.on('invite-friend', ({ friendName } = {}) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) {
      socket.emit('error-message', 'Du bist in keinem Raum, um Freunde einzuladen.');
      return;
    }
    const trimmed = String(friendName || '').trim();
    const friendSockets = onlineByName.get(trimmed);
    if (!friendSockets || friendSockets.size === 0) {
      socket.emit('error-message', `${trimmed} ist gerade nicht online.`);
      return;
    }
    const fromName = socket.data.name || 'Jemand';
    for (const friendSocketId of friendSockets) {
      const friendSocket = io.sockets.sockets.get(friendSocketId);
      if (friendSocket) friendSocket.emit('friend-invite', { fromName, roomCode });
    }
    socket.emit('invite-sent', { friendName: trimmed });
  });

  socket.on('start-hand', () => {
    // In beiden Ranked-Modi (1v1v1v1 und 2v2) vor jeder Hand die Blinds
    // nach dem Turnier-Zeitplan setzen und den Hand-Zähler erhöhen (siehe
    // blindsForHandsPlayed()).
    const code = socket.data.roomCode;
    const escalatingEntry = rankedRooms.get(code) || rankedTeamRooms.get(code);
    handleAction(socket, (table) => {
      if (escalatingEntry) {
        const { smallBlind, bigBlind } = blindsForHandsPlayed(escalatingEntry.handsPlayed);
        table.smallBlind = smallBlind;
        table.bigBlind = bigBlind;
        escalatingEntry.handsPlayed += 1;
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
    markOffline(socket);

    const queueIdx = rankedQueue.findIndex((entry) => entry.socket === socket);
    if (queueIdx !== -1) rankedQueue.splice(queueIdx, 1);
    const casualQueueIdx = casualQueue.findIndex((entry) => entry.socket === socket);
    if (casualQueueIdx !== -1) casualQueue.splice(casualQueueIdx, 1);
    const rankedTeamQueueIdx = rankedTeamQueue.findIndex((entry) => entry.socket === socket);
    if (rankedTeamQueueIdx !== -1) rankedTeamQueue.splice(rankedTeamQueueIdx, 1);
    const casualTeamQueueIdx = casualTeamQueue.findIndex((entry) => entry.socket === socket);
    if (casualTeamQueueIdx !== -1) casualTeamQueue.splice(casualTeamQueueIdx, 1);

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
      // In einem Bot-Raum bleiben Bots nach einem Verlassen des Menschen
      // für immer sitzen (sie haben keinen eigenen Reconnect) – ohne diese
      // Prüfung würde players.length nie 0 erreichen und der Raum bliebe
      // dauerhaft (unbespielt) im Speicher hängen.
      const botEntry = botRooms.get(roomCode);
      const onlyBotsLeft = botEntry && currentTable.players.every((p) => botEntry.bots.has(p.id));
      if (currentTable.players.length === 0 || onlyBotsLeft) {
        rooms.removeRoom(roomCode);
        rankedRooms.delete(roomCode);
        casualMatchRooms.delete(roomCode);
        rankedTeamRooms.delete(roomCode);
        casualTeamRooms.delete(roomCode);
        botRooms.delete(roomCode);
      } else {
        broadcastRoomState(roomCode);
      }
      persist();
    }, RECONNECT_GRACE_MS);
    disconnectTimers.set(timerKey(roomCode, socket.id), timer);
  });
});

// Liefert die Badge-/Team-Infos für room-joined, je nachdem aus welchem
// Matchmaking-Modus (falls überhaupt) der Raum stammt.
function roomModeInfo(code, playerId) {
  if (rankedRooms.has(code)) return { ranked: true };
  if (casualMatchRooms.has(code)) return { casual4: true };
  const rankedTeamEntry = rankedTeamRooms.get(code);
  if (rankedTeamEntry) return { rankedTeam: true, team: rankedTeamEntry.teams[playerId] };
  const casualTeamEntry = casualTeamRooms.get(code);
  if (casualTeamEntry) return { casualTeam: true, team: casualTeamEntry.teams[playerId] };
  const botEntry = botRooms.get(code);
  if (botEntry) return { vsBots: true };
  return {};
}

// Ein Reconnect gibt dem zurückkehrenden Spieler eine neue Socket-ID (siehe
// table.reconnectPlayer()). team-Einträge merken sich Spieler aber über
// ihre ID, daher muss diese Zuordnung hier nachgezogen werden – sonst
// würde der Spieler nach einem Reconnect aus seinem Team "fallen".
function remapTeamEntryId(entry, oldId, newId) {
  if (!entry || !(oldId in entry.teams)) return;
  entry.teams[newId] = entry.teams[oldId];
  delete entry.teams[oldId];
  const member = entry.members.find((m) => m.id === oldId);
  if (member) member.id = newId;
}

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
  const resolvedName = resolveName(socket, name) || `Spieler-${socket.id.slice(0, 4)}`;
  table.addPlayer(socket.id, resolvedName);
  markOnline(socket, resolvedName);
  socket.data.roomCode = code;
  socket.join(code);
  socket.emit('room-joined', { code, ...roomModeInfo(code, socket.id) });
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

// Sucht per findMatchmakingGroup() so lange nach passenden 4er-Gruppen für
// 2v2 Ranked, bis keine mehr gefunden werden – analog zu
// runMatchmakingPass(), nur dass die Gruppe danach zusätzlich in zwei
// Teams aufgeteilt wird (siehe balanceIntoTeams()).
function runRankedTeamMatchmakingPass() {
  const group = findMatchmakingGroup(rankedTeamQueue, TEAM_GROUP_SIZE);
  if (!group) return;
  const entries = [...group]
    .sort((a, b) => b - a)
    .map((idx) => rankedTeamQueue.splice(idx, 1)[0])
    .reverse();
  const [teamA, teamB] = balanceIntoTeams(entries);
  startRankedTeamMatch(teamA, teamB);
  runRankedTeamMatchmakingPass();
}
setInterval(runRankedTeamMatchmakingPass, MATCHMAKING_INTERVAL_MS);

// Teilt TEAM_GROUP_SIZE (4) Spieler in zwei möglichst ausgeglichene Teams
// auf: nach Rating sortiert spielen der stärkste und der schwächste
// zusammen gegen die beiden mittleren – das minimiert die Differenz der
// Team-Rating-Summen (Standard-Heuristik fürs Team-Balancing).
function balanceIntoTeams(entries) {
  const sorted = [...entries].sort((a, b) => a.rating - b.rating);
  return [
    [sorted[0], sorted[3]],
    [sorted[1], sorted[2]],
  ];
}

// Legt für zwei Teams einen neuen 2v2-Ranked-Raum an (Startkapital wie
// Ranked, Turnier-Blind-Zeitplan über handsPlayed) und merkt sich die
// Team-Zuordnung für die Bust-Erkennung (siehe maybeFinishRankedTeamMatch).
function startRankedTeamMatch(teamA, teamB) {
  const code = rooms.createRoom();
  const { teams, members } = buildTeamAssignment(teamA, teamB);
  rankedTeamRooms.set(code, { teams, members, handsPlayed: 0 });
  const table = rooms.getTable(code);
  for (const entry of members) {
    table.addPlayer(entry.id, entry.name, RANKED_STARTING_CHIPS);
  }
  joinTeamMatchRoom(code, teamA, teamB, teams, members, { rankedTeam: true });
}

// Legt reine FIFO-2v2-Casual-Gruppen an, solange genug Spieler warten –
// wie runCasualMatchmakingPass(), zusätzlich in zwei Teams aufgeteilt.
function runCasualTeamMatchmakingPass() {
  while (casualTeamQueue.length >= TEAM_GROUP_SIZE) {
    const entries = casualTeamQueue.splice(0, TEAM_GROUP_SIZE);
    startCasualTeamMatch([entries[0], entries[1]], [entries[2], entries[3]]);
  }
}

// Legt für zwei Teams einen neuen 2v2-Casual-Raum an (übliches
// Startkapital, feste Blinds). broadcastRoomState() zeigt jedem Spieler
// dieses Raums zusätzlich die Hole Cards seines Teammitglieds.
function startCasualTeamMatch(teamA, teamB) {
  const code = rooms.createRoom();
  const { teams, members } = buildTeamAssignment(teamA, teamB);
  casualTeamRooms.set(code, { teams, members });
  const table = rooms.getTable(code);
  for (const entry of members) {
    table.addPlayer(entry.id, entry.name);
  }
  joinTeamMatchRoom(code, teamA, teamB, teams, members, { casualTeam: true });
}

// Baut aus zwei Team-Arrays (je [{ socket, name, ... }, ...]) die von
// rankedTeamRooms/casualTeamRooms benötigten Strukturen: teams ordnet jede
// Socket-ID ihrem Team-Index zu, members ist die flache Liste aller
// Mitglieder mit { id, name, team }.
function buildTeamAssignment(teamA, teamB) {
  const teams = {};
  const members = [];
  [teamA, teamB].forEach((team, teamIdx) => {
    team.forEach((entry) => {
      teams[entry.socket.id] = teamIdx;
      members.push({ id: entry.socket.id, name: entry.name, team: teamIdx });
    });
  });
  return { teams, members };
}

// Gemeinsamer Beitritts-Schritt für 2v2-Räume: jeden Spieler dem Socket.io-
// Raum hinzufügen und mit seiner Team-Zugehörigkeit benachrichtigen.
function joinTeamMatchRoom(code, teamA, teamB, teams, members, modeFlags) {
  for (const entry of [...teamA, ...teamB]) {
    const teamIdx = teams[entry.socket.id];
    const teammateNames = members.filter((m) => m.team === teamIdx && m.id !== entry.socket.id).map((m) => m.name);
    entry.socket.data.roomCode = code;
    entry.socket.join(code);
    entry.socket.emit('room-joined', { code, ...modeFlags, team: teamIdx, teammateNames });
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
      else if (rankedTeamRooms.has(roomCode)) maybeFinishRankedTeamMatch(roomCode, table);
      else if (casualTeamRooms.has(roomCode)) maybeFinishCasualTeamMatch(roomCode, table);
      else if (botRooms.has(roomCode)) maybeFinishBotMatch(roomCode, table);
    }
    persist(); // einfach gehalten: nach jeder Aktion speichern statt nur nach Handende
    maybeTriggerBotActions(roomCode);
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

// Prüft nach einer beendeten Hand in einem 2v2-Match (Ranked oder Casual),
// ob ein oder mehrere Spieler bei 0 Chips stehen, entfernt sie vom Tisch
// und prüft, ob dadurch ein ganzes Team ausgeschieden ist. Läuft das Match
// noch (Spieler aus beiden Teams haben noch Chips), wird nur
// { finished: false } zurückgegeben, ggf. mit changed: true. Ist nur noch
// ein Team übrig, wird { finished: true, winningTeam } zurückgegeben
// (winningTeam: null im Randfall, dass beide Teams zeitgleich komplett
// ausscheiden – dann gibt es keine Wertung).
function trackTeamEliminations(table, matchEntry) {
  const busted = table.players.filter((p) => p.chips === 0);
  for (const player of busted) {
    table.removePlayer(player.id);
  }

  const remaining = table.players;
  if (remaining.length === 0) {
    return { finished: true, winningTeam: null, changed: busted.length > 0 };
  }
  const remainingTeams = new Set(remaining.map((p) => matchEntry.teams[p.id]));
  if (remainingTeams.size > 1) {
    return { finished: false, changed: busted.length > 0 };
  }
  return { finished: true, winningTeam: [...remainingTeams][0], changed: busted.length > 0 };
}

// Wertet ein beendetes 2v2-Ranked-Match aus: aktualisiert die Ratings
// teambasiert (siehe applyTeamMatchResult in ranking.js – jedes Mitglied
// des Sieger-Teams gilt als Sieger gegen jedes Mitglied des
// Verlierer-Teams) und benachrichtigt jeden Client, ob sein Team gewonnen
// hat und mit seinem neuen Rang.
function maybeFinishRankedTeamMatch(code, table) {
  const entry = rankedTeamRooms.get(code);
  if (!entry) return;

  const result = trackTeamEliminations(table, entry);
  if (!result.finished) {
    if (result.changed) broadcastRoomState(code);
    return;
  }
  rankedTeamRooms.delete(code);
  if (result.winningTeam === null) return;

  const winnerNames = entry.members.filter((m) => m.team === result.winningTeam).map((m) => m.name);
  const loserNames = entry.members.filter((m) => m.team !== result.winningTeam).map((m) => m.name);

  const priorRanks = {};
  const ratings = {};
  for (const name of [...winnerNames, ...loserNames]) {
    priorRanks[name] = getOrCreateRank(name);
    ratings[name] = priorRanks[name].rating;
  }

  const results = applyTeamMatchResult(winnerNames, loserNames, ratings);

  entry.members.forEach((member) => {
    const prior = priorRanks[member.name];
    const updated = results[member.name];
    savePlayerRank(DATA_FILE, member.name, {
      rating: updated.rating,
      wins: prior.wins + updated.wins,
      losses: prior.losses + updated.losses,
    });

    const clientSocket = io.sockets.sockets.get(member.id);
    if (!clientSocket) return;
    clientSocket.emit('ranked-team-match-over', {
      won: member.team === result.winningTeam,
      newRating: updated.rating,
      newTier: tierForRating(updated.rating),
      ratingChange: updated.rating - prior.rating,
    });
  });
}

// Wertet ein beendetes 2v2-Casual-Match aus: keine Ratings betroffen, jeder
// Client erfährt nur, ob sein Team gewonnen hat.
function maybeFinishCasualTeamMatch(code, table) {
  const entry = casualTeamRooms.get(code);
  if (!entry) return;

  const result = trackTeamEliminations(table, entry);
  if (!result.finished) {
    if (result.changed) broadcastRoomState(code);
    return;
  }
  casualTeamRooms.delete(code);
  if (result.winningTeam === null) return;

  entry.members.forEach((member) => {
    const clientSocket = io.sockets.sockets.get(member.id);
    if (!clientSocket) return;
    clientSocket.emit('casual-team-match-over', { won: member.team === result.winningTeam });
  });
}

// Wertet ein beendetes Bot-Übungsmatch aus: kein Rating betroffen, nur der
// menschliche Spieler bekommt Sieg/Niederlage gemeldet (Bots haben keinen
// Socket). Nutzt trackEliminations() wie Ranked/Casual-4-Matches, da botRooms-
// Einträge dieselbe { eliminatedOrder } Form haben.
function maybeFinishBotMatch(code, table) {
  const entry = botRooms.get(code);
  if (!entry) return;

  const result = trackEliminations(table, entry);
  if (!result.finished) {
    if (result.changed) broadcastRoomState(code);
    return;
  }
  botRooms.delete(code);
  if (result.placements.length === 0) return;

  const human = result.placements.find((p) => !entry.bots.has(p.id));
  const clientSocket = human && io.sockets.sockets.get(human.id);
  if (!clientSocket) return;
  clientSocket.emit('vs-bots-over', { won: result.placements[0].id === human.id });
}

// Führt eine Bot-Entscheidung über die passende Table-Methode aus (siehe
// decideBotAction() in bots.js, das immer eine an der aktuellen Situation
// legale Aktion liefert).
function applyBotDecision(table, botId, decision) {
  switch (decision.type) {
    case 'fold':
      return table.fold(botId);
    case 'check':
      return table.check(botId);
    case 'call':
      return table.call(botId);
    case 'bet':
      return table.placeBet(botId, decision.amount);
    case 'raise':
      return table.raise(botId, decision.amount);
    default:
      throw new Error(`Unbekannte Bot-Aktion: ${decision.type}`);
  }
}

// Lässt so lange automatisch für wartende Bots handeln (siehe
// decideBotAction() in bots.js), bis entweder ein Mensch am Zug ist, die
// Hand vorbei ist, oder der Raum kein Bot-Raum ist. Wird am Ende jeder
// handleAction()-Aktion aufgerufen (auch nach start-hand, da das ebenfalls
// über handleAction läuft) – für Nicht-Bot-Räume ist der erste Check ein
// günstiger No-op. Rekursion ist unproblematisch, da eine Hand nur endlich
// viele Aktionen hat.
function maybeTriggerBotActions(code) {
  const entry = botRooms.get(code);
  if (!entry) return;
  const table = rooms.getTable(code);
  if (!table) return;

  const current = table.getCurrentPlayer();
  if (!current || !entry.bots.has(current.id)) return;

  const tierName = entry.bots.get(current.id);
  const decision = decideBotAction(table, current.id, tierName);
  try {
    applyBotDecision(table, current.id, decision);
  } catch (err) {
    // Sollte dank der Legalitäts-Garantien von decideBotAction() nie
    // passieren – als letzte Absicherung folden, damit die Hand nicht
    // hängen bleibt, statt den ganzen Raum lahmzulegen.
    table.fold(current.id);
  }
  advancePhaseIfRoundComplete(table);
  broadcastRoomState(code);

  if (table.phase === 'showdown') {
    maybeFinishBotMatch(code, table);
  }
  persist();

  maybeTriggerBotActions(code); // ggf. ist gleich der nächste Bot dran
}

// Schickt jedem Socket im Raum seine eigene Sicht auf den Tisch (fremde
// Hole Cards werden von table.getPublicState() ausgeblendet – außer für
// das eigene Teammitglied in einem 2v2-Casual-Raum, siehe extraVisibleIds
// unten). In jedem 2v2-Raum (Ranked oder Casual) wird zusätzlich die
// Team-Zuordnung als state.teams mitgeschickt, damit das Frontend die
// Sitzplätze pro Team einfärben kann.
function broadcastRoomState(code) {
  const table = rooms.getTable(code);
  if (!table) return;
  const casualTeamEntry = casualTeamRooms.get(code);
  const teamEntry = rankedTeamRooms.get(code) || casualTeamEntry;
  const socketsInRoom = io.sockets.adapter.rooms.get(code);
  if (!socketsInRoom) return;
  for (const socketId of socketsInRoom) {
    const clientSocket = io.sockets.sockets.get(socketId);
    if (!clientSocket) continue;
    let extraVisibleIds = [];
    if (casualTeamEntry) {
      const myTeam = casualTeamEntry.teams[socketId];
      extraVisibleIds = table.players
        .filter((p) => p.id !== socketId && casualTeamEntry.teams[p.id] === myTeam)
        .map((p) => p.id);
    }
    const state = table.getPublicState(socketId, extraVisibleIds);
    if (teamEntry) state.teams = teamEntry.teams;
    clientSocket.emit('state', state);
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
