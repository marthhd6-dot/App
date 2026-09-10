// public/app.js
// Kein Build-Schritt nötig: reines Browser-JS, verbindet sich per Socket.io
// mit src/server.js und rendert den öffentlichen Tisch-Zustand.

const RANK_LABELS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const PHASE_LABELS = {
  waiting: 'Warte auf Spieler',
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
};
const AVATAR_COLORS = ['#e8bf4a', '#6de3ac', '#ff8a8a', '#8ec9ff', '#d9a6ff', '#ffb46b', '#7fe0e0', '#f6a6c1'];
const CONFETTI_COLORS = ['#e8bf4a', '#35d68a', '#ff5c5c', '#6fb4ff', '#d9a6ff', '#ffd569'];

const SESSION_KEY = 'pokerSession'; // { code, name } des zuletzt beigetretenen Raums
const FRIENDS_KEY = 'pokerFriends'; // Freundesliste (nur Namen) – rein lokal im Browser, siehe README
const FRIENDS_POLL_MS = 5000; // wie oft der Online-Status der Freunde bei geöffnetem Panel aktualisiert wird
const ACCOUNT_TOKEN_KEY = 'pokerAccountToken'; // Session-Token nach Login/Registrierung, siehe README
const COOKIE_CONSENT_KEY = 'pokerCookieNoticeAck'; // einmalige Bestätigung des Speicher-Hinweis-Banners

// window.POKER_SERVER_URL kommt aus server-config.js (vor diesem Skript
// geladen, siehe index.html): leer im normalen Browser-Betrieb (io()
// verbindet sich dann wie bisher automatisch mit dem eigenen Origin), eine
// echte URL innerhalb einer nativen App ohne eigenen Server auf demselben
// Origin (siehe dortige Kommentare).
const socket = io(window.POKER_SERVER_URL || undefined);
let mySocketId = null;
let myName = '';
let joinedRoomCode = null;
let isRanked = false;
let isCasual4 = false;
let isRankedTeam = false;
let isCasualTeam = false;
let isVsBots = false;
// 'ranked' | 'casual' | 'ranked-team' | 'casual-team' – bestimmt, welches
// leave-*-queue-Event der Abbrechen-Button feuert.
let queueType = null;
let lastPhase = null; // für Deal-Animationen: erkennt den Beginn einer neuen Hand
let communityDealtCount = 0;
let prevState = null; // vorheriger state-Snapshot, für Aktions-Effekte (siehe detectAndShowActionFx)
let wasMyTurn = false; // erkennt den Beginn meines Zugs, um den Bet-Schieberegler frisch auf das Minimum zu setzen
let betSizerBounds = { min: 0, max: 0, pot: 0 }; // aktuell legale Bet-/Raise-Grenzen, siehe renderBetSizer()
let isLoggedIn = false;
let pendingRankPathView = false; // wartet der "Mein Rang"-Button auf die nächste rank-info-Antwort?
let pendingBotsSetupView = false; // wartet der "Gegen Bots üben"-Button auf die nächste rank-info-Antwort?
let selectedBotCount = 1;
let selectedBotDifficulty = null;

// Freundesliste: nur Namen, gespeichert im localStorage dieses Browsers.
// Der Server kennt keine Freundschaften, nur wer gerade online ist (siehe
// README) – onlineFriends wird per get-friends-status/friends-status
// aktualisiert, solange das Freunde-Panel geöffnet ist.
function loadFriends() {
  try {
    const saved = JSON.parse(localStorage.getItem(FRIENDS_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}
let friends = loadFriends();
let onlineFriends = new Set();
let friendsPollTimer = null;

const screens = {
  join: document.getElementById('join-screen'),
  queue: document.getElementById('queue-screen'),
  leaderboard: document.getElementById('leaderboard-screen'),
  rank: document.getElementById('rank-screen'),
  bots: document.getElementById('bots-screen'),
  table: document.getElementById('table-screen'),
};
function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.hidden = key !== name;
  });
}

const tableScreen = document.getElementById('table-screen');
const nameInput = document.getElementById('name-input');
const roomCodeInput = document.getElementById('room-code-input');
const joinErrorEl = document.getElementById('join-error');
const errorBanner = document.getElementById('error-banner');
const reconnectBanner = document.getElementById('reconnect-banner');
const handResultEl = document.getElementById('hand-result');
const rankedBadge = document.getElementById('ranked-badge');
const casual4Badge = document.getElementById('casual4-badge');
const rankedTeamBadge = document.getElementById('ranked-team-badge');
const casualTeamBadge = document.getElementById('casual-team-badge');
const botsBadge = document.getElementById('bots-badge');
const rankedMatchOverBanner = document.getElementById('ranked-match-over-banner');
const teammateHandEl = document.getElementById('teammate-hand');
const showdownRevealEl = document.getElementById('showdown-reveal');
const showdownRevealListEl = document.getElementById('showdown-reveal-list');

const foldBtn = document.getElementById('fold-btn');
const checkBtn = document.getElementById('check-btn');
const callBtn = document.getElementById('call-btn');
const betBtn = document.getElementById('bet-btn');
const raiseBtn = document.getElementById('raise-btn');
const startHandBtn = document.getElementById('start-hand-btn');
const rebuyBanner = document.getElementById('rebuy-banner');
const turnTimerEl = document.getElementById('turn-timer');
const betSizerEl = document.getElementById('bet-sizer');
const betAmountSlider = document.getElementById('bet-amount-slider');
// Ein einziges Betragsfeld für Bet UND Raise (früher zwei getrennte
// Zahlenfelder plus eine reine Anzeige): Beide Aktionen brauchen denselben
// Wert, und die doppelte Eingabe kostete eine komplette zusätzliche Zeile
// in der Aktions-Leiste – genau die Zeile, die sie unter die Falz schob.
const betAmountInput = document.getElementById('bet-amount-input');
const quarterPotBtn = document.getElementById('quarter-pot-btn');
const halfPotBtn = document.getElementById('half-pot-btn');
const allInBtn = document.getElementById('all-in-btn');

socket.on('connect', () => {
  mySocketId = socket.id;
  attemptAutoRejoin();
  const savedToken = localStorage.getItem(ACCOUNT_TOKEN_KEY);
  if (savedToken) socket.emit('login-with-token', { token: savedToken });
});

// Feuert, wenn die Verbindung abbricht (Netzwerk-Aussetzer, Server-Neustart
// o. Ä.). Der Socket versucht danach automatisch, sich neu zu verbinden;
// sobald 'connect' erneut feuert, holt attemptAutoRejoin() uns zurück in
// den Raum, falls wir schon einem beigetreten waren.
socket.on('disconnect', () => {
  if (joinedRoomCode) {
    reconnectBanner.hidden = false;
  }
});

socket.on('state', render);

socket.on('room-joined', ({ code, ranked, casual4, rankedTeam, casualTeam, vsBots }) => {
  joinedRoomCode = code;
  isRanked = Boolean(ranked);
  isCasual4 = Boolean(casual4);
  isRankedTeam = Boolean(rankedTeam);
  isCasualTeam = Boolean(casualTeam);
  isVsBots = Boolean(vsBots);
  lastPhase = null;
  communityDealtCount = 0;
  prevState = null;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, name: myName }));
  // Chat des neuen Raums frisch laden (siehe get-chat-history im Server)
  chatMessagesEl.innerHTML = '';
  chatDrawer.hidden = true;
  unreadChatCount = 0;
  renderChatUnread();
  socket.emit('get-chat-history');
  reconnectBanner.hidden = true;
  rankedMatchOverBanner.hidden = true;
  rankedBadge.hidden = !isRanked;
  casual4Badge.hidden = !isCasual4;
  rankedTeamBadge.hidden = !isRankedTeam;
  casualTeamBadge.hidden = !isCasualTeam;
  botsBadge.hidden = !isVsBots;
  document.getElementById('room-code-label').textContent = `Raum: ${code}`;
  showScreen('table');
  renderFriendsList(); // "Einladen" ist erst ab hier möglich (siehe joinedRoomCode)
});

socket.on('queue-status', ({ waiting }) => {
  showScreen(waiting ? 'queue' : 'join');
});

socket.on('rank-info', ({ name, rating, tier, wins, losses, tiers }) => {
  const text = `${name}: ${tier} (${rating}) · ${wins}S/${losses}N`;
  const myRankLabel = document.getElementById('my-rank-label');
  myRankLabel.textContent = text;
  myRankLabel.hidden = false;
  // In den Casual-Queue-Screens ist das Rating irrelevant (kein
  // Rating-Bezug), daher hier nicht anzeigen – auch nicht, wenn eine durchs
  // blur-Event ausgelöste get-rank-Antwort erst nach dem Wechsel in die
  // Casual-Queue eintrifft.
  if (queueType !== 'casual' && queueType !== 'casual-team') {
    document.getElementById('queue-rank-label').textContent = text;
  }
  // "Mein Rang"-Button wurde geklickt und wartet auf diese Antwort, um den
  // Rang-Pfad zu zeichnen (siehe rank-path-btn weiter unten).
  if (pendingRankPathView && tiers) {
    pendingRankPathView = false;
    renderRankPath({ name, rating, tier, wins, losses, tiers });
    showScreen('rank');
  }
  // "Gegen Bots üben"-Button wurde geklickt: dieselben tiers (Bronze bis
  // Champion) wie im Rang-Pfad bestimmen die wählbaren Bot-Schwierigkeiten,
  // damit die Namen nicht zusätzlich im Frontend dupliziert werden müssen.
  if (pendingBotsSetupView && tiers) {
    pendingBotsSetupView = false;
    renderBotDifficultyOptions(tiers);
    showScreen('bots');
  }
});

