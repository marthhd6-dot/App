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

const socket = io();
let mySocketId = null;

const joinScreen = document.getElementById('join-screen');
const tableScreen = document.getElementById('table-screen');
const nameInput = document.getElementById('name-input');
const errorBanner = document.getElementById('error-banner');
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
});

socket.on('state', render);

let errorTimer = null;
socket.on('error-message', (message) => {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    errorBanner.hidden = true;
  }, 4000);
});

document.getElementById('join-btn').addEventListener('click', join);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
});

function join() {
  const name = nameInput.value.trim();
  socket.emit('join', { name });
  joinScreen.hidden = true;
  tableScreen.hidden = false;
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

    const row = document.createElement('div');
    row.className =
      'player-row' +
      (p.id === state.actingPlayerId ? ' acting' : '') +
      (p.folded ? ' folded' : '') +
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
