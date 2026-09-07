// tests/table.test.js
// Ausführen mit: npm test  (nutzt nur Node's eingebautes assert, kein Framework nötig)

const assert = require('assert');
const { Table } = require('../src/game/table');

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

function makeTable(playerIds, { smallBlind = 5, bigBlind = 10, chips = 1000 } = {}) {
  const table = new Table({ smallBlind, bigBlind });
  playerIds.forEach((id) => table.addPlayer(id, `Spieler-${id}`, chips));
  return table;
}

function totalChips(table) {
  return table.pot + table.players.reduce((sum, p) => sum + p.chips + p.bet, 0);
}

run('addPlayer verhindert Duplikate, removePlayer entfernt Spieler', () => {
  const table = makeTable(['a', 'b']);
  table.addPlayer('a', 'Nochmal Alice');
  assert.strictEqual(table.players.length, 2);
  table.removePlayer('a');
  assert.strictEqual(table.players.length, 1);
  assert.strictEqual(table.players[0].id, 'b');
});

run('startHand verteilt 2 Hole Cards und zieht Blinds bei 3 Spielern ein', () => {
  const table = makeTable(['a', 'b', 'c']);
  table.startHand();

  table.players.forEach((p) => assert.strictEqual(p.holeCards.length, 2));

  const [a, b, c] = table.players;
  assert.strictEqual(b.bet, 5); // Small Blind = Spieler nach dem Dealer
  assert.strictEqual(b.chips, 995);
  assert.strictEqual(c.bet, 10); // Big Blind
  assert.strictEqual(c.chips, 990);
  assert.strictEqual(table.pot, 15);
  assert.strictEqual(table.currentBet, 10);
  assert.strictEqual(table.getCurrentPlayer().id, a.id); // UTG ist als Erstes dran
});

run('Heads-up: Dealer ist Small Blind und als Erstes am Zug', () => {
  const table = makeTable(['a', 'b']);
  table.startHand();

  const [a, b] = table.players;
  assert.strictEqual(a.bet, 5);
  assert.strictEqual(b.bet, 10);
  assert.strictEqual(table.getCurrentPlayer().id, a.id);
});

run('Wettrunde ist erst abgeschlossen, wenn Big Blind sein Optionsrecht wahrgenommen hat', () => {
  const table = makeTable(['a', 'b', 'c']);
  table.startHand();

  table.call('a'); // UTG callt auf 10
  assert.strictEqual(table.isBettingRoundComplete(), false);

  table.call('b'); // SB callt auf 10
  assert.strictEqual(table.isBettingRoundComplete(), false); // BB hat noch nicht aktiv gehandelt

  table.check('c'); // BB-Option: check erlaubt, da bet === currentBet
  assert.strictEqual(table.isBettingRoundComplete(), true);
  assert.strictEqual(table.actingIndex, -1);
  assert.strictEqual(table.pot, 30);
});

run('Ein voller Raise zwingt bereits gehandelte Spieler erneut zum Handeln', () => {
  const table = makeTable(['a', 'b', 'c']);
  table.startHand();

  table.raise('a', 30); // UTG raist auf 30 (Raise-Größe 20 >= minRaise 10)
  assert.strictEqual(table.currentBet, 30);
  assert.strictEqual(table.minRaise, 20);
  assert.strictEqual(table.getCurrentPlayer().id, 'b');

  assert.throws(() => table.check('c'), /nicht am Zug/);

  table.call('b');
  assert.strictEqual(table.getCurrentPlayer().id, 'c');
  table.call('c');

  assert.strictEqual(table.isBettingRoundComplete(), true);
  assert.strictEqual(table.pot, 90); // 30 + 30 + 30
});

run('Fold bis auf einen Spieler beendet die Hand sofort und zahlt den Pot aus', () => {
  const table = makeTable(['a', 'b']);
  table.startHand();

  table.fold('a');

  const [a, b] = table.players;
  assert.strictEqual(table.phase, 'showdown');
  assert.strictEqual(table.pot, 0);
  assert.strictEqual(b.chips, 1005); // 990 + Pot von 15
  assert.strictEqual(table.lastHandResult.reason, 'fold');
  assert.strictEqual(table.lastHandResult.winners[0].id, b.id);
  assert.strictEqual(a.chips, 995); // hat nur den Small Blind verloren
});

run('Aktionen außerhalb der Reihe werfen einen Fehler', () => {
  const table = makeTable(['a', 'b', 'c']);
  table.startHand();

  assert.throws(() => table.check('b'), /nicht am Zug/);
  assert.throws(() => table.call('unknown-player'), /nicht am Zug/);
});

run('check() ist nicht erlaubt, solange ein Einsatz offen ist', () => {
  const table = makeTable(['a', 'b', 'c']);
  table.startHand();

  assert.throws(() => table.check('a'), /Check nicht möglich/);
});

run('call() ist nicht erlaubt, wenn nichts zu callen ist', () => {
  const table = makeTable(['a', 'b', 'c']);
  table.startHand();

  table.call('a');
  table.call('b');
  // c hat bereits bet === currentBet (BB) -> call ist ungültig, check ist richtig
  assert.throws(() => table.call('c'), /Nichts zu callen/);
});