socket.on('leaderboard', (entries) => {
  const list = document.getElementById('leaderboard-list');
  list.innerHTML = '';
  if (entries.length === 0) {
    list.textContent = 'Noch keine gewerteten Matches gespielt.';
  } else {
    entries.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'leaderboard-row';
      row.innerHTML = `
        <span class="leaderboard-rank">#${i + 1}</span>
        <span class="leaderboard-name">${escapeHtml(p.name)}</span>
        <span class="tier-badge tier-${p.tier.toLowerCase()}">${p.tier}</span>
        <span class="leaderboard-rating">${p.rating}</span>
        <span class="leaderboard-record">${p.wins}S/${p.losses}N</span>
      `;
      list.appendChild(row);
    });
  }
  showScreen('leaderboard');
});

socket.on('ranked-match-over', ({ place, totalPlayers, newRating, newTier, ratingChange }) => {
  const outcome = place === 1 ? 'Sieg' : `Platz ${place} von ${totalPlayers}`;
  const sign = ratingChange >= 0 ? '+' : '';
  document.getElementById('ranked-match-over-text').textContent =
    `${outcome}! Neuer Rang: ${newTier} (${newRating}, ${sign}${ratingChange})`;
  rankedMatchOverBanner.hidden = false;
  if (place === 1) burstConfetti();
});

// Casual-4-Matches haben keine Rating-Auswirkung, daher nur der Platz.
// Nutzt dieselbe Banner-Anzeige wie ranked-match-over.
socket.on('casual-match-over', ({ place, totalPlayers }) => {
  const outcome = place === 1 ? 'Sieg' : `Platz ${place} von ${totalPlayers}`;
  document.getElementById('ranked-match-over-text').textContent = `${outcome}! Gutes Spiel.`;
  rankedMatchOverBanner.hidden = false;
  if (place === 1) burstConfetti();
});

socket.on('ranked-team-match-over', ({ won, newRating, newTier, ratingChange }) => {
  const outcome = won ? 'Team-Sieg' : 'Team-Niederlage';
  const sign = ratingChange >= 0 ? '+' : '';
  document.getElementById('ranked-match-over-text').textContent =
    `${outcome}! Neuer Rang: ${newTier} (${newRating}, ${sign}${ratingChange})`;
  rankedMatchOverBanner.hidden = false;
  if (won) burstConfetti();
});

// 2v2-Casual-Matches haben keine Rating-Auswirkung, daher nur Sieg/Niederlage.
socket.on('casual-team-match-over', ({ won }) => {
  document.getElementById('ranked-match-over-text').textContent = `${won ? 'Team-Sieg' : 'Team-Niederlage'}! Gutes Spiel.`;
  rankedMatchOverBanner.hidden = false;
  if (won) burstConfetti();
});

// Bot-Übungsmatches haben ebenfalls keine Rating-Auswirkung.
socket.on('vs-bots-over', ({ won }) => {
  document.getElementById('ranked-match-over-text').textContent = `${won ? 'Sieg gegen die Bots' : 'Niederlage'}! Gutes Spiel.`;
  rankedMatchOverBanner.hidden = false;
  if (won) burstConfetti();
});

socket.on('friends-status', ({ online }) => {
  onlineFriends = new Set(online);
  renderFriendsList();
});

// Ein Freund hat uns per Freundesliste in seinen Raum eingeladen.
socket.on('friend-invite', ({ fromName, roomCode }) => {
  document.getElementById('friend-invite-text').textContent = `${fromName} lädt dich zu Raum ${roomCode} ein.`;
  const banner = document.getElementById('friend-invite-banner');
  banner.hidden = false;
  banner.dataset.roomCode = roomCode;
});

// Nach Registrierung, Login oder automatischem Wieder-Einloggen per Token
// (siehe 'connect'-Handler oben): Name fest auf den Account-Namen setzen
// und das Namensfeld sperren, damit niemand aus Versehen unter einem
// anderen Namen spielt (der Server würde das ohnehin überschreiben, siehe
// resolveName() in server.js – das hier ist nur für ein stimmiges UI).
socket.on('login-success', ({ username, token }) => {
  isLoggedIn = true;
  myName = username;
  localStorage.setItem(ACCOUNT_TOKEN_KEY, token);
  nameInput.value = username;
  nameInput.disabled = true;
  document.getElementById('account-btn').hidden = true;
  document.getElementById('logout-btn').hidden = false;
  document.getElementById('account-error').hidden = true;
  // Über closeAccountOverlay(), damit auch nach erfolgreichem Login der
  // Fokus wieder dort landet, wo der Dialog geöffnet wurde – der
  // Account-Knopf selbst ist danach ausgeblendet, dann greift die
  // Sichtbarkeitsprüfung in dialogGeschlossen().
  closeAccountOverlay();
  socket.emit('get-rank', { name: username });
});

socket.on('account-error', ({ message }) => {
  const el = document.getElementById('account-error');
  el.textContent = message;
  el.hidden = false;
});

// Nach jedem (Wieder-)Verbinden: Wenn wir laut sessionStorage schon in
// einem Raum waren, automatisch mit demselben Namen erneut beitreten.
// Innerhalb der Gnadenfrist des Servers bekommen wir dadurch nahtlos
// unseren alten Platz samt Chips und Karten zurück.
function attemptAutoRejoin() {
  const saved = sessionStorage.getItem(SESSION_KEY);
  if (!saved) return;
  try {
    const { code, name } = JSON.parse(saved);
    if (!code) return;
    myName = name || '';
    socket.emit('join-room', { code, name: myName });
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
  }
}

let errorTimer = null;
socket.on('error-message', (message) => {
  // Solange wir noch keinem Raum beigetreten sind, zeigen wir den Fehler
  // direkt auf dem Join-Screen (z. B. "Raum nicht gefunden").
  const target = tableScreen.hidden ? joinErrorEl : errorBanner;
  target.textContent = message;
  target.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    target.hidden = true;
  }, 4000);
});

document.getElementById('create-room-btn').addEventListener('click', () => {
  myName = nameInput.value.trim();
  socket.emit('create-room', { name: myName });
});

document.getElementById('join-room-btn').addEventListener('click', joinRoom);
roomCodeInput.addEventListener('input', () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase();
});
roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});

function joinRoom() {
  myName = nameInput.value.trim();
  socket.emit('join-room', { code: roomCodeInput.value.trim(), name: myName });
}

nameInput.addEventListener('blur', () => {
  const trimmed = nameInput.value.trim();
  if (trimmed) {
    socket.emit('get-rank', { name: trimmed });
    // Meldet den Namen schon vorm Beitreten als "online", damit Freunde
    // diesen Spieler sofort in ihrer Freundesliste sehen können.
    socket.emit('set-name', { name: trimmed });
  }
});

document.getElementById('ranked-queue-btn').addEventListener('click', () => {
  myName = nameInput.value.trim();
  if (!myName) {
    joinErrorEl.textContent = 'Bitte gib zuerst einen Namen ein.';
    joinErrorEl.hidden = false;
    return;
  }
  queueType = 'ranked';
  socket.emit('get-rank', { name: myName });
  socket.emit('join-ranked-queue', { name: myName });
});

document.getElementById('casual4-queue-btn').addEventListener('click', () => {
  myName = nameInput.value.trim();
  if (!myName) {
    joinErrorEl.textContent = 'Bitte gib zuerst einen Namen ein.';
    joinErrorEl.hidden = false;
    return;
  }
  queueType = 'casual';
  document.getElementById('queue-rank-label').textContent = '';
  socket.emit('join-casual-queue', { name: myName });
});

document.getElementById('ranked-team-queue-btn').addEventListener('click', () => {
  myName = nameInput.value.trim();
  if (!myName) {
    joinErrorEl.textContent = 'Bitte gib zuerst einen Namen ein.';
    joinErrorEl.hidden = false;
    return;
  }
  queueType = 'ranked-team';
  socket.emit('get-rank', { name: myName });
  socket.emit('join-ranked-team-queue', { name: myName });
});

document.getElementById('casual-team-queue-btn').addEventListener('click', () => {
  myName = nameInput.value.trim();
  if (!myName) {
    joinErrorEl.textContent = 'Bitte gib zuerst einen Namen ein.';
    joinErrorEl.hidden = false;
    return;
  }
  queueType = 'casual-team';
  document.getElementById('queue-rank-label').textContent = '';
  socket.emit('join-casual-team-queue', { name: myName });
});

