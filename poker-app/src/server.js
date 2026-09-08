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
// Bot-Auffüllung in allen vier Modi: Findet sich innerhalb von
// BOT_BACKFILL_DELAY_MS (Standard 15s) keine volle Menschen-Gruppe, füllt
// maybeBackfillQueueWithBots() die restlichen Plätze mit Bots einer zum
// Rating der Wartenden passenden Rang-Stufe auf (tierForRating()), damit
// niemand unbegrenzt warten muss. Bots nehmen dabei wie echte Mit-/
// Gegenspieler am Match teil (auch Ranked-Rating-Auswirkung für die
// Menschen), haben aber selbst keinen dauerhaften Account – ihr Name macht
// sie transparent erkennbar ("Gold-Bot 1" o. Ä.), ihr Rating wird nie
// gespeichert. decideBotAction() (siehe bots.js) liefert ihre Züge, die
// nach jeder Aktion mit einer kurzen "Bedenkzeit" automatisch nachgezogen
// werden (siehe maybeTriggerBotActions()).
//
// Gegen Bots üben (play-vs-bots): eigener, expliziter Modus – startet
// sofort (kein Matchmaking) einen Raum mit 1-3 selbst gewählten
// Bot-Gegnern, rein zum Üben, kein Rating-Bezug. Nutzt dieselbe
// Bot-Infrastruktur wie die automatische Auffüllung oben.
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
// Räume aus dem Casual-4-Matchmaking: code -> { eliminatedOrder,
// handsPlayed }. Wie rankedRooms inklusive Turnier-Blind-Zeitplan, aber
// ohne Rating-Auswirkung nach Matchende.
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
// Räume aus dem 2v2-Casual-Matchmaking: code -> { teams, members,
// handsPlayed }. Für diese Räume zeigt broadcastRoomState() jedem Spieler
// zusätzlich die Hole Cards seines Teammitglieds; handsPlayed steuert wie
// bei rankedTeamRooms den Turnier-Blind-Zeitplan.
const casualTeamRooms = new Map();

// Übungs-Räume gegen Bots (siehe play-vs-bots weiter unten): code -> {
// bots: Map(botId -> { tier, rating }), eliminatedOrder, handsPlayed }.
// Dieselbe Form von "bots" wird auch von
// rankedRooms/casualMatchRooms/rankedTeamRooms/casualTeamRooms genutzt,
// sobald deren Warteschlange nicht rechtzeitig
// voll wurde und mit Bots aufgefüllt werden musste (siehe
// maybeBackfillQueueWithBots()) – so kann maybeTriggerBotActions() für
// jeden Raumtyp einheitlich prüfen, ob und welche Bots dort sitzen, ohne
// den Raumtyp selbst zu kennen (siehe getMatchEntry()). rating ist bei
// reinen Übungs-Bots ungenutzt (null), bei aufgefüllten Ranked-Bots das
// beim Auffüllen zugewiesene, rein für die ELO-Berechnung dieses einen
// Matches gültige Rating (siehe maybeFinishRankedMatch()). eliminatedOrder
// wird von der bereits für Ranked/Casual genutzten trackEliminations()
// wiederverwendet, um Bust-Reihenfolge und Match-Ende einheitlich zu
// behandeln. Bots haben keinen echten Socket – nur menschliche Spieler
// bekommen Ergebnisse gemeldet. Reine Übungs-Räume (aus play-vs-bots)
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

// Künstliche "Bedenkzeit", bevor ein Bot-Zug tatsächlich ausgeführt wird –
// rein kosmetisch (wirkt sonst unnatürlich sofort), hat keinen Einfluss auf
// die Entscheidung selbst (siehe decideBotAction() in bots.js). Über die
// Env-Variablen überschreibbar, z. B. für Tests, um nicht künstlich warten
// zu müssen.
const BOT_THINK_DELAY_MIN_MS = Number(process.env.BOT_THINK_DELAY_MIN_MS) || 700;
const BOT_THINK_DELAY_MAX_MS = Number(process.env.BOT_THINK_DELAY_MAX_MS) || 1800;

function botThinkDelayMs() {
  return BOT_THINK_DELAY_MIN_MS + Math.random() * (BOT_THINK_DELAY_MAX_MS - BOT_THINK_DELAY_MIN_MS);
}

