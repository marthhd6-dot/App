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

const socket = io();
let mySocketId = null;
let myName = '';
let joinedRoomCode = null;
let isRanked = false;
let isCasual4 = false;
let queueType = null; // 'ranked' | 'casual' – bestimmt, welches leave-*-queue-Event der Abbrechen-Button feuert
let lastPhase = null; // für Deal-Animationen: erkennt den Beginn einer neuen Hand
let communityDealtCount = 0;

const screens = {
  join: document.getElementById('join-screen'),
  queue: document.getElementById('queue-screen'),
  leaderboard: document.getElementById('leaderboard-screen'),
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
const rankedMatchOverBanner = document.getElementById('ranked-match-over-banner');

const foldBtn = document.getElementById('fold-btn');
const checkBtn = document.getElementById('check-btn');
const callBtn = document.getElementById('call-btn');
const betBtn = document.getElementById('bet-btn');
const raiseBtn = document.getElementById('raise-btn');
const betInput = document.getElementById('bet-input');
const raiseInput = document.getElementById('raise-input');
const startHandBtn = document.getElementById('start-hand-btn');

socket.on('connect', () => {
  mySocketId = socket.id;
  attemptAutoRejoin();
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

socket.on('room-joined', ({ code, ranked, casual4 }) => {
  joinedRoomCode = code;
  isRanked = Boolean(ranked);
  isCasual4 = Boolean(casual4);
  lastPhase = null;
  communityDealtCount = 0;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, name: myName }));
  reconnectBanner.hidden = true;
  rankedMatchOverBanner.hidden = true;
  rankedBadge.hidden = !isRanked;
  casual4Badge.hidden = !isCasual4;
  document.getElementById('room-code-label').textContent = `Raum: ${code}`;
  showScreen('table');
});

socket.on('queue-status', ({ waiting }) => {
  showScreen(waiting ? 'queue' : 'join');
});