const LEAVE_QUEUE_EVENTS = {
  ranked: 'leave-ranked-queue',
  casual: 'leave-casual-queue',
  'ranked-team': 'leave-ranked-team-queue',
  'casual-team': 'leave-casual-team-queue',
};
document.getElementById('cancel-queue-btn').addEventListener('click', () => {
  const leaveEvent = LEAVE_QUEUE_EVENTS[queueType];
  if (leaveEvent) socket.emit(leaveEvent);
});

document.getElementById('leaderboard-btn').addEventListener('click', () => {
  socket.emit('get-leaderboard');
});

document.getElementById('leaderboard-close-btn').addEventListener('click', () => {
  showScreen('join');
});

document.getElementById('rank-path-btn').addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) {
    joinErrorEl.textContent = 'Bitte gib zuerst einen Namen ein.';
    joinErrorEl.hidden = false;
    return;
  }
  pendingRankPathView = true;
  socket.emit('get-rank', { name });
});

document.getElementById('rank-close-btn').addEventListener('click', () => {
  showScreen('join');
});

document.getElementById('ranked-back-to-menu-btn').addEventListener('click', () => {
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
});

// Verlässt den Tisch jederzeit während des Spiels (nicht nur nach
// Matchende) und kehrt zum Hauptmenü zurück. Wie beim "Neues Match
// suchen"-Button oben: sessionStorage.SESSION_KEY löschen (verhindert den
// automatischen Wieder-Beitritt in attemptAutoRejoin() beim nächsten
// 'connect') und die Seite neu laden – der alte Socket trennt sich dabei,
// der Server behandelt das serverseitig wie jeden anderen
// Verbindungsabbruch (Gnadenfrist, danach Entfernen vom Tisch, siehe
// README "Reconnect-Handling").
document.getElementById('leave-table-btn').addEventListener('click', () => {
  const confirmed = window.confirm('Tisch wirklich verlassen und zum Hauptmenü zurückkehren?');
  if (!confirmed) return;
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
});

// --- Gegen Bots üben -------------------------------------------------------

document.getElementById('bots-setup-btn').addEventListener('click', () => {
  myName = nameInput.value.trim();
  if (!myName) {
    joinErrorEl.textContent = 'Bitte gib zuerst einen Namen ein.';
    joinErrorEl.hidden = false;
    return;
  }
  pendingBotsSetupView = true;
  socket.emit('get-rank', { name: myName });
});

document.querySelectorAll('.bot-count-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedBotCount = Number(btn.dataset.count);
    document.querySelectorAll('.bot-count-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
  });
});

// Baut die Schwierigkeits-Auswahl aus denselben tiers, die auch der
// Rang-Pfad bekommt (siehe rank-info-Handler oben) – wiederverwendet die
// bestehenden .tier-badge-Farben, damit eine Bot-Schwierigkeit optisch
// sofort demselben Rang zuzuordnen ist.
function renderBotDifficultyOptions(tiers) {
  const container = document.getElementById('bot-difficulty-options');
  container.innerHTML = '';
  if (!selectedBotDifficulty) selectedBotDifficulty = tiers[0].name;
  tiers.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'tier-badge bot-difficulty-btn tier-' + t.name.toLowerCase() + (t.name === selectedBotDifficulty ? ' selected' : '');
    btn.textContent = t.name;
    btn.addEventListener('click', () => {
      selectedBotDifficulty = t.name;
      container.querySelectorAll('.bot-difficulty-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    container.appendChild(btn);
  });
}

document.getElementById('bots-start-btn').addEventListener('click', () => {
  socket.emit('play-vs-bots', { name: myName, botCount: selectedBotCount, difficulty: selectedBotDifficulty });
});

document.getElementById('bots-close-btn').addEventListener('click', () => {
  showScreen('join');
});

// --- Dialog-Verhalten (Tastatur & Fokus) ----------------------------------
// Gemeinsames Verhalten für alle Overlays (Account, Freunde, Hilfe, Chat).
// Vorher ließen sie sich ausschließlich über ihren Schließen-Knopf beenden,
// der Fokus blieb dahinter im Hintergrund hängen und man konnte per Tab aus
// dem geöffneten Dialog heraus in den verdeckten Tisch tabben.
// Umgesetzt sind die üblichen Konventionen für modale Dialoge (WAI-ARIA
// "Dialog (Modal)"-Muster, wie es auch shadcn/ui über Radix anwendet):
//   - Escape schließt
//   - Klick auf den abgedunkelten Hintergrund schließt
//   - beim Öffnen wandert der Fokus in den Dialog
//   - Tab bleibt im Dialog gefangen (Fokusfalle)
//   - beim Schließen kehrt der Fokus auf das auslösende Element zurück
//
// Die Chat-Schublade läuft bewusst als NICHT-modaler Dialog: Sie verdeckt
// den Tisch nicht vollständig, das Spiel läuft daneben weiter – Escape und
// Fokus-Rückgabe gelten, eine Fokusfalle wäre hier aber falsch, weil man
// jederzeit zurück an den Tisch tabben können muss.

const FOKUSSIERBAR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let offenerDialog = null; // { element, schliessen, ausloeser, modal }

function fokussierbareElemente(element) {
  // offsetParent === null filtert alles aus, was gerade ausgeblendet ist
  // (z. B. der "Abmelden"-Knopf oder ein hidden Fehler-Banner).
  return [...element.querySelectorAll(FOKUSSIERBAR)].filter((el) => el.offsetParent !== null);
}

// element: das sichtbar werdende Overlay, schliessen: dessen eigene
// Schließen-Funktion (damit Aufräumarbeiten wie das Stoppen des
// Freunde-Pollings nicht doppelt gepflegt werden müssen).
function dialogOeffnen(element, schliessen, { modal = true } = {}) {
  const ausloeser = document.activeElement;
  element.hidden = false;
  offenerDialog = { element, schliessen, ausloeser, modal };
  const ziele = fokussierbareElemente(element);
  if (ziele.length > 0) ziele[0].focus();
}

// Von jeder Schließen-Funktion aufzurufen, NACHDEM das Overlay versteckt
// wurde – gibt den Fokus an das Element zurück, das den Dialog geöffnet hat.
function dialogGeschlossen(element) {
  if (!offenerDialog || offenerDialog.element !== element) return;
  const { ausloeser } = offenerDialog;
  offenerDialog = null;
  if (ausloeser && typeof ausloeser.focus === 'function' && ausloeser.offsetParent !== null) {
    ausloeser.focus();
  }
}

document.addEventListener('keydown', (e) => {
  if (!offenerDialog) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    offenerDialog.schliessen();
    return;
  }

  if (e.key !== 'Tab' || !offenerDialog.modal) return;

  const ziele = fokussierbareElemente(offenerDialog.element);
  if (ziele.length === 0) return;
  const erstes = ziele[0];
  const letztes = ziele[ziele.length - 1];

  // Am Rand angekommen auf die andere Seite springen; steht der Fokus
  // (etwa nach einem Klick daneben) außerhalb des Dialogs, ihn zurückholen.
  if (!offenerDialog.element.contains(document.activeElement)) {
    e.preventDefault();
    erstes.focus();
  } else if (e.shiftKey && document.activeElement === erstes) {
    e.preventDefault();
    letztes.focus();
  } else if (!e.shiftKey && document.activeElement === letztes) {
    e.preventDefault();
    erstes.focus();
  }
});

// Klick auf den abgedunkelten Hintergrund schließt – nur wenn der Klick
// wirklich der Hintergrundfläche selbst gilt und nicht dem Panel darin.
document.addEventListener('mousedown', (e) => {
  if (!offenerDialog || !offenerDialog.modal) return;
  if (e.target === offenerDialog.element) offenerDialog.schliessen();
});

// --- Account -------------------------------------------------------------

const accountOverlay = document.getElementById('account-overlay');
const accountErrorEl = document.getElementById('account-error');

function closeAccountOverlay() {
  accountOverlay.hidden = true;
  dialogGeschlossen(accountOverlay);
}

document.getElementById('account-btn').addEventListener('click', () => {
  accountErrorEl.hidden = true;
  dialogOeffnen(accountOverlay, closeAccountOverlay);
});

document.getElementById('account-close-btn').addEventListener('click', closeAccountOverlay);

function submitAccountForm(eventName) {
  const username = document.getElementById('account-username-input').value.trim();
  const password = document.getElementById('account-password-input').value;
  accountErrorEl.hidden = true;
  if (!username) {
    accountErrorEl.textContent = 'Bitte gib einen Nutzernamen ein.';
    accountErrorEl.hidden = false;
    return;
  }
  socket.emit(eventName, { username, password });
}

document.getElementById('login-btn').addEventListener('click', () => submitAccountForm('login-account'));
document.getElementById('register-btn').addEventListener('click', () => submitAccountForm('register-account'));

document.getElementById('logout-btn').addEventListener('click', () => {
  const token = localStorage.getItem(ACCOUNT_TOKEN_KEY);
  socket.emit('logout-account', { token });
  localStorage.removeItem(ACCOUNT_TOKEN_KEY);
  isLoggedIn = false;
  myName = '';
  nameInput.value = '';
  nameInput.disabled = false;
  document.getElementById('account-btn').hidden = false;
  document.getElementById('logout-btn').hidden = true;
  document.getElementById('my-rank-label').hidden = true;
});

