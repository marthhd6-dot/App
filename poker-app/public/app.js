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

const joinScreen = document.getElementById('join-screen');
const tableScreen = document.getElementById('table-screen');
const nameInput = document.getElementById('name-input');
const roomCodeInput = document.getElementById('room-code-input');
const joinErrorEl = document.getElementById('join-error');
const errorBanner = document.getElementById('error-banner');
const reconnectBanner = document.getElementById('reconnect-banner');
const handResultEl = document.getElementById('hand-result');

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

socket.on('room-joined', ({ code }) => {
  joinedRoomCode = code;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, name: myName }));
  reconnectBanner.hidden = true;
  document.getElementById('room-code-label').textContent = `Raum: ${code}`;
  joinScreen.hidden = true;
  tableScreen.hidden = false;
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
    const names = state.lastHandResult.winners.map((w) => w.name).join(', ');
    const reason = state.lastHandResult.reason === 'fold' ? 'durch Fold der Gegner' : 'im Showdown';
    handResultEl.textContent = `${names} gewinnt ${state.lastHandResult.potShare} Chips ${reason}.`;
    handResultEl.hidden = false;
  } else {
    handResultEl.hidden = true;
  }
}