// Wie lange eine Ranked/Casual-Warteschlange (auch 2v2) auf echte
// Mitspieler wartet, bevor die restlichen Plätze mit Bots aufgefüllt
// werden, damit niemand unbegrenzt warten muss. Über
// BOT_BACKFILL_DELAY_MS überschreibbar (z. B. für Tests).
const BOT_BACKFILL_DELAY_MS = Number(process.env.BOT_BACKFILL_DELAY_MS) || 15_000;

// Liefert die Spieler-ID eines Warteschlangen-/Team-Eintrags: bei einem
// echten Spieler die Socket-ID, bei einem Auffüll-Bot (kein Socket) die
// beim Erzeugen vergebene Bot-ID (siehe maybeBackfillQueueWithBots()).
function entryId(entry) {
  return entry.socket ? entry.socket.id : entry.id;
}

// Sobald der am längsten wartende Eintrag einer Warteschlange
// BOT_BACKFILL_DELAY_MS überschritten hat, ohne dass eine volle Gruppe
// echter Spieler zusammenkam, wird der Rest der Gruppe mit Bots
// aufgefüllt (deren Rang-Stufe sich am Rating der wartenden Spieler
// orientiert, siehe tierForRating()), damit das Match trotzdem starten
// kann. Gibt die vollständige Gruppe zurück (Menschen zuerst, dann die
// neu erzeugten Bot-Einträge) und leert dabei die übergebene queue, oder
// gibt null zurück, wenn (noch) kein Backfill nötig ist.
function maybeBackfillQueueWithBots(queue, groupSize) {
  if (queue.length === 0) return null;
  const oldest = queue[0];
  if (Date.now() - oldest.joinedAt < BOT_BACKFILL_DELAY_MS) return null;

  const humanEntries = queue.splice(0, queue.length);
  const botsNeeded = groupSize - humanEntries.length;
  if (botsNeeded <= 0) return humanEntries;

  // Durchschnittliches Rating der Wartenden bestimmt die Bot-Stärke –
  // unabhängig davon, ob die Warteschlange selbst Ratings kennt (Ranked)
  // oder nicht (Casual): dort wird das gespeicherte Rating jedes Namens
  // nachgeschlagen, obwohl es fürs eigentliche Matchmaking irrelevant ist,
  // rein um die Bots realistisch passend zu besetzen.
  const avgRating =
    humanEntries.reduce((sum, e) => sum + getOrCreateRank(e.name).rating, 0) / humanEntries.length;

  const botEntries = [];
  for (let i = 0; i < botsNeeded; i++) {
    const tier = tierForRating(Math.round(avgRating));
    botEntries.push({
      id: nextBotId(),
      name: botsNeeded > 1 ? `${tier}-Bot ${i + 1}` : `${tier}-Bot`,
      rating: avgRating,
      tier,
    });
  }
  return [...humanEntries, ...botEntries];
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
      bots.set(botId, { tier: tierName, rating: null });
    }
    botRooms.set(code, { bots, eliminatedOrder: [], handsPlayed: 0 });

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
    // In allen Modi (Ranked und Casual, 1v1v1v1 und 2v2, sowie "Gegen Bots
    // üben") vor jeder Hand die Blinds nach dem Turnier-Zeitplan setzen und
    // den Hand-Zähler erhöhen (siehe blindsForHandsPlayed()): alle
    // RANKED_BLIND_INCREASE_EVERY_HANDS Hände verdoppeln sich die Blinds,
    // gedeckelt bei RANKED_MAX_SMALL_BLIND/-2x (aktuell 160/320).
    const code = socket.data.roomCode;
    const escalatingEntry = getMatchEntry(code);
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
      // Bots bleiben nach einem Verlassen des letzten Menschen für immer
      // sitzen (sie haben keinen eigenen Reconnect) – ohne diese Prüfung
      // würde players.length nie 0 erreichen und der Raum bliebe dauerhaft
      // (unbespielt) im Speicher hängen. Gilt für jeden Raumtyp, der Bots
      // enthalten kann (reine Bot-Übung wie auch mit Bots aufgefüllte
      // Ranked/Casual-Matches, siehe getMatchEntry()).
      const matchEntry = getMatchEntry(roomCode);
      const onlyBotsLeft =
        matchEntry &&
        matchEntry.bots &&
        currentTable.players.length > 0 &&
        currentTable.players.every((p) => matchEntry.bots.has(p.id));
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