// --- Freundesliste -----------------------------------------------------

const friendsOverlay = document.getElementById('friends-overlay');
const friendsErrorEl = document.getElementById('friends-error');

function openFriendsOverlay() {
  dialogOeffnen(friendsOverlay, closeFriendsOverlay);
  renderFriendsList();
  refreshFriendsStatus();
  clearInterval(friendsPollTimer);
  friendsPollTimer = setInterval(refreshFriendsStatus, FRIENDS_POLL_MS);
}

function closeFriendsOverlay() {
  friendsOverlay.hidden = true;
  clearInterval(friendsPollTimer);
  dialogGeschlossen(friendsOverlay);
}

function refreshFriendsStatus() {
  if (friends.length > 0) socket.emit('get-friends-status', { names: friends });
}

document.getElementById('friends-btn').addEventListener('click', openFriendsOverlay);
document.getElementById('friends-btn-table').addEventListener('click', openFriendsOverlay);
document.getElementById('friends-close-btn').addEventListener('click', closeFriendsOverlay);

// Sound-Stumm-Schalter: Zustand kommt aus sound.js (COOKIE_CONSENT_KEY-
// artig in localStorage gemerkt, siehe SOUND_MUTED_KEY dort).
const soundToggleBtn = document.getElementById('sound-toggle-btn');
function updateSoundToggleBtn() {
  const muted = isSoundMuted();
  soundToggleBtn.textContent = muted ? '🔇' : '🔊';
  soundToggleBtn.title = muted ? 'Sound ist aus – klicken zum Einschalten' : 'Sound ist an – klicken zum Ausschalten';
  soundToggleBtn.setAttribute('aria-label', soundToggleBtn.title);
}
updateSoundToggleBtn();
soundToggleBtn.addEventListener('click', () => {
  setSoundMuted(!isSoundMuted());
  updateSoundToggleBtn();
  if (!isSoundMuted()) playUiClickSound();
});

document.getElementById('add-friend-btn').addEventListener('click', addFriend);
document.getElementById('friend-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addFriend();
});

function addFriend() {
  const input = document.getElementById('friend-name-input');
  const name = input.value.trim();
  friendsErrorEl.hidden = true;
  if (!name) return;
  if (name === myName) {
    friendsErrorEl.textContent = 'Das bist du selbst.';
    friendsErrorEl.hidden = false;
    return;
  }
  if (friends.includes(name)) {
    friendsErrorEl.textContent = `${name} ist schon in deiner Freundesliste.`;
    friendsErrorEl.hidden = false;
    return;
  }
  friends.push(name);
  localStorage.setItem(FRIENDS_KEY, JSON.stringify(friends));
  input.value = '';
  renderFriendsList();
  refreshFriendsStatus();
}

// Klicks auf "Einladen"/"Entfernen" innerhalb der Liste per Event-
// Delegation behandeln, statt bei jedem Rendern neue Listener anzuhängen.
document.getElementById('friends-list').addEventListener('click', (e) => {
  const inviteBtn = e.target.closest('.btn-invite-friend');
  if (inviteBtn) {
    socket.emit('invite-friend', { friendName: inviteBtn.dataset.name });
    return;
  }
  const removeBtn = e.target.closest('.btn-remove-friend');
  if (removeBtn) {
    friends = friends.filter((f) => f !== removeBtn.dataset.name);
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(friends));
    renderFriendsList();
  }
});

function renderFriendsList() {
  const list = document.getElementById('friends-list');
  if (!list) return;
  list.innerHTML = '';
  if (friends.length === 0) {
    list.textContent = 'Noch keine Freunde hinzugefügt.';
    return;
  }
  friends.forEach((name) => {
    const isOnline = onlineFriends.has(name);
    const canInvite = isOnline && Boolean(joinedRoomCode);
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.innerHTML = `
      <span class="friend-status ${isOnline ? 'online' : 'offline'}" title="${isOnline ? 'Online' : 'Offline'}"></span>
      <span class="friend-name">${escapeHtml(name)}</span>
      <button class="btn btn-small btn-invite-friend" data-name="${escapeHtml(name)}" ${canInvite ? '' : 'disabled'}>
        Einladen
      </button>
      <button class="btn btn-ghost btn-small btn-remove-friend" data-name="${escapeHtml(name)}">✕</button>
    `;
    list.appendChild(row);
  });
}
renderFriendsList();

document.getElementById('friend-invite-dismiss-btn').addEventListener('click', () => {
  document.getElementById('friend-invite-banner').hidden = true;
});

// Speicher-/Cookie-Hinweis: einmalig anzeigen, bis er bestätigt wurde
// (siehe cookies.html für die vollständige Richtlinie).
try {
  if (!localStorage.getItem(COOKIE_CONSENT_KEY)) {
    document.getElementById('cookie-banner').hidden = false;
  }
} catch {
  // localStorage nicht verfügbar (z. B. deaktiviert) – Banner einfach nicht zeigen
}
document.getElementById('cookie-banner-ack-btn').addEventListener('click', () => {
  document.getElementById('cookie-banner').hidden = true;
  try {
    localStorage.setItem(COOKIE_CONSENT_KEY, '1');
  } catch {
    // ignorieren, siehe oben
  }
});

document.getElementById('friend-invite-join-btn').addEventListener('click', () => {
  const banner = document.getElementById('friend-invite-banner');
  const code = banner.dataset.roomCode;
  banner.hidden = true;
  if (!code) return;
  myName = nameInput.value.trim() || myName;
  socket.emit('join-room', { code, name: myName });
});

// --- Rang-Pfad ("Mein Rang") ---------------------------------------------

// Zeichnet alle Ränge (Bronze bis Champion, aus tiers – siehe RANK_TIERS in
// ranking.js, vom Server mitgeschickt) als Pfad, hebt den aktuellen Rang
// hervor und zeigt den Fortschritt bis zum nächsten Rang als Balken.
function renderRankPath({ name, rating, tier, wins, losses, tiers }) {
  document.getElementById('rank-path-name').textContent = `${name} · ${wins}S/${losses}N`;

  const container = document.getElementById('rank-path');
  container.innerHTML = '';
  const currentIdx = tiers.findIndex((t) => t.name === tier);

  tiers.forEach((t, i) => {
    const isCurrent = i === currentIdx;
    const reached = i <= currentIdx;
    const node = document.createElement('div');
    node.className = 'rank-node' + (isCurrent ? ' current' : '') + (reached ? ' reached' : '');
    node.innerHTML = `
      <span class="tier-badge tier-${t.name.toLowerCase()}">${t.name}</span>
      <span class="rank-node-min">${t.min}+</span>
    `;
    container.appendChild(node);
  });

  const progressLabel = document.getElementById('rank-path-progress');
  const progressFill = document.getElementById('rank-progress-fill');
  const nextTier = tiers[currentIdx + 1];
  if (nextTier) {
    const span = nextTier.min - tiers[currentIdx].min;
    const progressPct = Math.max(0, Math.min(100, Math.round(((rating - tiers[currentIdx].min) / span) * 100)));
    progressFill.style.width = `${progressPct}%`;
    progressLabel.textContent = `${rating} Rating · noch ${nextTier.min - rating} bis ${nextTier.name} (${progressPct}%)`;
  } else {
    progressFill.style.width = '100%';
    progressLabel.textContent = `${rating} Rating · höchster Rang erreicht!`;
  }
}

// Leiser, sofortiger Klick-Sound auf jeden Action-Bar-Button (Antwortzeit
// wirkt dadurch spürbar niedriger als das Warten auf die eigentliche
// Aktions-/Chip-Sound-Bestätigung aus detectAndShowActionFx, die erst mit
// dem nächsten Server-State eintrifft).
startHandBtn.addEventListener('click', () => {
  playUiClickSound();
  socket.emit('start-hand');
});
document.getElementById('rebuy-btn').addEventListener('click', () => {
  playUiClickSound();
  socket.emit('rebuy');
});
foldBtn.addEventListener('click', () => {
  playUiClickSound();
  socket.emit('fold');
});
checkBtn.addEventListener('click', () => {
  playUiClickSound();
  socket.emit('check');
});
callBtn.addEventListener('click', () => {
  playUiClickSound();
  socket.emit('call');
});
betBtn.addEventListener('click', () => {
  playUiClickSound();
  socket.emit('bet', { amount: Number(betAmountInput.value) });
});
raiseBtn.addEventListener('click', () => {
  playUiClickSound();
  socket.emit('raise', { amount: Number(betAmountInput.value) });
});

// Setzt Schieberegler und Betragsfeld synchron auf denselben, auf die
// aktuell legalen Grenzen geklemmten Betrag – genutzt sowohl vom
// Schieberegler selbst als auch von den ¼/½-Pot- und All-In-Knöpfen.
function setBetSizerValue(amount) {
  const { min, max } = betSizerBounds;
  if (max <= 0) return;
  const clamped = Math.min(max, Math.max(min, Math.round(amount)));
  betAmountSlider.value = clamped;
  betAmountInput.value = clamped;
}