socket.on('rank-info', ({ name, rating, tier, wins, losses }) => {
  const text = `${name}: ${tier} (${rating}) · ${wins}S/${losses}N`;
  const myRankLabel = document.getElementById('my-rank-label');
  myRankLabel.textContent = text;
  myRankLabel.hidden = false;
  // Im Casual-Queue-Screen ist das Rating irrelevant (kein Rating-Bezug),
  // daher hier nicht anzeigen – auch nicht, wenn eine durchs blur-Event
  // ausgelöste get-rank-Antwort erst nach dem Wechsel in die Casual-Queue
  // eintrifft.
  if (queueType !== 'casual') {
    document.getElementById('queue-rank-label').textContent = text;
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
  if (trimmed) socket.emit('get-rank', { name: trimmed });
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

document.getElementById('cancel-queue-btn').addEventListener('click', () => {
  socket.emit(queueType === 'casual' ? 'leave-casual-queue' : 'leave-ranked-queue');
});

document.getElementById('leaderboard-btn').addEventListener('click', () => {
  socket.emit('get-leaderboard');
});

document.getElementById('leaderboard-close-btn').addEventListener('click', () => {
  showScreen('join');
});

document.getElementById('ranked-back-to-menu-btn').addEventListener('click', () => {
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
});

startHandBtn.addEventListener('click', () => socket.emit('start-hand'));
foldBtn.addEventListener('click', () => socket.emit('fold'));
checkBtn.addEventListener('click', () => socket.emit('check'));
callBtn.addEventListener('click', () => socket.emit('call'));
betBtn.addEventListener('click', () => {
  socket.emit('bet', { amount: Number(betInput.value) });
});
raiseBtn.addEventListener('click', () => {
  socket.emit('raise', { amount: Number(raiseInput.value) });
});

function isRedSuit(suit) {
  return suit === 'H' || suit === 'D';
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card' + (isRedSuit(card.suit) ? ' red' : '');
  const rank = RANK_LABELS[card.rank] || card.rank;
  const suit = SUIT_SYMBOLS[card.suit];
  el.innerHTML = `
    <span class="card-corner card-corner-top"><span>${rank}</span><span class="card-suit-mini">${suit}</span></span>
    <span class="card-suit-big">${suit}</span>
    <span class="card-corner card-corner-bottom"><span>${rank}</span><span class="card-suit-mini">${suit}</span></span>
  `;
  return el;
}

// Rendert die Community Cards und animiert nur die seit dem letzten Rendern
// neu hinzugekommenen (Flop/Turn/River), statt bei jedem State-Update alle
// Karten erneut einfliegen zu lassen.
function renderCommunityCards(cards, previouslyDealt) {
  const container = document.getElementById('community-cards');
  container.innerHTML = '';
  cards.forEach((card, i) => {
    const el = renderCard(card);
    if (i >= previouslyDealt) {
      el.classList.add('deal-in');
      el.style.animationDelay = `${(i - previouslyDealt) * 0.12}s`;
    }
    container.appendChild(el);
  });
}

function renderMyCards(cards, animate) {
  const container = document.getElementById('my-cards');
  container.innerHTML = '';
  cards.forEach((card, i) => {
    const el = renderCard(card);
    if (animate) {
      el.classList.add('deal-in');
      el.style.animationDelay = `${i * 0.12}s`;
    }
    container.appendChild(el);
  });
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

// Ordnet alle Spieler als "Sitzplätze" kreisförmig um den ovalen Tisch an –
// der eigene Platz liegt dabei immer unten in der Mitte. winnerIds enthält
// die Spieler, die die zuletzt gezeigte Hand gewonnen haben (leer, solange
// keine Hand beendet ist), damit ihr Sitzplatz golden hervorgehoben wird.
function renderSeats(state, winnerIds) {
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

  const rx = 44; // Radius in % der Tisch-Breite
  const ry = 40; // Radius in % der Tisch-Höhe

  ordered.forEach((p, i) => {
    const angleRad = ((90 + (360 / n) * i) * Math.PI) / 180; // Start unten in der Mitte
    const left = 50 + rx * Math.cos(angleRad);
    const top = 50 + ry * Math.sin(angleRad);

    const badges = [];
    if (p.id === state.dealerPlayerId) badges.push({ label: 'D', cls: 'badge-dealer' });
    if (p.isAllIn) badges.push({ label: 'ALL-IN', cls: 'badge-allin' });
    if (p.folded) badges.push({ label: 'FOLD', cls: 'badge-fold' });
    if (p.disconnected) badges.push({ label: 'GETRENNT', cls: 'badge-disconnected' });

    const seat = document.createElement('div');
    seat.className =
      'seat' +
      (p.id === state.actingPlayerId ? ' acting' : '') +
      (p.folded ? ' folded' : '') +
      (p.disconnected ? ' disconnected' : '') +
      (p.id === mySocketId ? ' me' : '') +
      (winnerIds.has(p.id) ? ' winner' : '');
    seat.style.left = `${left}%`;
    seat.style.top = `${top}%`;

    const initial = (p.name[0] || '?').toUpperCase();
    seat.innerHTML = `
      <div class="seat-pod">
        <div class="seat-avatar" style="background:${avatarColorFor(p.name)}">${escapeHtml(initial)}</div>
        <div class="seat-text">
          <span class="seat-name">${escapeHtml(p.name)}</span>
          <span class="seat-chips">${p.chips} Chips</span>
        </div>
      </div>
      <div class="seat-bet">${p.bet > 0 ? `<span class="chip-icon"></span>Einsatz: ${p.bet}` : ''}</div>
      <div class="seat-badges">${badges.map((b) => `<span class="badge ${b.cls}">${b.label}</span>`).join('')}</div>
    `;
    container.appendChild(seat);
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

function burstConfetti() {
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
  animatePotTo(state.pot);
  document.getElementById('current-bet-label').textContent =
    state.currentBet > 0 ? `Aktueller Einsatz: ${state.currentBet}` : '';

  const isNewHand = state.phase === 'preflop' && lastPhase !== 'preflop';
  if (isNewHand) communityDealtCount = 0;

  renderCommunityCards(state.communityCards, communityDealtCount);
  communityDealtCount = state.communityCards.length;

  const winnerIds = new Set(
    state.lastHandResult ? state.lastHandResult.pots.flatMap((pot) => pot.winners.map((w) => w.id)) : []
  );
  renderSeats(state, winnerIds);

  const me = state.players.find((p) => p.id === mySocketId);
  renderMyCards((me && me.holeCards) || [], isNewHand);

  lastPhase = state.phase;

  const isMyTurn = state.actingPlayerId === mySocketId;
  const canAct = isMyTurn && me && !me.folded;
  const betsMatch = me ? me.bet === state.currentBet : false;

  foldBtn.disabled = !canAct;
  checkBtn.disabled = !canAct || !betsMatch;
  callBtn.disabled = !canAct || betsMatch;
  betBtn.disabled = !canAct || state.currentBet !== 0;
  betInput.disabled = betBtn.disabled;
  raiseBtn.disabled = !canAct || state.currentBet === 0;
  raiseInput.disabled = raiseBtn.disabled;

  startHandBtn.hidden = state.phase !== 'waiting' && state.phase !== 'showdown';

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
}