// Liefert den Matchmaking-Eintrag eines Raums, unabhängig davon, aus
// welchem der fünf Modi (Ranked/Casual/2v2 Ranked/2v2 Casual/Bot-Übung) er
// stammt – nützlich für Code wie maybeTriggerBotActions() oder die
// Aufräum-Logik beim Verbindungsabbruch, der/die den Raumtyp selbst nicht
// kennen muss, nur ob (und welche) Bots darin sitzen (siehe .bots).
function getMatchEntry(code) {
  return (
    rankedRooms.get(code) ||
    casualMatchRooms.get(code) ||
    rankedTeamRooms.get(code) ||
    casualTeamRooms.get(code) ||
    botRooms.get(code)
  );
}

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
// Findet sich auch nach BOT_BACKFILL_DELAY_MS noch keine volle
// Menschen-Gruppe, füllt maybeBackfillQueueWithBots() den Rest mit Bots
// auf, damit niemand unbegrenzt warten muss.
function runMatchmakingPass() {
  const group = findMatchmakingGroup(rankedQueue, RANKED_GROUP_SIZE);
  if (group) {
    // Absteigend entfernen, damit die kleineren Indizes beim Entfernen
    // größerer Indizes gültig bleiben.
    const entries = [...group]
      .sort((a, b) => b - a)
      .map((idx) => rankedQueue.splice(idx, 1)[0])
      .reverse();
    startRankedMatch(entries);
    runMatchmakingPass(); // in der restlichen Warteschlange könnten weitere Gruppen stecken
    return;
  }
  const backfilled = maybeBackfillQueueWithBots(rankedQueue, RANKED_GROUP_SIZE);
  if (backfilled) startRankedMatch(backfilled);
}
setInterval(runMatchmakingPass, MATCHMAKING_INTERVAL_MS);