betAmountSlider.addEventListener('input', () => setBetSizerValue(Number(betAmountSlider.value)));
quarterPotBtn.addEventListener('click', () => {
  playUiClickSound();
  setBetSizerValue(betSizerBounds.pot * 0.25);
});
halfPotBtn.addEventListener('click', () => {
  playUiClickSound();
  setBetSizerValue(betSizerBounds.pot * 0.5);
});
allInBtn.addEventListener('click', () => {
  playUiClickSound();
  setBetSizerValue(betSizerBounds.max);
});

// Manuelle Eingabe im Betragsfeld hält den Schieberegler synchron, damit
// beide Bedienwege (Regler vs. Zahl eintippen) denselben Betrag zeigen.
// Der eingetippte Wert selbst wird hier bewusst nicht überschrieben –
// sonst könnte man beim Tippen keine Zahl erreichen, die unterwegs
// kurzzeitig außerhalb der Grenzen liegt (z. B. "1" auf dem Weg zu "150").
betAmountInput.addEventListener('input', () => {
  if (betAmountInput.disabled || betSizerBounds.max <= 0) return;
  const val = Number(betAmountInput.value);
  if (!Number.isFinite(val)) return;
  betAmountSlider.value = Math.min(betSizerBounds.max, Math.max(betSizerBounds.min, val));
});

// Berechnet die aktuell legalen Bet-/Raise-Grenzen (siehe placeBet()/
// raise() in table.js für dieselbe Logik server-seitig, die hier nur zur
// Anzeige gespiegelt wird – verbindlich validiert wird immer noch dort)
// und hält Schieberegler + Schnellwahl-Knöpfe synchron dazu. Wird bei
// jedem Rendern aufgerufen, auch wenn gerade nicht ich am Zug bin (dann
// einfach deaktiviert).
function renderBetSizer(state, me, canBet, canRaise) {
  const active = (canBet || canRaise) && me;
  if (!active) {
    betSizerBounds = { min: 0, max: 0, pot: state.pot };
    betAmountSlider.min = 0;
    betAmountSlider.max = 0;
    betAmountSlider.value = 0;
    betAmountInput.value = '';
    betAmountSlider.disabled = true;
    quarterPotBtn.disabled = true;
    halfPotBtn.disabled = true;
    allInBtn.disabled = true;
    betSizerEl.classList.add('bet-sizer-disabled');
    return;
  }

  let min;
  let max;
  if (canBet) {
    max = me.chips;
    min = Math.min(state.bigBlind || 1, max);
  } else {
    max = me.bet + me.chips;
    min = Math.min(state.currentBet + (state.minRaise || state.bigBlind || 1), max);
  }
  min = Math.max(1, min);
  betSizerBounds = { min, max, pot: state.pot };

  betAmountSlider.min = min;
  betAmountSlider.max = max;
  betAmountSlider.disabled = false;
  quarterPotBtn.disabled = false;
  halfPotBtn.disabled = false;
  allInBtn.disabled = false;
  betSizerEl.classList.remove('bet-sizer-disabled');

  // Zu Beginn meines Zugs auf das Minimum zurücksetzen statt einen
  // Betrag aus einer ganz anderen Wettrunde/Hand stehen zu lassen;
  // innerhalb desselben Zugs (z. B. nach einem Re-Render durch eine
  // Chip-Flug-Animation) bleibt ein bereits gewählter Betrag erhalten.
  const isMyTurn = state.actingPlayerId === mySocketId;
  const justBecameMyTurn = isMyTurn && !wasMyTurn;
  if (justBecameMyTurn) {
    playYourTurnSound();
    hapticLight();
  }
  const current = justBecameMyTurn ? min : Number(betAmountSlider.value) || min;
  setBetSizerValue(current);
}

function isRedSuit(suit) {
  return suit === 'H' || suit === 'D';
}

function cardOuterHtml(card, extraClass = '') {
  const rank = RANK_LABELS[card.rank] || card.rank;
  const suit = SUIT_SYMBOLS[card.suit];
  return `<div class="card${isRedSuit(card.suit) ? ' red' : ''}${extraClass}">
    <span class="card-corner card-corner-top"><span class="card-rank">${rank}</span><span class="card-suit-mini">${suit}</span></span>
    <span class="card-suit-big">${suit}</span>
    <span class="card-corner card-corner-bottom"><span class="card-rank">${rank}</span><span class="card-suit-mini">${suit}</span></span>
  </div>`;
}

function renderCard(card, extraClass = '') {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = cardOuterHtml(card, extraClass).trim();
  return wrapper.firstElementChild;
}

// Rendert die Community Cards und animiert nur die seit dem letzten Rendern
// neu hinzugekommenen (Flop/Turn/River), statt bei jedem State-Update alle
// Karten erneut einfliegen zu lassen.
function renderCommunityCards(cards, previouslyDealt) {
  const container = document.getElementById('community-cards');
  container.innerHTML = '';
  const newlyDealt = Math.max(0, cards.length - previouslyDealt);
  cards.forEach((card, i) => {
    const el = renderCard(card);
    if (i >= previouslyDealt) {
      el.classList.add('deal-in');
      el.style.animationDelay = `${(i - previouslyDealt) * 0.12}s`;
    }
    container.appendChild(el);
  });
  if (newlyDealt > 0) playDealSound(newlyDealt);
}

const ABILITY_CATEGORY_LABELS = {
  cards: 'Karten',
  pot: 'Wette/Pot',
  intel: 'Info/Gegner',
  resource: 'Ressourcen',
};

// Rendert die eigenen vier Fähigkeiten-Karten (eine je Kategorie, siehe
// abilities.js) neben den eigenen Hole Cards. abilities kommt direkt aus
// state.players[...].abilities (siehe describeAbilitiesForClient() in
// table.js) – null, solange noch keine Hand gestartet wurde. Jede noch
// ungenutzte Karte ist klickbar und löst use-ability aus; eine bereits
// eingesetzte Karte bleibt bis zur nächsten Hand sichtbar, aber deaktiviert.
function renderAbilities(abilities) {
  const container = document.getElementById('my-abilities');
  container.innerHTML = '';
  if (!abilities) return;
  abilities.forEach((ability) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `ability-card ability-${ability.category}${ability.used ? ' ability-used' : ''}`;
    card.disabled = ability.used;
    card.title = ability.description;
    card.innerHTML = `
      <span class="ability-card-category">${ABILITY_CATEGORY_LABELS[ability.category] || ability.category}</span>
      <span class="ability-card-icon">${ability.icon}</span>
      <span class="ability-card-name">${escapeHtml(ability.name)}</span>
      <span class="ability-card-status">${ability.used ? 'Eingesetzt' : 'Einsetzen'}</span>
    `;
    card.addEventListener('click', () => {
      if (ability.used) return;
      playAbilitySound();
      socket.emit('use-ability', { category: ability.category });
    });
    container.appendChild(card);
  });
}

function renderMyCards(cards, animate, containerId = 'my-cards', playSound = true) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  cards.forEach((card, i) => {
    const el = renderCard(card);
    if (animate) {
      el.classList.add('deal-in');
      el.style.animationDelay = `${i * 0.12}s`;
    }
    container.appendChild(el);
  });
  if (animate && cards.length > 0 && playSound) playDealSound(cards.length);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function avatarColorFor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// Kreisposition (in % der Tisch-Breite/-Höhe) für den orderedIndex-ten
// Sitzplatz von insgesamt n – dieselbe Formel, die renderSeats() für die
// eigentlichen Sitzplatz-Elemente nutzt. Ausgelagert, damit auch die
// Effekt-Ebene (Aktions-Sprechblasen, Chip-Flug, Dealer-Button) Positionen
// berechnen kann, ohne die DOM-Elemente von renderSeats() abzufragen (die
// bei jedem State-Update komplett neu aufgebaut werden, siehe dort).
function seatPositionByOrderedIndex(orderedIndex, n) {
  const isNarrow = window.innerWidth <= 640;
  const rx = isNarrow ? 39 : 44;
  const ry = isNarrow ? 37 : 40;
  const angleRad = ((90 + (360 / n) * orderedIndex) * Math.PI) / 180;
  return { left: 50 + rx * Math.cos(angleRad), top: 50 + ry * Math.sin(angleRad) };
}

// Wie seatPositionByOrderedIndex, aber anhand einer Spieler-ID statt eines
// bereits bekannten Index – berücksichtigt dieselbe "eigener Platz unten
// in der Mitte"-Sortierung wie renderSeats(). Gibt null zurück, wenn der
// Spieler nicht (mehr) am Tisch sitzt.
function seatPositionForPlayer(state, playerId) {
  const n = state.players.length;
  const idx = state.players.findIndex((p) => p.id === playerId);
  if (n === 0 || idx === -1) return null;
  const myIndex = state.players.findIndex((p) => p.id === mySocketId);
  const startIndex = myIndex === -1 ? 0 : myIndex;
  const orderedIndex = (idx - startIndex + n) % n;
  return seatPositionByOrderedIndex(orderedIndex, n);
}

