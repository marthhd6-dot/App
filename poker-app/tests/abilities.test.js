// tests/abilities.test.js
// Ausführen mit: npm test  (nutzt nur Node's eingebautes assert, kein Framework nötig)

const assert = require('assert');
const { Table } = require('../src/game/table');
const {
  CATEGORIES,
  ABILITY_CHIP_BOOST_RATE,
  ABILITY_POT_BONUS_RATE,
  assignAbilities,
  describeAbilitiesForClient,
} = require('../src/game/abilities');

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

run('assignAbilities: liefert genau eine ungenutzte Fähigkeit je Kategorie', () => {
  const abilities = assignAbilities();
  assert.deepStrictEqual(Object.keys(abilities).sort(), [...CATEGORIES].sort());
  CATEGORIES.forEach((category) => {
    assert.strictEqual(abilities[category].used, false);
  });
});

run('describeAbilitiesForClient: null bleibt null, sonst 4 Einträge mit Katalog-Metadaten', () => {
  assert.strictEqual(describeAbilitiesForClient(null), null);
  const described = describeAbilitiesForClient(assignAbilities());
  assert.strictEqual(described.length, 4);
  described.forEach((entry) => {
    assert.ok(entry.name && entry.icon && entry.description);
    assert.strictEqual(entry.used, false);
  });
});

run('startHand: jeder Spieler bekommt zu Beginn jeder Hand frische, ungenutzte Fähigkeiten', () => {
  const table = makeTable(['a', 'b', 'c']);
  table.startHand();
  table.players.forEach((p) => {
    assert.ok(p.abilities);
    CATEGORIES.forEach((category) => assert.strictEqual(p.abilities[category].used, false));
  });
});

run('useAbility: außerhalb einer laufenden Hand (waiting/showdown) nicht möglich', () => {
  const table = makeTable(['a', 'b']);
  assert.throws(() => table.useAbility('a', 'resource'), /Keine laufende Hand/);

  table.startHand();
  table.fold('a'); // Sieg durch Fold -> Phase 'showdown'
  assert.throws(() => table.useAbility('b', 'resource'), /Keine laufende Hand/);
});

run('useAbility: unbekannte Kategorie, unbekannter Spieler und Doppel-Einsatz werfen', () => {
  const table = makeTable(['a', 'b']);
  table.startHand();
  assert.throws(() => table.useAbility('a', 'unbekannt'), /Unbekannte Fähigkeits-Kategorie/);
  assert.throws(() => table.useAbility('nobody', 'resource'), /sitzt nicht an diesem Tisch/);

  table.useAbility('a', 'resource');
  assert.throws(() => table.useAbility('a', 'resource'), /bereits eingesetzt/);
});

run('useAbility: gefoldete Spieler können keine Fähigkeit mehr einsetzen', () => {
  const table = makeTable(['a', 'b', 'c']);
  table.startHand();
  table.fold(table.getCurrentPlayer().id); // erster Spieler foldet, Hand läuft für die anderen weiter
  const folded = table.players.find((p) => p.folded);
  assert.throws(() => table.useAbility(folded.id, 'resource'), /Gefoldete Spieler/);
});

run('Chip-Boost: schreibt sofort einen Bonus auf den aktuellen Stack gut', () => {
  const table = makeTable(['a', 'b'], { chips: 1000 });
  table.startHand();
  const player = table.players.find((p) => p.id === 'a');
  const chipsBefore = player.chips;
  table.useAbility('a', 'resource');
  assert.strictEqual(player.chips, chipsBefore + Math.round(chipsBefore * ABILITY_CHIP_BOOST_RATE));
  assert.strictEqual(player.abilities.resource.used, true);
});

run('Kartentausch: ersetzt genau eine Hole Card durch eine neue Karte, die andere bleibt', () => {
  const table = makeTable(['a', 'b']);
  table.startHand();
  const player = table.players.find((p) => p.id === 'a');
  const before = [...player.holeCards];
  const deckSizeBefore = table.deck.length;

  table.useAbility('a', 'cards');

  const unchangedCount = player.holeCards.filter(
    (c, i) => c.rank === before[i].rank && c.suit === before[i].suit
  ).length;
  assert.strictEqual(unchangedCount, 1, 'genau eine der beiden Karten sollte unverändert bleiben');
  assert.strictEqual(table.deck.length, deckSizeBefore - 1);
  assert.strictEqual(player.abilities.cards.used, true);
});

run('Spionage: deckt eine Hole Card eines Gegners nur für den Spionierenden auf', () => {
  const table = makeTable(['a', 'b']);
  table.startHand();
  table.useAbility('a', 'intel');

  const stateForA = table.getPublicState('a');
  const bFromA = stateForA.players.find((p) => p.id === 'b');
  assert.strictEqual(bFromA.holeCards, null); // weiterhin nicht komplett sichtbar
  assert.ok(bFromA.spiedCard, 'a sollte eine Karte von b spioniert sehen');

  const stateForB = table.getPublicState('b');
  const bFromB = stateForB.players.find((p) => p.id === 'b');
  const aFromB = stateForB.players.find((p) => p.id === 'a');
  assert.strictEqual(aFromB.spiedCard, null); // b selbst sieht nichts von a's Spionage
  assert.strictEqual(bFromB.spiedCard, null); // die eigenen Karten laufen ohnehin über holeCards
});

run('Pot-Bonus: erhöht den Gewinn beim Sieg durch Fold um den Bonus-Satz', () => {
  const table = makeTable(['a', 'b']);
  table.startHand();
  const winner = table.getCurrentPlayer().id === 'a' ? 'b' : 'a'; // wer NICHT am Zug ist, gewinnt gleich durch Fold des anderen
  const loser = winner === 'a' ? 'b' : 'a';
  table.useAbility(winner, 'pot');

  const chipsBefore = table.players.find((p) => p.id === winner).chips;
  const potBefore = table.pot;
  table.fold(loser);

  const winnerPlayer = table.players.find((p) => p.id === winner);
  const expectedShare = Math.round(potBefore * (1 + ABILITY_POT_BONUS_RATE));
  assert.strictEqual(winnerPlayer.chips, chipsBefore + expectedShare);
  assert.strictEqual(table.lastHandResult.pots[0].potShare, expectedShare);
  assert.strictEqual(table.lastHandResult.pots[0].amount, potBefore); // amount bleibt der reine Pot, ohne Bonus
});

run('Pot-Bonus: ohne Aktivierung ändert sich nichts am gewohnten Gewinn', () => {
  const table = makeTable(['a', 'b']);
  table.startHand();
  const toActId = table.getCurrentPlayer().id;
  const winner = toActId === 'a' ? 'b' : 'a';
  const chipsBefore = table.players.find((p) => p.id === winner).chips;
  const potBefore = table.pot;

  table.fold(toActId);

  const winnerPlayer = table.players.find((p) => p.id === winner);
  assert.strictEqual(winnerPlayer.chips, chipsBefore + potBefore);
});

run('Jede Hand setzt used-Status und Spionage-Ergebnisse zurück', () => {
  const table = makeTable(['a', 'b']);
  table.startHand();
  table.useAbility('a', 'resource');
  table.useAbility('a', 'intel');
  assert.strictEqual(table.spyReveals.length, 1);

  table.fold(table.getCurrentPlayer().id); // beendet die Hand durch Fold, egal wer am Zug ist
  table.startHand(); // neue Hand

  const player = table.players.find((p) => p.id === 'a');
  assert.strictEqual(player.abilities.resource.used, false);
  assert.strictEqual(player.abilities.intel.used, false);
  assert.strictEqual(table.spyReveals.length, 0);
});
