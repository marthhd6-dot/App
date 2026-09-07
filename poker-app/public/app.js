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

const SESSION_KEY = 'pokerSession'; // { code, name } des zuletzt beigetretenen Raums

const socket = io();
let mySocketId = null;
let myName = '';
let joinedRoomCode = null;
let isRanked = false;

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

const joinScreen = document.getElementById('join-screen');
const tableScreen = document.getElementById('table-screen');
const nameInput = document.getElementById('name-input');
const roomCodeInput = document.getElementById('room-code-input');
const joinErrorEl = document.getElementById('join-error');
const errorBanner = document.getElementById('error-banner');
const reconnectBanner = document.getElementById('reconnect-banner');
const handResultEl = document.getElementById('hand-result');
const rankedBadge = document.getElementById('ranked-badge');
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

socket.on('room-joined', ({ code, ranked }) => {
  joinedRoomCode = code;
  isRanked = Boolean(ranked);
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, name: myName }));
  reconnectBanner.hidden = true;
  rankedMatchOverBanner.hidden = true;
  rankedBadge.hidden = !isRanked;
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
  const queueRankLabel = document.getElementById('queue-rank-label');
  queueRankLabel.textContent = text;
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

socket.on('ranked-match-over', ({ result, opponentName, newRating, newTier, ratingChange }) => {
  const outcome = result === 'win' ? 'Sieg' : 'Niederlage';
  const sign = ratingChange >= 0 ? '+' : '';
  document.getElementById('ranked-match-over-text').textContent =
    `${outcome} gegen ${opponentName}! Neuer Rang: ${newTier} (${newRating}, ${sign}${ratingChange})`;
  rankedMatchOverBanner.hidden = false;
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
  socket.emit('get-rank', { name: myName });
  socket.emit('join-ranked-queue', { name: myName });
});

document.getElementById('cancel-queue-btn').addEventListener('click', () => {
  socket.emit('leave-ranked-queue');
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

function cardLabel(card) {
  return `${RANK_LABELS[card.rank] || card.rank}${SUIT_SYMBOLS[card.suit]}`;
}

function isRedSuit(suit) {
  return suit === 'H' || suit === 'D';
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card' + (isRedSuit(card.suit) ? ' red' : '');
  el.textContent = cardLabel(card);
  return el;
}

function renderCardRow(container, cards) {
  container.innerHTML = '';
  cards.forEach((card) => container.appendChild(renderCard(card)));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function render(state) {
  document.getElementById('phase-label').textContent = PHASE_LABELS[state.phase] || state.phase;
  document.getElementById('pot-label').textContent = `Pot: ${state.pot}`;
  document.getElementById('current-bet-label').textContent =
    state.currentBet > 0 ? `Aktueller Einsatz: ${state.currentBet}` : '';

  renderCardRow(document.getElementById('community-cards'), state.communityCards);

  const playersList = document.getElementById('players-list');
  playersList.innerHTML = '';
  state.players.forEach((p) => {
    const badges = [];
    if (p.id === state.dealerPlayerId) badges.push('D');
    if (p.isAllIn) badges.push('ALL-IN');
    if (p.folded) badges.push('FOLD');
    if (p.disconnected) badges.push('GETRENNT');

    const row = document.createElement('div');
    row.className =
      'player-row' +
      (p.id === state.actingPlayerId ? ' acting' : '') +
      (p.folded ? ' folded' : '') +
      (p.disconnected ? ' disconnected' : '') +
      (p.id === mySocketId ? ' me' : '');
    row.innerHTML = `
      <span class="player-name">${escapeHtml(p.name)}${badges
        .map((b) => `<span class="badge">${b}</span>`)
        .join('')}</span>
      <span class="player-chips">${p.chips} Chips</span>
      <span class="player-bet">${p.bet > 0 ? `Einsatz: ${p.bet}` : ''}</span>
    `;
    playersList.appendChild(row);
  });

  const me = state.players.find((p) => p.id === mySocketId);
  renderCardRow(document.getElementById('my-cards'), (me && me.holeCards) || []);

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