// Ordnet alle Spieler als "Sitzplätze" kreisförmig um den ovalen Tisch an –
// der eigene Platz liegt dabei immer unten in der Mitte. winnerIds enthält
// die Spieler, die die zuletzt gezeigte Hand gewonnen haben (leer, solange
// keine Hand beendet ist), damit ihr Sitzplatz golden hervorgehoben wird.
// animateDeal: true unmittelbar beim Start einer neuen Hand (siehe
// isNewHand in render()) – lässt die verdeckten Mini-Karten der Gegner
// reihum "eingeteilt" wirken (Stagger-Delay nach Sitzplatz-Reihenfolge),
// statt bei jedem State-Update neu einzufliegen. justRevealed: true genau
// in dem Render-Durchlauf, in dem ein echter Showdown gerade aufgelöst
// wurde (siehe justResolved in render()) – lässt die frisch aufgedeckten
// Gegner-Mini-Karten am Sitzplatz einmalig "umkippen" (siehe .reveal-flip),
// statt einfach kommentarlos zu erscheinen.
function renderSeats(state, winnerIds, animateDeal, justRevealed) {
  const container = document.getElementById('players-list');
  container.innerHTML = '';

  const n = state.players.length;
  if (n === 0) return;

  const myIndex = state.players.findIndex((p) => p.id === mySocketId);
  const startIndex = myIndex === -1 ? 0 : myIndex;
  const ordered = [];
  for (let i = 0; i < n; i++) {
    ordered.push(state.players[(startIndex + i) % n]);
  }

  ordered.forEach((p, i) => {
    const { left, top } = seatPositionByOrderedIndex(i, n);

    const team = state.teams ? state.teams[p.id] : undefined;
    const badges = [];
    if (team !== undefined) badges.push({ label: `TEAM ${team + 1}`, cls: `badge-team-${team}` });
    if (p.isAllIn) badges.push({ label: 'ALL-IN', cls: 'badge-allin' });
    // sittingOut ist technisch ebenfalls "folded" (siehe startHand() in
    // table.js), meint aber "hat keine Chips mehr und sitzt diese Hand aus"
    // – als FOLD angezeigt wäre das schlicht falsch.
    if (p.sittingOut) badges.push({ label: 'PLEITE', cls: 'badge-broke' });
    else if (p.folded) badges.push({ label: 'FOLD', cls: 'badge-fold' });
    if (p.disconnected) badges.push({ label: 'GETRENNT', cls: 'badge-disconnected' });

    const seat = document.createElement('div');
    seat.className =
      'seat' +
      (p.id === state.actingPlayerId ? ' acting' : '') +
      (p.folded ? ' folded' : '') +
      (p.disconnected ? ' disconnected' : '') +
      (p.id === mySocketId ? ' me' : '') +
      (winnerIds.has(p.id) ? ' winner' : '') +
      (team !== undefined ? ` team-${team}` : '');
    seat.style.left = `${left}%`;
    seat.style.top = `${top}%`;

    // "Denkt nach …"-Punkte statt (bzw. zusätzlich zum) pulsierenden Rahmen:
    // state.botIds listet jeden Bot-Sitzplatz dieses Raums (egal ob reiner
    // Übungsmodus oder ein mit Bots aufgefülltes Ranked/Casual-Match, siehe
    // broadcastRoomState() in server.js).
    const isThinkingBot = Array.isArray(state.botIds) && state.botIds.includes(p.id) && p.id === state.actingPlayerId;
    const thinkingHtml = isThinkingBot
      ? '<div class="thinking-dots"><span></span><span></span><span></span></div>'
      : '';

    // Verdeckte Mini-Karten: nur für Gegner, die noch im Spiel sind und
    // deren Hole Cards für mich nicht sichtbar sind (p.holeCards === null –
    // bei mir selbst bzw. im 2v2-Casual-Teammitglied stehen die echten,
    // großen Karten schon weiter unten, daher hier keine Dopplung). Zeigt
    // rein optisch "diese Spieler halten noch Karten", ohne irgendetwas
    // über deren Inhalt zu verraten.
    const showHiddenCards = state.phase !== 'waiting' && !p.folded && p.holeCards === null;
    const dealClass = animateDeal ? ' deal-in' : '';
    // Wie am echten Tisch: erst geht eine Karte reihum an jeden Spieler,
    // dann die zweite Runde (siehe Table.startHand() in table.js) – daher
    // die zweite Mini-Karte um n Sitzplätze verzögert statt gleichzeitig
    // mit der ersten.
    const delay1 = animateDeal ? `style="animation-delay:${i * 0.06}s"` : '';
    const delay2 = animateDeal ? `style="animation-delay:${(n + i) * 0.06}s"` : '';
    // Spionage (siehe _applySpy() in table.js): p.spiedCard ist gesetzt,
    // wenn ich diesen Gegner in dieser Hand spioniert habe – zeigt eine der
    // beiden Mini-Karten aufgedeckt statt verdeckt, nur in meiner eigenen
    // Ansicht (andere Spieler sehen weiterhin zwei verdeckte Rückseiten).
    const spiedCardHtml = p.spiedCard
      ? cardOuterHtml(p.spiedCard, ` mini-card-spied${dealClass}`)
      : `<span class="mini-card-back${dealClass}" ${delay1}></span>`;
    const hiddenCardsHtml = showHiddenCards
      ? `<div class="seat-cards">
          ${spiedCardHtml}
          <span class="mini-card-back${dealClass}" ${delay2}></span>
        </div>`
      : '';

    // Aufgedeckte Mini-Karten bei echtem Showdown: getPublicState() in
    // table.js schickt dafür die Hole Cards aller nicht gefoldeten Gegner
    // mit (statt null), damit sichtbar wird, gegen welche Hand man
    // gewonnen/verloren hat – wie am echten Tisch. Bei mir selbst nicht
    // nötig, die großen Karten stehen schon in #my-cards.
    const revealFlipClass = justRevealed ? ' reveal-flip' : '';
    const revealedCardsHtml =
      state.phase === 'showdown' && p.id !== mySocketId && p.holeCards
        ? `<div class="seat-cards">${p.holeCards.map((c) => cardOuterHtml(c, revealFlipClass)).join('')}</div>`
        : '';

    const initial = (p.name[0] || '?').toUpperCase();
    seat.innerHTML = `
      <div class="seat-pod">
        <div class="seat-avatar" style="background:${avatarColorFor(p.name)}">${escapeHtml(initial)}</div>
        <div class="seat-text">
          <span class="seat-name">${escapeHtml(p.name)}</span>
          <span class="seat-chips">${p.chips} Chips</span>
        </div>
      </div>
      ${hiddenCardsHtml}
      ${revealedCardsHtml}
      ${thinkingHtml}
      <div class="seat-bet">${p.bet > 0 ? `<span class="chip-icon"></span>Einsatz: ${p.bet}` : ''}</div>
      <div class="seat-badges">${badges.map((b) => `<span class="badge ${b.cls}">${b.label}</span>`).join('')}</div>
    `;
    container.appendChild(seat);
  });

  updateDealerButton(state);
}

// Aktualisiert den gleitenden Dealer-Button (siehe #dealer-button in
// index.html): ein einziges persistentes Element, das per CSS-transition
// sichtbar zum neuen Dealer-Sitzplatz hinübergleitet, statt bei jedem
// Rundenwechsel als neues Badge hart zu erscheinen.
function updateDealerButton(state) {
  const btn = document.getElementById('dealer-button');
  const pos = state.dealerPlayerId ? seatPositionForPlayer(state, state.dealerPlayerId) : null;
  if (!pos) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.style.left = `${pos.left}%`;
  btn.style.top = `${pos.top}%`;
}

// --- Effekt-Ebene: Aktions-Sprechblasen, Chip-Flug, Fold-Wegschieben -------
// Eigenständige DOM-Elemente in #fx-layer statt in #players-list, damit sie
// ein Neu-Rendern des Tisches überleben (renderSeats() leert #players-list
// bei jedem State-Update, siehe dort) und ihre eigene, kurze Animation zu
// Ende spielen können, bevor sie sich selbst wieder entfernen.

const POT_POSITION = { left: 50, top: 26 }; // deckt sich mit .pot-display (top: 26%)

function spawnChipFly(fromPos, toPos) {
  playChipFlySound();
  const layer = document.getElementById('fx-layer');
  const chip = document.createElement('div');
  chip.className = 'chip-fly';
  chip.style.left = `${fromPos.left}%`;
  chip.style.top = `${fromPos.top}%`;
  layer.appendChild(chip);
  // Doppeltes rAF: erzwingt, dass die Startposition erst gemalt wird, bevor
  // die Zielwerte gesetzt werden – sonst überspringt der Browser die
  // CSS-transition und der Chip "springt" direkt ans Ziel statt zu fliegen.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      chip.style.left = `${toPos.left}%`;
      chip.style.top = `${toPos.top}%`;
      chip.style.opacity = '0.2';
    });
  });
  setTimeout(() => chip.remove(), 650);
}

function showActionBubble(pos, text) {
  const layer = document.getElementById('fx-layer');
  const bubble = document.createElement('div');
  bubble.className = 'action-bubble';
  bubble.style.left = `${pos.left}%`;
  bubble.style.top = `${pos.top}%`;
  bubble.textContent = text;
  layer.appendChild(bubble);
  setTimeout(() => bubble.remove(), 1500);
}