// Legt für eine Gruppe wartender Spieler einen neuen Raum an, setzt ein
// kleineres Ranked-Startkapital und markiert den Raum für die
// Bust-Erkennung nach jeder Hand (siehe maybeFinishRankedMatch). entries
// kann Bot-Einträge enthalten (siehe maybeBackfillQueueWithBots()) – die
// haben keinen Socket, nehmen aber sonst wie echte Spieler am Match teil
// (inkl. normaler Rating-Auswirkung für die Menschen, siehe
// maybeFinishRankedMatch()).
function startRankedMatch(entries) {
  const code = rooms.createRoom();
  const bots = new Map();
  entries.forEach((e) => {
    if (!e.socket) bots.set(e.id, { tier: e.tier, rating: e.rating });
  });
  rankedRooms.set(code, { eliminatedOrder: [], handsPlayed: 0, bots });
  const table = rooms.getTable(code);
  for (const entry of entries) {
    table.addPlayer(entryId(entry), entry.name, RANKED_STARTING_CHIPS);
  }

  for (const entry of entries) {
    if (!entry.socket) continue; // Bots haben keinen Socket zum Beitreten/Benachrichtigen
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
// solange genug in der Warteschlange stehen – kein Rating-Bezug für die
// Gruppierung selbst, daher keine Toleranz wie beim Ranked-Modus. Läuft
// zusätzlich periodisch (siehe MATCHMAKING_INTERVAL_MS), damit auch eine
// nicht ganz volle Warteschlange nach BOT_BACKFILL_DELAY_MS mit Bots
// aufgefüllt wird, statt nur bei neuen Beitritten geprüft zu werden.
function runCasualMatchmakingPass() {
  while (casualQueue.length >= CASUAL_GROUP_SIZE) {
    const entries = casualQueue.splice(0, CASUAL_GROUP_SIZE);
    startCasualMatch(entries);
  }
  const backfilled = maybeBackfillQueueWithBots(casualQueue, CASUAL_GROUP_SIZE);
  if (backfilled) startCasualMatch(backfilled);
}
setInterval(runCasualMatchmakingPass, MATCHMAKING_INTERVAL_MS);

// Legt für eine Gruppe wartender Spieler einen neuen Casual-Raum mit dem
// üblichen Startkapital und festen Blinds an (kein Turnier-Zeitplan) und
// markiert ihn für die Bust-Erkennung nach jeder Hand (siehe
// maybeFinishCasualMatch). entries kann Bot-Einträge enthalten (siehe
// maybeBackfillQueueWithBots()).
function startCasualMatch(entries) {
  const code = rooms.createRoom();
  const bots = new Map();
  entries.forEach((e) => {
    if (!e.socket) bots.set(e.id, { tier: e.tier, rating: e.rating });
  });
  casualMatchRooms.set(code, { eliminatedOrder: [], bots, handsPlayed: 0 });
  const table = rooms.getTable(code);
  for (const entry of entries) {
    table.addPlayer(entryId(entry), entry.name);
  }

  for (const entry of entries) {
    if (!entry.socket) continue;
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
// Teams aufgeteilt wird (siehe balanceIntoTeams()). Wie beim 1v1v1v1-
// Ranked-Modus füllt maybeBackfillQueueWithBots() nach BOT_BACKFILL_DELAY_MS
// mit Bots auf, falls keine volle Menschen-Gruppe zusammenkam.
function runRankedTeamMatchmakingPass() {
  const group = findMatchmakingGroup(rankedTeamQueue, TEAM_GROUP_SIZE);
  if (group) {
    const entries = [...group]
      .sort((a, b) => b - a)
      .map((idx) => rankedTeamQueue.splice(idx, 1)[0])
      .reverse();
    const [teamA, teamB] = balanceIntoTeams(entries);
    startRankedTeamMatch(teamA, teamB);
    runRankedTeamMatchmakingPass();
    return;
  }
  const backfilled = maybeBackfillQueueWithBots(rankedTeamQueue, TEAM_GROUP_SIZE);
  if (backfilled) {
    const [teamA, teamB] = balanceIntoTeams(backfilled);
    startRankedTeamMatch(teamA, teamB);
  }
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
// teamA/teamB können Bot-Einträge enthalten (siehe
// maybeBackfillQueueWithBots()).
function startRankedTeamMatch(teamA, teamB) {
  const code = rooms.createRoom();
  const { teams, members, bots } = buildTeamAssignment(teamA, teamB);
  rankedTeamRooms.set(code, { teams, members, handsPlayed: 0, bots });
  const table = rooms.getTable(code);
  for (const entry of members) {
    table.addPlayer(entry.id, entry.name, RANKED_STARTING_CHIPS);
  }
  joinTeamMatchRoom(code, teamA, teamB, teams, members, { rankedTeam: true });
}

// Legt reine FIFO-2v2-Casual-Gruppen an, solange genug Spieler warten –
// wie runCasualMatchmakingPass(), zusätzlich in zwei Teams aufgeteilt.
// Läuft zusätzlich periodisch (siehe MATCHMAKING_INTERVAL_MS), damit auch
// eine nicht ganz volle Warteschlange nach BOT_BACKFILL_DELAY_MS mit Bots
// aufgefüllt wird, statt nur bei neuen Beitritten geprüft zu werden.
function runCasualTeamMatchmakingPass() {
  while (casualTeamQueue.length >= TEAM_GROUP_SIZE) {
    const entries = casualTeamQueue.splice(0, TEAM_GROUP_SIZE);
    startCasualTeamMatch([entries[0], entries[1]], [entries[2], entries[3]]);
  }
  const backfilled = maybeBackfillQueueWithBots(casualTeamQueue, TEAM_GROUP_SIZE);
  if (backfilled) startCasualTeamMatch([backfilled[0], backfilled[1]], [backfilled[2], backfilled[3]]);
}
setInterval(runCasualTeamMatchmakingPass, MATCHMAKING_INTERVAL_MS);

// Legt für zwei Teams einen neuen 2v2-Casual-Raum an (übliches
// Startkapital, feste Blinds). broadcastRoomState() zeigt jedem Spieler
// dieses Raums zusätzlich die Hole Cards seines Teammitglieds (auch die
// eines Bot-Teammitglieds).
function startCasualTeamMatch(teamA, teamB) {
  const code = rooms.createRoom();
  const { teams, members, bots } = buildTeamAssignment(teamA, teamB);
  casualTeamRooms.set(code, { teams, members, bots, handsPlayed: 0 });
  const table = rooms.getTable(code);
  for (const entry of members) {
    table.addPlayer(entry.id, entry.name);
  }
  joinTeamMatchRoom(code, teamA, teamB, teams, members, { casualTeam: true });
}

// Baut aus zwei Team-Arrays (je [{ socket, name, ... } oder Bot-Eintrag,
// ...]) die von rankedTeamRooms/casualTeamRooms benötigten Strukturen:
// teams ordnet jede Spieler-ID (entryId()) ihrem Team-Index zu, members
// ist die flache Liste aller Mitglieder mit { id, name, team }, bots die
// Teilmenge davon, die keinen Socket hat (siehe entryId()).
function buildTeamAssignment(teamA, teamB) {
  const teams = {};
  const members = [];
  const bots = new Map();
  [teamA, teamB].forEach((team, teamIdx) => {
    team.forEach((entry) => {
      const id = entryId(entry);
      teams[id] = teamIdx;
      members.push({ id, name: entry.name, team: teamIdx });
      if (!entry.socket) bots.set(id, { tier: entry.tier, rating: entry.rating });
    });
  });
  return { teams, members, bots };
}

// Gemeinsamer Beitritts-Schritt für 2v2-Räume: jeden Spieler dem Socket.io-
// Raum hinzufügen und mit seiner Team-Zugehörigkeit benachrichtigen. Bots
// haben keinen Socket und werden übersprungen.
function joinTeamMatchRoom(code, teamA, teamB, teams, members, modeFlags) {
  for (const entry of [...teamA, ...teamB]) {
    if (!entry.socket) continue;
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
    dispatchMatchFinishIfShowdown(roomCode, table);
    persist(); // einfach gehalten: nach jeder Aktion speichern statt nur nach Handende
    maybeTriggerBotActions(roomCode);
  } catch (err) {
    socket.emit('error-message', err.message);
  }
}

// Prüft nach einer Aktion (menschlich oder Bot), ob die Hand gerade am
// Showdown angekommen ist, und ruft dafür den zum Raumtyp passenden
// maybeFinish*Match()-Handler auf. Geteilt zwischen handleAction() (nach
// einer menschlichen Aktion) und maybeTriggerBotActions() (nach einem
// Bot-Zug), damit diese Fallunterscheidung nicht doppelt gepflegt wird.
function dispatchMatchFinishIfShowdown(code, table) {
  if (table.phase !== 'showdown') return;
  if (rankedRooms.has(code)) maybeFinishRankedMatch(code, table);
  else if (casualMatchRooms.has(code)) maybeFinishCasualMatch(code, table);
  else if (rankedTeamRooms.has(code)) maybeFinishRankedTeamMatch(code, table);
  else if (casualTeamRooms.has(code)) maybeFinishCasualTeamMatch(code, table);
  else if (botRooms.has(code)) maybeFinishBotMatch(code, table);
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
//
// Musste die Warteschlange mit Bots aufgefüllt werden (siehe
// maybeBackfillQueueWithBots()), zählen Siege/Niederlagen gegen sie für
// die menschlichen Spieler ganz normal fürs Rating (bewusste Entscheidung
// – fühlt sich so am meisten wie ein echtes Match an). Die Bots selbst
// haben aber keinen dauerhaften Account: ihr Rating für die ELO-Rechnung
// ist das beim Auffüllen zugewiesene (siehe entry.bots), rein für dieses
// eine Match gültig und wird nie in player_ranks/der Bestenliste
// gespeichert.
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
  for (const p of placements) {
    const botInfo = entry.bots.get(p.id);
    priorRanks[p.name] = botInfo ? { rating: botInfo.rating, wins: 0, losses: 0 } : getOrCreateRank(p.name);
    ratings[p.name] = priorRanks[p.name].rating;
  }

  const results = applyMultiwayMatchResult(placementNames, ratings);

  placements.forEach((p, idx) => {
    const prior = priorRanks[p.name];
    const updated = results[p.name];
    if (!entry.bots.has(p.id)) {
      savePlayerRank(DATA_FILE, p.name, {
        rating: updated.rating,
        wins: prior.wins + updated.wins,
        losses: prior.losses + updated.losses,
      });
    }

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
// hat und mit seinem neuen Rang. Bot-Mitglieder (siehe entry.bots) zählen
// für die menschlichen Mitspieler normal fürs Rating, bekommen aber selbst
// kein dauerhaft gespeichertes Rating (siehe maybeFinishRankedMatch für
// dieselbe Begründung).
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
  for (const member of entry.members) {
    const botInfo = entry.bots.get(member.id);
    priorRanks[member.name] = botInfo ? { rating: botInfo.rating, wins: 0, losses: 0 } : getOrCreateRank(member.name);
    ratings[member.name] = priorRanks[member.name].rating;
  }

  const results = applyTeamMatchResult(winnerNames, loserNames, ratings);

  entry.members.forEach((member) => {
    const prior = priorRanks[member.name];
    const updated = results[member.name];
    if (!entry.bots.has(member.id)) {
      savePlayerRank(DATA_FILE, member.name, {
        rating: updated.rating,
        wins: prior.wins + updated.wins,
        losses: prior.losses + updated.losses,
      });
    }

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
// günstiger No-op. Der eigentliche Zug wird erst nach einer kurzen
// künstlichen "Bedenkzeit" ausgeführt (siehe botThinkDelayMs()), damit Bots
// nicht unnatürlich sofort reagieren – bis dahin zeigt das Frontend den
// Bot-Sitzplatz ganz normal als "am Zug" an (state.actingPlayerId ändert
// sich erst mit dem tatsächlichen Zug). Rekursion ist unproblematisch, da
// eine Hand nur endlich viele Aktionen hat.
function maybeTriggerBotActions(code) {
  const entry = getMatchEntry(code);
  if (!entry || !entry.bots || entry.bots.size === 0) return;
  const table = rooms.getTable(code);
  if (!table) return;

  const current = table.getCurrentPlayer();
  if (!current || !entry.bots.has(current.id)) return;

  setTimeout(() => {
    // Zustand nach der Verzögerung erneut prüfen: Raum/Tisch könnten in der
    // Zwischenzeit verschwunden sein (z. B. der letzte Mensch hat den Raum
    // verlassen und die Gnadenfrist ist abgelaufen).
    const stillTable = rooms.getTable(code);
    const stillEntry = getMatchEntry(code);
    if (!stillTable || !stillEntry || !stillEntry.bots) return;
    const stillCurrent = stillTable.getCurrentPlayer();
    if (!stillCurrent || !stillEntry.bots.has(stillCurrent.id)) return;

    const tier = stillEntry.bots.get(stillCurrent.id).tier;
    const decision = decideBotAction(stillTable, stillCurrent.id, tier);
    try {
      applyBotDecision(stillTable, stillCurrent.id, decision);
    } catch (err) {
      // Sollte dank der Legalitäts-Garantien von decideBotAction() nie
      // passieren – als letzte Absicherung folden, damit die Hand nicht
      // hängen bleibt, statt den ganzen Raum lahmzulegen.
      stillTable.fold(stillCurrent.id);
    }
    advancePhaseIfRoundComplete(stillTable);
    broadcastRoomState(code);
    dispatchMatchFinishIfShowdown(code, stillTable);
    persist();

    maybeTriggerBotActions(code); // ggf. ist gleich der nächste Bot dran
  }, botThinkDelayMs());
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
  // Welche Sitzplätze Bots sind (egal aus welchem Modus, siehe
  // getMatchEntry()) – das Frontend nutzt das für den "Denkt nach …"-
  // Indikator an JEDEM Bot-Sitzplatz, nicht nur im reinen Übungsmodus
  // (dort waren vorher alle Gegner automatisch Bots, siehe isVsBots in
  // app.js; jetzt können auch Ranked/Casual-Matches einzelne Bot-
  // Mitspieler/-Gegner neben echten Menschen enthalten).
  const matchEntry = getMatchEntry(code);
  const botIds = matchEntry && matchEntry.bots ? [...matchEntry.bots.keys()] : [];
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
    if (botIds.length > 0) state.botIds = botIds;
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