run('placeBet erzwingt den Mindesteinsatz und ist nur ohne bestehenden Einsatz erlaubt', () => {
  const table = makeTable(['a', 'b', 'c']);
  table.startHand();
  table.call('a');
  table.call('b');
  table.check('c');
  table.dealFlop();

  const firstToAct = table.getCurrentPlayer().id;
  assert.throws(() => table.placeBet(firstToAct, 5), /Mindesteinsatz/);
  assert.throws(() => table.raise(firstToAct, 20), /Noch kein Einsatz vorhanden/);

  table.placeBet(firstToAct, 10);
  assert.strictEqual(table.currentBet, 10);
  const nextPlayer = table.getCurrentPlayer().id;
  assert.throws(() => table.placeBet(nextPlayer, 10), /Es liegt bereits ein Einsatz vor/);
});

run('All-in-Call für weniger als den aktuellen Einsatz schließt die Runde trotzdem ab', () => {
  const table = makeTable(['a', 'b'], { chips: 1000 });
  table.addPlayer('c', 'Spieler-c', 20);
  table.startHand(); // dealer=a, SB=b, BB=c (nur 20 Chips, reicht für 10)

  table.raise('a', 100); // UTG raist stark

  const b = table.players.find((p) => p.id === 'b');
  const c = table.players.find((p) => p.id === 'c');

  table.call('b');
  table.call('c'); // kann nur mit den restlichen 10 Chips callen -> All-In für 20 gesamt

  assert.strictEqual(c.isAllIn, true);
  assert.strictEqual(c.chips, 0);
  assert.strictEqual(c.bet, 20);
  assert.strictEqual(table.isBettingRoundComplete(), true);
  assert.strictEqual(table.actingIndex, -1);
  assert.strictEqual(table.pot, 100 + 100 + 20);
  assert.strictEqual(b.bet, 100);
});

run('dealFlop/dealTurn/dealRiver/showdown verweigern Ausführung vor Rundenende oder in falscher Phase', () => {
  const table = makeTable(['a', 'b', 'c']);
  table.startHand();

  assert.throws(() => table.dealFlop(), /Wettrunde noch nicht abgeschlossen/);
  assert.throws(() => table.dealTurn(), /erwartet "flop"/);

  table.call('a');
  table.call('b');
  table.check('c');
  table.dealFlop();

  assert.strictEqual(table.phase, 'flop');
  assert.strictEqual(table.currentBet, 0);
  table.players.forEach((p) => assert.strictEqual(p.bet, 0));
  // Nach dem Flop ist der erste aktive Spieler links vom Dealer dran
  assert.strictEqual(table.getCurrentPlayer().id, table.players[1].id);
});

run('Kompletter Ablauf einer Hand bis zum Showdown erhält die Gesamtzahl der Chips', () => {
  const table = makeTable(['a', 'b']);
  const startingTotal = totalChips(table);
  table.startHand();

  table.call('a'); // Dealer/SB callt auf Big Blind
  table.check('b'); // BB-Option

  table.dealFlop();
  table.check(table.getCurrentPlayer().id);
  table.check(table.getCurrentPlayer().id);

  table.dealTurn();
  table.check(table.getCurrentPlayer().id);
  table.check(table.getCurrentPlayer().id);

  table.dealRiver();
  table.check(table.getCurrentPlayer().id);
  table.check(table.getCurrentPlayer().id);

  const result = table.showdown();

  assert.strictEqual(table.phase, 'showdown');
  assert.strictEqual(table.pot, 0);
  assert.ok(result.winners.length >= 1);
  assert.strictEqual(totalChips(table), startingTotal);
});

run('Dealer-Button rückt nach jeder Hand weiter', () => {
  const table = makeTable(['a', 'b', 'c']);
  table.startHand();
  assert.strictEqual(table.dealerIndex, 0);

  table.fold('a');
  table.startHand();
  assert.strictEqual(table.dealerIndex, 1);
});

run('markDisconnected entfernt den Spieler nicht, sondern markiert ihn nur', () => {
  const table = makeTable(['a', 'b', 'c']);
  table.startHand();

  table.markDisconnected('b');

  assert.strictEqual(table.players.length, 3);
  const b = table.players.find((p) => p.id === 'b');
  assert.strictEqual(b.disconnected, true);
  assert.strictEqual(b.holeCards.length, 2); // Karten und Chips bleiben erhalten
});

run('reconnectPlayer verbindet einen getrennten Spieler unter neuer ID wieder', () => {
  const table = makeTable(['a', 'b', 'c']);
  table.startHand();
  table.markDisconnected('b');

  const oldId = table.reconnectPlayer('b-new-socket', 'Spieler-b');

  assert.strictEqual(oldId, 'b');
  assert.strictEqual(table.players.length, 3);
  const reconnected = table.players.find((p) => p.name === 'Spieler-b');
  assert.strictEqual(reconnected.id, 'b-new-socket');
  assert.strictEqual(reconnected.disconnected, false);
  assert.strictEqual(reconnected.holeCards.length, 2); // Hand bleibt erhalten
});

run('reconnectPlayer schlägt fehl, wenn kein getrennter Spieler mit diesem Namen existiert', () => {
  const table = makeTable(['a', 'b']);
  table.startHand();

  assert.strictEqual(table.reconnectPlayer('neu', 'Spieler-b'), null); // b ist noch verbunden
  assert.strictEqual(table.reconnectPlayer('neu', 'Unbekannt'), null); // Name existiert gar nicht
});

run('getPublicState zeigt den disconnected-Status pro Spieler', () => {
  const table = makeTable(['a', 'b']);
  table.startHand();
  table.markDisconnected('a');

  const state = table.getPublicState('b');
  const a = state.players.find((p) => p.id === 'a');
  const b = state.players.find((p) => p.id === 'b');
  assert.strictEqual(a.disconnected, true);
  assert.strictEqual(b.disconnected, false);
});

console.log('\nAlle Tests durchgelaufen.');