function spawnFoldCards(pos) {
  const layer = document.getElementById('fx-layer');
  [0, 1].forEach((i) => {
    const card = document.createElement('div');
    card.className = 'fold-fx-card';
    card.style.left = `${pos.left}%`;
    card.style.top = `${pos.top}%`;
    card.style.animationDelay = `${i * 0.05}s`;
    layer.appendChild(card);
    setTimeout(() => card.remove(), 700);
  });
}

// Vergleicht den neuen state mit dem vorherigen Snapshot (prev) und löst
// passende Effekte aus: Aktions-Sprechblase + Chip-Flug bei Bet/Call/Raise,
// Sprechblase bei Check, Sprechblase + Wegschieb-Effekt bei Fold. Nur
// innerhalb derselben Straße relevant (state.phase === prev.phase) – bei
// einem Straßenwechsel (Flop/Turn/River) setzt der Server alle Einsätze
// zurück, das wäre sonst fälschlich als "alle haben gleichzeitig gecheckt"
// zu lesen.
function detectAndShowActionFx(state, prev) {
  if (!prev || state.phase !== prev.phase) return;

  state.players.forEach((p) => {
    const before = prev.players.find((pp) => pp.id === p.id);
    if (!before) return;
    const pos = seatPositionForPlayer(state, p.id);
    if (!pos) return;

    if (p.folded && !before.folded) {
      showActionBubble(pos, 'Fold');
      spawnFoldCards(pos);
      playFoldSound();
      return;
    }
    if (p.bet > before.bet) {
      const isAllIn = p.chips === 0;
      if (prev.currentBet === 0) {
        showActionBubble(pos, `Bet ${p.bet}`);
      } else if (p.bet > prev.currentBet) {
        showActionBubble(pos, `Raise ${p.bet}`);
      } else {
        showActionBubble(pos, 'Call');
      }
      spawnChipFly(pos, POT_POSITION);
      if (isAllIn) {
        playAllInSound();
      } else if (p.bet > prev.currentBet) {
        playBetSound(p.bet - before.bet, before.chips + before.bet);
      } else {
        playCallSound();
      }
      return;
    }
    if (!p.folded && !before.folded && p.bet === before.bet && prev.actingPlayerId === p.id && state.actingPlayerId !== p.id) {
      showActionBubble(pos, 'Check');
      playCheckSound();
    }
  });
}

// Chips fliegen sichtbar vom Pot zu jedem Gewinner zurück, sobald ein
// Showdown/Fold-Sieg gerade eben aufgelöst wurde (siehe Aufrufstelle in
// render() – nur wenn lastHandResult neu hinzugekommen ist, nicht bei
// jedem weiteren Rendern, solange der Gewinn-Banner noch angezeigt wird).
function spawnPotPayout(state) {
  state.lastHandResult.pots.forEach((pot) => {
    pot.winners.forEach((w) => {
      const pos = seatPositionForPlayer(state, w.id);
      if (pos) spawnChipFly(POT_POSITION, pos);
    });
  });
}

// Lässt die Pot-Anzeige sanft zum neuen Wert hochzählen (bzw. wieder auf 0
// zurückfallen, wenn ein gewonnener Pot ausgezahlt wurde), statt den Text
// bei jedem State-Update abrupt zu ersetzen.
let displayedPot = 0;
let potAnimationFrame = null;
function animatePotTo(target) {
  const potLabel = document.getElementById('pot-label');
  if (target === displayedPot) {
    potLabel.textContent = `Pot: ${displayedPot}`;
    return;
  }
  // Kurzer Glow-Puls um den Betrag herum, sobald sich der Pot tatsächlich
  // ändert – Klasse neu setzen (mit erzwungenem Reflow dazwischen), damit
  // die Animation bei schnell aufeinanderfolgenden Änderungen jedes Mal von
  // vorn beginnt statt nur einmal zu spielen.
  potLabel.classList.remove('pot-pulse');
  void potLabel.offsetWidth;
  potLabel.classList.add('pot-pulse');
  cancelAnimationFrame(potAnimationFrame);
  const start = displayedPot;
  const startTime = performance.now();
  const duration = 260;
  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    displayedPot = Math.round(start + (target - start) * eased);
    potLabel.textContent = `Pot: ${displayedPot}`;
    if (t < 1) potAnimationFrame = requestAnimationFrame(step);
  }
  potAnimationFrame = requestAnimationFrame(step);
}

// --- Tisch-Chat ------------------------------------------------------------
// Der Verlauf lebt nur im Server-Arbeitsspeicher (siehe chatHistory dort)
// und wird nach dem Beitritt einmalig nachgeladen. Bei geschlossener
// Schublade zählt ein Punkt am Chat-Knopf ungelesene Nachrichten.
const chatDrawer = document.getElementById('chat-drawer');
const chatMessagesEl = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatUnreadEl = document.getElementById('chat-unread');
let unreadChatCount = 0;

function renderChatUnread() {
  chatUnreadEl.hidden = unreadChatCount === 0;
  chatUnreadEl.textContent = unreadChatCount > 9 ? '9+' : String(unreadChatCount);
}

function appendChatMessage({ name, text, at }) {
  const row = document.createElement('div');
  row.className = 'chat-message' + (name === myName ? ' chat-message-own' : '');
  const time = new Date(at || Date.now()).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  row.innerHTML = `<span class="chat-message-meta">${escapeHtml(name)} · ${time}</span><span class="chat-message-text">${escapeHtml(text)}</span>`;
  chatMessagesEl.appendChild(row);
  // Immer ans Ende scrollen: Die neueste Nachricht ist die relevante.
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function openChat() {
  // Nicht-modal: Der Tisch bleibt daneben bedienbar, deshalb keine
  // Fokusfalle – Escape und Fokus-Rückgabe gelten trotzdem.
  dialogOeffnen(chatDrawer, closeChat, { modal: false });
  unreadChatCount = 0;
  renderChatUnread();
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  chatInput.focus();
}

function closeChat() {
  chatDrawer.hidden = true;
  dialogGeschlossen(chatDrawer);
}

document.getElementById('chat-toggle-btn').addEventListener('click', () => {
  playUiClickSound();
  if (chatDrawer.hidden) openChat();
  else closeChat();
});
document.getElementById('chat-close-btn').addEventListener('click', closeChat);
document.getElementById('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  chatInput.value = '';
});

socket.on('chat-history', (messages) => {
  chatMessagesEl.innerHTML = '';
  (messages || []).forEach(appendChatMessage);
});

socket.on('chat-message', (message) => {
  appendChatMessage(message);
  if (chatDrawer.hidden && message.name !== myName) {
    unreadChatCount += 1;
    renderChatUnread();
  }
});

// --- Poker-Hilfe -----------------------------------------------------------
const helpOverlay = document.getElementById('help-overlay');
function closeHelpOverlay() {
  helpOverlay.hidden = true;
  dialogGeschlossen(helpOverlay);
}
document.getElementById('help-btn').addEventListener('click', () => {
  playUiClickSound();
  dialogOeffnen(helpOverlay, closeHelpOverlay);
});
document.getElementById('help-close-btn').addEventListener('click', closeHelpOverlay);

// --- Zug-Countdown ---------------------------------------------------------
// Der Server erzwingt nach TURN_TIMEOUT_MS automatisch Check bzw. Fold
// (siehe ensureTurnTimer() dort) und schickt den Ablaufzeitpunkt als
// state.actingDeadline mit. Hier läuft nur die Anzeige dazu – eigener
// Sekundentakt statt Neurendern des ganzen Tisches, damit der Countdown
// auch zwischen zwei State-Updates weiterläuft.
let actingDeadline = null;
let turnTimerInterval = null;

function renderTurnTimer() {
  if (!actingDeadline) {
    turnTimerEl.hidden = true;
    return;
  }
  const secondsLeft = Math.max(0, Math.ceil((actingDeadline - Date.now()) / 1000));
  turnTimerEl.hidden = false;
  turnTimerEl.textContent = `⏱ ${secondsLeft}s`;
  turnTimerEl.classList.toggle('turn-timer-urgent', secondsLeft <= 10);
}

function updateTurnTimer(deadline) {
  actingDeadline = deadline || null;
  renderTurnTimer();
  clearInterval(turnTimerInterval);
  if (actingDeadline) turnTimerInterval = setInterval(renderTurnTimer, 1000);
}

function burstConfetti() {
  playWinSound();
  hapticMedium();
  const container = document.getElementById('confetti-container');
  for (let i = 0; i < 70; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    piece.style.animationDuration = `${2 + Math.random() * 1.6}s`;
    piece.style.animationDelay = `${Math.random() * 0.5}s`;
    piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    container.appendChild(piece);
    setTimeout(() => piece.remove(), 4200);
  }
}

