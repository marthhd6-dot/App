// tests/bots.test.js
// Ausführen mit: npm test  (nutzt nur Node's eingebautes assert, kein Framework nötig)

const assert = require('assert');
const { Table } = require('../src/game/table');
const {
  BOT_TIER_NAMES,
  preflopStrength,
  handStrength,
  requiredCallStrength,
  decideBotAction,
} = require('../src/bots');

function run(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.message);
    process.exitCode = 1;
  }
}

// Kleiner deterministischer Pseudo-Zufallsgenerator (mulberry32), damit
// Tests reproduzierbar bleiben, aber trotzdem eine Streuung an Werten
// durchspielen statt immer denselben rng-Wert.
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function applyAction(table, id, action) {
  if (action.type === 'fold') return table.fold(id);
  if (action.type === 'check') return table.check(id);
  if (action.type === 'call') return table.call(id);
  if (action.type === 'bet') return table.placeBet(id, action.amount);
  if (action.type === 'raise') return table.raise(id, action.amount);
  throw new Error(`Unbekannter Aktionstyp: ${action.type}`);
}

// Spiegelt advancePhaseIfRoundComplete() aus server.js: teilt automatisch
// die nächste Straße aus, solange die aktuelle Wettrunde abgeschlossen ist.
function advancePhase(table) {
  while (table.phase !== 'showdown' && table.actingIndex === -1) {
    if (table.phase === 'preflop') table.dealFlop();
    else if (table.phase === 'flop') table.dealTurn();
    else if (table.phase === 'turn') table.dealRiver();
    else if (table.phase === 'river') table.showdown();
    else break;
  }
}

// Spielt eine komplette Hand, bei der jede Aktion von decideBotAction()
// kommt – wirft, falls eine Aktion vom Table als illegal abgelehnt wird
// (applyAction() reicht den Fehler durch) oder falls die Hand nach
// "guard" Aktionen immer noch nicht am Showdown ist (Indiz für eine
// Endlosschleife in der Entscheidungslogik).
function playFullHandWithBots(table, tierNames, rng) {
  table.startHand();
  advancePhase(table);
  let guard = 0;
  while (table.phase !== 'showdown') {
    if (++guard > 200) throw new Error('Hand kam nicht zum Showdown (Endlosschleife?)');
    const current = table.getCurrentPlayer();
    if (!current) {
      advancePhase(table);
      continue;
    }
    const action = decideBotAction(table, current.id, tierNames[current.id], rng);
    applyAction(table, current.id, action);
    advancePhase(table);
  }
}

run('preflopStrength: Pocket Aces stärker als 7-2 offsuit', () => {
  const aces = preflopStrength([
    { rank: 14, suit: 'S' },
    { rank: 14, suit: 'H' },
  ]);
  const seven2 = preflopStrength([
    { rank: 7, suit: 'S' },
    { rank: 2, suit: 'H' },
  ]);
  assert.ok(aces > seven2, `Pocket Aces (${aces}) sollte stärker sein als 7-2 offsuit (${seven2})`);
  assert.ok(aces > 0.9);
  assert.ok(seven2 < 0.3);
});

run('preflopStrength: suited gibt einen kleinen Bonus gegenüber offsuit', () => {
  const suited = preflopStrength([
    { rank: 10, suit: 'S' },
    { rank: 8, suit: 'S' },
  ]);
  const offsuit = preflopStrength([
    { rank: 10, suit: 'S' },
    { rank: 8, suit: 'H' },
  ]);
  assert.ok(suited > offsuit);
});

run('handStrength: Two Pair stärker als High Card, Vierling stärker als Two Pair', () => {
  const hole = [
    { rank: 4, suit: 'H' },
    { rank: 3, suit: 'C' },
  ];
  const boardHighCard = [
    { rank: 9, suit: 'S' },
    { rank: 12, suit: 'D' },
    { rank: 6, suit: 'C' },
  ];
  const boardTwoPair = [
    { rank: 9, suit: 'S' },
    { rank: 9, suit: 'H' },
    { rank: 4, suit: 'D' },
  ];
  const boardQuads = [
    { rank: 4, suit: 'S' },
    { rank: 4, suit: 'D' },
    { rank: 6, suit: 'C' },
  ];

  const highCardStrength = handStrength(hole, boardHighCard);
  const twoPairStrength = handStrength(hole, boardTwoPair);
  const quadsStrength = handStrength(hole, boardQuads);

  assert.ok(twoPairStrength > highCardStrength);
  assert.ok(quadsStrength > twoPairStrength);
});

run('requiredCallStrength: Champion verlangt mehr Sicherheitsabstand als Bronze bei gleichen Pot-Odds', () => {
  const potOdds = 0.25;
  const bronze = requiredCallStrength(potOdds, 'Bronze');
  const champion = requiredCallStrength(potOdds, 'Champion');
  assert.ok(champion > bronze, `Champion (${champion}) sollte strenger sein als Bronze (${bronze})`);
  assert.ok(bronze >= potOdds); // nie unter dem mathematischen Break-even
});