function render(state) {
  document.getElementById('phase-label').textContent = PHASE_LABELS[state.phase] || state.phase;
  updateTurnTimer(state.actingDeadline);
  animatePotTo(state.pot);
  document.getElementById('current-bet-label').textContent =
    state.currentBet > 0 ? `Aktueller Einsatz: ${state.currentBet}` : '';

  // Vor dem eigentlichen Rendern: Aktions-Sprechblasen/Chip-Flug/Fold-Effekt
  // anhand des Unterschieds zum vorherigen State auslösen (siehe
  // detectAndShowActionFx – vergleicht gegen prevState, das erst ganz am
  // Ende dieser Funktion überschrieben wird).
  detectAndShowActionFx(state, prevState);
  // Ein Showdown/Fold-Sieg ist gerade eben aufgelöst worden (lastHandResult
  // war vorher noch nicht gesetzt) -> Pot fliegt zu den Gewinnern zurück.
  const justResolved = state.lastHandResult && (!prevState || !prevState.lastHandResult);
  if (justResolved) spawnPotPayout(state);

  const isNewHand = state.phase === 'preflop' && lastPhase !== 'preflop';
  if (isNewHand) communityDealtCount = 0;

  renderCommunityCards(state.communityCards, communityDealtCount);
  communityDealtCount = state.communityCards.length;

  const winnerIds = new Set(
    state.lastHandResult ? state.lastHandResult.pots.flatMap((pot) => pot.winners.map((w) => w.id)) : []
  );
  renderSeats(state, winnerIds, isNewHand, justResolved);

  const me = state.players.find((p) => p.id === mySocketId);
  renderMyCards((me && me.holeCards) || [], isNewHand);
  // Zwischen zwei Händen (waiting/showdown) lassen sich Fähigkeiten ohnehin
  // nicht einsetzen – useAbility() im Server lehnt das ab. Sie dann
  // auszublenden, ist nicht nur ehrlicher, sondern schafft auf kleinen
  // Bildschirmen genau den Platz, den der Showdown-Bereich mit den
  // aufgedeckten Gegnerkarten braucht.
  const handLaeuft = state.phase !== 'waiting' && state.phase !== 'showdown';
  renderAbilities(handLaeuft ? me && me.abilities : null);

  // Im 2v2-Casual-Modus schickt der Server zusätzlich die Hole Cards des
  // Teammitglieds mit (siehe extraVisibleIds in server.js). Team-bewusst
  // geprüft (state.teams), damit ein bei einem echten Showdown aufgedeckter
  // GEGNER (siehe showdownOpponents unten) hier nicht fälschlich als
  // "Teammitglied" auftaucht – beide haben holeCards != null, aber nur der
  // eine ist wirklich im selben Team.
  const teammate = state.players.find(
    (p) => p.id !== mySocketId && p.holeCards && state.teams && state.teams[p.id] === state.teams[mySocketId]
  );
  if (teammate) {
    document.getElementById('teammate-name').textContent = teammate.name;
    renderMyCards(teammate.holeCards, isNewHand, 'teammate-cards', false);
    teammateHandEl.hidden = false;
  } else {
    teammateHandEl.hidden = true;
  }

  // Bei einem echten Showdown schickt der Server (getPublicState() in
  // table.js) zusätzlich die Hole Cards aller nicht gefoldeten GEGNER mit
  // (nicht das Teammitglied, das schon oben behandelt wird), damit sichtbar
  // wird, gegen welche Hand man gewonnen/verloren hat – wie am echten Tisch.
  const showdownOpponents = state.players.filter(
    (p) => p.id !== mySocketId && p.holeCards && !(state.teams && state.teams[p.id] === state.teams[mySocketId])
  );
  if (state.phase === 'showdown' && showdownOpponents.length > 0) {
    showdownRevealListEl.innerHTML = '';
    showdownOpponents.forEach((p) => {
      const entry = document.createElement('div');
      entry.className = 'showdown-reveal-entry';
      const nameEl = document.createElement('span');
      nameEl.className = 'showdown-reveal-name';
      nameEl.textContent = p.name;
      const cardRow = document.createElement('div');
      cardRow.className = 'card-row showdown-reveal-cards';
      p.holeCards.forEach((c) => cardRow.appendChild(renderCard(c, justResolved ? ' reveal-flip' : '')));
      entry.appendChild(nameEl);
      entry.appendChild(cardRow);
      showdownRevealListEl.appendChild(entry);
    });
    showdownRevealEl.hidden = false;
  } else {
    showdownRevealEl.hidden = true;
  }

  // Kurzes Aufleuchten der Community Cards nach einem echten Showdown
  // (nicht bei einem reinen Fold-Sieg, da dort keine Hände verglichen
  // wurden) – zusätzlich die eigenen Karten, falls ich selbst gewonnen
  // habe. Nutzt dieselbe Glow-Animation wie der Gewinner-Sitzplatz.
  if (justResolved && state.lastHandResult.reason === 'showdown') {
    document.querySelectorAll('#community-cards .card').forEach((el) => el.classList.add('glow'));
    if (winnerIds.has(mySocketId)) {
      document.querySelectorAll('#my-cards .card').forEach((el) => el.classList.add('glow'));
    }
    playFlipSound();
  }

  lastPhase = state.phase;

  const isMyTurn = state.actingPlayerId === mySocketId;
  const canAct = isMyTurn && me && !me.folded;
  // ">=" statt "===": Postet ein kurzgestapelter Big Blind weniger als den
  // vollen Big Blind (All-in-Blind), kann currentBet unter dem eigenen
  // Einsatz liegen (siehe table.js check()) – dann ist Check weiterhin die
  // richtige Aktion, nicht Call.
  const betsMatch = me ? me.bet >= state.currentBet : false;

  foldBtn.disabled = !canAct;
  checkBtn.disabled = !canAct || !betsMatch;
  callBtn.disabled = !canAct || betsMatch;
  // Ein Raise ist nur möglich, wenn der eigene Gesamteinsatz den aktuellen
  // überhaupt überbieten KANN (siehe raise() in table.js: raiseSize > 0).
  // Gegen ein All-In, das den eigenen Stack exakt deckt, gibt es keinen
  // legalen Raise-Betrag mehr – vorher blieb der Knopf trotzdem aktiv und
  // quittierte jeden Klick mit einer Fehlermeldung, statt Call/Fold als
  // die tatsächlich verbleibenden Optionen erkennbar zu machen.
  const myMaxTotalBet = me ? me.bet + me.chips : 0;
  betBtn.disabled = !canAct || state.currentBet !== 0 || !me || me.chips <= 0;
  raiseBtn.disabled = !canAct || state.currentBet === 0 || myMaxTotalBet <= state.currentBet;
  // Ein gemeinsames Betragsfeld für beide Aktionen: bedienbar, sobald eine
  // von beiden möglich ist.
  betAmountInput.disabled = betBtn.disabled && raiseBtn.disabled;
  renderBetSizer(state, me, !betBtn.disabled, !raiseBtn.disabled);
  wasMyTurn = isMyTurn;

  startHandBtn.hidden = handLaeuft;
  // Zwischen zwei Händen sind Regler und Wett-Knöpfe ausnahmslos
  // deaktiviert – sie dann ganz auszublenden macht sichtbar, dass jetzt nur
  // "Hand starten" zählt, und gibt auf kleinen Bildschirmen über 100px für
  // den Showdown-Bereich frei, statt eine Reihe toter Knöpfe zu zeigen.
  betSizerEl.hidden = !handLaeuft;
  [foldBtn, checkBtn, callBtn, betBtn, raiseBtn].forEach((btn) => {
    btn.hidden = !handLaeuft;
  });

  // Nachkaufen nur im eigenen Tisch anbieten: In den Matchmaking-Modi ist
  // das Ausscheiden Teil der Wertung (siehe socket.on('rebuy') im Server).
  const inMatchMode = isRanked || isCasual4 || isRankedTeam || isCasualTeam || isVsBots;
  rebuyBanner.hidden = !(me && me.chips === 0 && !inMatchMode);

  if (state.lastHandResult) {
    if (handResultEl.hidden) {
      const iWon = state.lastHandResult.pots.some((pot) => pot.winners.some((w) => w.id === mySocketId));
      if (iWon) burstConfetti();
    }
    const reason = state.lastHandResult.reason === 'fold' ? 'durch Fold der Gegner' : 'im Showdown';
    const multiplePots = state.lastHandResult.pots.length > 1;
    const potLines = state.lastHandResult.pots.map((pot, i) => {
      const label = multiplePots ? `${i === 0 ? 'Hauptpot' : `Neben-Pot ${i}`}: ` : '';
      const names = pot.winners.map((w) => w.name).join(', ');
      return `${label}${names} gewinnt ${pot.potShare} Chips`;
    });
    handResultEl.textContent = `${potLines.join(' · ')} ${reason}.`;
    handResultEl.hidden = false;
  } else {
    handResultEl.hidden = true;
  }

  prevState = state;
}

// --- PWA-Installation ------------------------------------------------------
// Registriert den Service Worker (siehe sw.js), damit sich die App auf dem
// Handy zum Startbildschirm hinzufügen lässt und die Oberfläche auch ohne
// Netz erscheint. Bewusst abgesichert: In der gebündelten nativen App
// (Capacitor, eigenes Schema statt http/https) gibt es keinen Service
// Worker – ein Fehlschlag darf das Spiel dort nicht beeinträchtigen.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Nicht verfügbar (privater Modus, blockiert, native App) – die App
      // funktioniert auch ohne, nur eben ohne Installations-Angebot.
    });
  });
}