run('requiredCallStrength: wächst monoton mit den Pot-Odds', () => {
  const low = requiredCallStrength(0.1, 'Gold');
  const high = requiredCallStrength(0.6, 'Gold');
  assert.ok(high > low);
});

run('decideBotAction: bei mittlerer Handstärke und guten Pot-Odds callt Bronze, wo Champion foldet', () => {
  const table = new Table({ smallBlind: 5, bigBlind: 10 });
  table.addPlayer('human', 'Mensch', 1000);
  table.addPlayer('bot', 'Bot', 1000);
  table.phase = 'flop';
  // Zwei Paar (9er und 4er) für den Bot -> handStrength = (2+0.5)/9 ≈ 0.278
  table.communityCards = [
    { rank: 9, suit: 'S' },
    { rank: 9, suit: 'H' },
    { rank: 4, suit: 'D' },
  ];
  table.players[1].holeCards = [
    { rank: 4, suit: 'H' },
    { rank: 3, suit: 'C' },
  ];
  table.players[0].bet = 10;
  table.players[1].bet = 0;
  table.currentBet = 10;
  table.pot = 100; // potOdds = 10 / (100 + 10) ≈ 0.091

  // rng liefert immer 0.99: nie ein "Fehler", nie ein Bluff, nie
  // zusätzliche Aggression – isoliert die reine Fold/Call-Entscheidung.
  const alwaysHigh = () => 0.99;

  const bronzeAction = decideBotAction(table, 'bot', 'Bronze', alwaysHigh);
  const championAction = decideBotAction(table, 'bot', 'Champion', alwaysHigh);

  assert.strictEqual(bronzeAction.type, 'call');
  assert.strictEqual(championAction.type, 'fold');
});

run('decideBotAction: check ist immer legal, wenn niemand gesetzt hat', () => {
  const table = new Table({ smallBlind: 5, bigBlind: 10 });
  table.addPlayer('human', 'Mensch', 1000);
  table.addPlayer('bot', 'Bot', 1000);
  table.phase = 'flop';
  table.communityCards = [
    { rank: 2, suit: 'S' },
    { rank: 5, suit: 'H' },
    { rank: 9, suit: 'D' },
  ];
  table.players[1].holeCards = [
    { rank: 3, suit: 'C' },
    { rank: 7, suit: 'D' },
  ];
  table.currentBet = 0;
  table.pot = 40;

  // rng 0 maximiert mistakeRate/bluffRate/aggression-Treffer, trotzdem darf
  // nur check oder ein legaler bet herauskommen.
  const action = decideBotAction(table, 'bot', 'Champion', () => 0);
  assert.ok(['check', 'bet'].includes(action.type));
  if (action.type === 'bet') {
    assert.ok(action.amount > 0 && action.amount <= table.players[1].chips);
  }
});

run('decideBotAction: wirft einen klaren Fehler, wenn die Bot-ID nicht am Tisch sitzt', () => {
  const table = new Table({ smallBlind: 5, bigBlind: 10 });
  table.addPlayer('human', 'Mensch', 1000);
  assert.throws(() => decideBotAction(table, 'unbekannt', 'Bronze'), /sitzt nicht an diesem Tisch/);
});

run('decideBotAction: komplette Hände mit ausschließlich Bots laufen ohne illegale Aktionen durch', () => {
  for (const tier of BOT_TIER_NAMES) {
    const table = new Table({ smallBlind: 5, bigBlind: 10 });
    table.addPlayer('bot1', 'Bot 1', 500);
    table.addPlayer('bot2', 'Bot 2', 500);
    table.addPlayer('bot3', 'Bot 3', 500);
    const tierNames = { bot1: tier, bot2: tier, bot3: tier };
    const rng = mulberry32(42 + tier.length);

    for (let hand = 0; hand < 15 && table.players.length >= 2; hand++) {
      playFullHandWithBots(table, tierNames, rng);
      // Nach der Hand ausgebustete Bots entfernen, wie server.js es via
      // trackEliminations() für echte Matches tut, damit die nächste Hand
      // wieder mit mindestens 2 Spielern startet.
      table.players = table.players.filter((p) => p.chips > 0);
    }
  }
});

run('decideBotAction: gemischte Rang-Stufen am selben Tisch laufen ebenfalls ohne illegale Aktionen durch', () => {
  const table = new Table({ smallBlind: 5, bigBlind: 10 });
  table.addPlayer('bronze', 'Bronze-Bot', 500);
  table.addPlayer('gold', 'Gold-Bot', 500);
  table.addPlayer('champion', 'Champion-Bot', 500);
  const tierNames = { bronze: 'Bronze', gold: 'Gold', champion: 'Champion' };
  const rng = mulberry32(7);

  for (let hand = 0; hand < 15 && table.players.length >= 2; hand++) {
    playFullHandWithBots(table, tierNames, rng);
    table.players = table.players.filter((p) => p.chips > 0);
  }
});

console.log('\nAlle Tests durchgelaufen.');
