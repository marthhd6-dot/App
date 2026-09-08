// src/game/table.js
// Verwaltet einen Poker-Tisch: Spieler, Deck, Phasen, Pot, Wettrunden.
//
// Side Pots: Sind mehrere Spieler mit unterschiedlich hohen Stacks all-in,
// wird der Pot beim Showdown anhand der tatsächlichen Gesamteinsätze
// (totalContributed) in Haupt- und Neben-Pots aufgeteilt (siehe
// _computePots()). Jeder Pot-Layer wird nur unter den Spielern verteilt,
// die genug eingesetzt haben, um für ihn infrage zu kommen.

const { createDeck, shuffle, draw } = require('./deck');
const { determineWinners } = require('./handEvaluator');
const {
  assignAbilities,
  describeAbilitiesForClient,
  ABILITY_CHIP_BOOST_RATE,
  ABILITY_POT_BONUS_RATE,
} = require('./abilities');

const PHASES = ['waiting', 'preflop', 'flop', 'turn', 'river', 'showdown'];

class Table {
  constructor({ smallBlind = 5, bigBlind = 10 } = {}) {
    this.players = []; // { id, name, chips, holeCards, folded, isAllIn, bet, hasActed, disconnected, totalContributed }
    this.deck = [];
    this.communityCards = [];
    this.pot = 0;
    this.phase = 'waiting';
    this.dealerIndex = 0;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.currentBet = 0; // höchster Einsatz in der aktuellen Wettrunde
    this.minRaise = bigBlind; // kleinster erlaubter Raise-Schritt in der aktuellen Runde
    this.actingIndex = -1; // Index des Spielers, der am Zug ist (-1 = niemand/Runde fertig)
    this.lastHandResult = null;
    this._firstHandDealt = false;
    this.spyReveals = []; // siehe _applySpy(), pro Hand neu befüllt in startHand()
  }

  addPlayer(id, name, chips = 1000) {
    if (this.players.find((p) => p.id === id)) return;
    this.players.push({
      id,
      name,
      chips,
      holeCards: [],
      folded: false,
      isAllIn: false,
      bet: 0,
      hasActed: false,
      disconnected: false,
      totalContributed: 0,
      abilities: null, // erst ab der ersten Hand zugewiesen, siehe startHand()
    });
  }

  removePlayer(id) {
    this.players = this.players.filter((p) => p.id !== id);
  }

  // Markiert einen Spieler als getrennt, ohne ihn aus dem Tisch zu entfernen –
  // Chips, Karten und Sitzplatz (Reihenfolge) bleiben erhalten, damit er
  // innerhalb einer Gnadenfrist per reconnectPlayer() zurückkehren kann. Der
  // Server entscheidet, wie lange diese Frist läuft, und ruft danach ggf.
  // removePlayer() auf.
  markDisconnected(id) {
    const player = this.players.find((p) => p.id === id);
    if (player) player.disconnected = true;
  }

  // Verbindet einen zuvor getrennten Spieler unter einer neuen ID wieder,
  // sofern ein Spieler mit gleichem Namen aktuell als "disconnected" markiert
  // ist. Gibt dessen alte ID zurück (z. B. um einen Timeout-Timer anhand
  // dieser ID zu löschen) oder null, wenn kein passender Spieler gefunden
  // wurde. Bekannte Vereinfachung: Die Wiedererkennung läuft allein über den
  // Namen, es gibt keine echte Authentifizierung.
  reconnectPlayer(newId, name) {
    const player = this.players.find((p) => p.disconnected && p.name === name);
    if (!player) return null;
    const oldId = player.id;
    player.id = newId;
    player.disconnected = false;
    return oldId;
  }

  startHand() {
    if (this.players.length < 2) {
      throw new Error('Mindestens 2 Spieler nötig, um eine Hand zu starten.');
    }
    this.deck = shuffle(createDeck());
    this.communityCards = [];
    this.pot = 0;
    this.phase = 'preflop';
    this.lastHandResult = null;
    this.players.forEach((p) => {
      p.holeCards = [];
      p.folded = false;
      p.isAllIn = false;
      p.bet = 0;
      p.hasActed = false;
      p.totalContributed = 0;
      // Jede Hand neu: eine frische, ungenutzte Fähigkeit pro Kategorie
      // (Karten/Wette-Pot/Info-Gegner/Ressourcen), siehe abilities.js.
      p.abilities = assignAbilities();
    });
    // Wer in dieser Hand wessen Karte "spioniert" hat (siehe useAbility()
    // unten) – pro Hand neu, gilt nur bis zum nächsten startHand().
    this.spyReveals = [];

    // Dealer-Button vor jeder Hand außer der ersten weiterrücken
    if (this._firstHandDealt) {
      this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    }
    this._firstHandDealt = true;

    // Hole Cards austeilen (zwei Runden, wie am echten Tisch)
    for (let round = 0; round < 2; round++) {
      for (const p of this.players) {
        const { drawn, remaining } = draw(this.deck, 1);
        this.deck = remaining;
        p.holeCards.push(drawn[0]);
      }
    }

    this._postBlinds();
  }

  _postBlinds() {
    const n = this.players.length;
    // Heads-up-Sonderregel: Der Dealer ist gleichzeitig Small Blind.
    const sbIndex = n === 2 ? this.dealerIndex : (this.dealerIndex + 1) % n;
    const bbIndex = n === 2 ? (this.dealerIndex + 1) % n : (this.dealerIndex + 2) % n;

    this._postBlind(sbIndex, this.smallBlind);
    this._postBlind(bbIndex, this.bigBlind);

    this.currentBet = this.players[bbIndex].bet;
    this.minRaise = this.bigBlind;
    this.actingIndex = this._nextActiveIndex(bbIndex);
  }

  _postBlind(index, amount) {
    const player = this.players[index];
    const actual = Math.min(amount, player.chips);
    player.chips -= actual;
    player.bet += actual;
    player.totalContributed += actual;
    this.pot += actual;
    if (player.chips === 0) player.isAllIn = true;
  }

  dealFlop() {
    this._assertPhase('preflop');
    this._assertBettingRoundComplete();
    const { drawn, remaining } = draw(this.deck, 3);
    this.deck = remaining;
    this.communityCards.push(...drawn);
    this.phase = 'flop';
    this._startNewBettingRound();
  }

  dealTurn() {
    this._assertPhase('flop');
    this._assertBettingRoundComplete();
    const { drawn, remaining } = draw(this.deck, 1);
    this.deck = remaining;
    this.communityCards.push(...drawn);
    this.phase = 'turn';
    this._startNewBettingRound();
  }

  dealRiver() {
    this._assertPhase('turn');
    this._assertBettingRoundComplete();
    const { drawn, remaining } = draw(this.deck, 1);
    this.deck = remaining;
    this.communityCards.push(...drawn);
    this.phase = 'river';
    this._startNewBettingRound();
  }

  // Setzt den Zustand für eine neue Wettrunde nach Flop/Turn/River zurück.
  // Erster Spieler links vom Dealer ist am Zug (Post-Flop-Reihenfolge).
  _startNewBettingRound() {
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.players.forEach((p) => {
      p.bet = 0;
      p.hasActed = false;
    });
    this.actingIndex = this._nextActiveIndex(this.dealerIndex);
  }

  // --- Wettrunden-Aktionen -------------------------------------------------

  fold(playerId) {
    const player = this._assertPlayersTurn(playerId);
    player.folded = true;
    player.hasActed = true;
    this._advanceActingIndex();
  }

  check(playerId) {
    const player = this._assertPlayersTurn(playerId);
    // "< " statt "!==": Ist der Big Blind kurzgestapelt und postet weniger
    // als den vollen Big Blind (All-in-Blind), kann currentBet unter dem
    // Einsatz des Small Blind liegen – der Small Blind hat dann bereits
    // mehr eingesetzt, als aktuell gefordert ist, und darf trotzdem
    // checken (nichts nachzuzahlen), statt in einer Sackgasse zu landen,
    // in der weder check() (exakte Gleichheit) noch call() (owed > 0)
    // erlaubt wären.
    if (player.bet < this.currentBet) {
      throw new Error('Check nicht möglich, es liegt bereits ein Einsatz vor. Nutze call oder raise.');
    }
    player.hasActed = true;
    this._advanceActingIndex();
  }

  call(playerId) {
    const player = this._assertPlayersTurn(playerId);
    const owed = this.currentBet - player.bet;
    if (owed <= 0) {
      throw new Error('Nichts zu callen, nutze check.');
    }
    const amount = Math.min(owed, player.chips);
    player.chips -= amount;
    player.bet += amount;
    player.totalContributed += amount;
    this.pot += amount;
    if (player.chips === 0) player.isAllIn = true;
    player.hasActed = true;
    this._advanceActingIndex();
  }

  // Eröffnet den Einsatz in einer Runde, in der noch niemand gesetzt hat.
  placeBet(playerId, amount) {
    const player = this._assertPlayersTurn(playerId);
    if (this.currentBet !== 0) {
      throw new Error('Es liegt bereits ein Einsatz vor, nutze raise.');
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('Einsatz muss eine positive ganze Zahl sein.');
    }
    const isAllIn = amount >= player.chips;
    const actual = isAllIn ? player.chips : amount;
    if (!isAllIn && actual < this.bigBlind) {
      throw new Error(`Mindesteinsatz ist ${this.bigBlind}.`);
    }
    player.chips -= actual;
    player.bet += actual;
    player.totalContributed += actual;
    this.pot += actual;
    if (isAllIn) player.isAllIn = true;
    this.currentBet = player.bet;
    this.minRaise = Math.max(this.bigBlind, actual);
    player.hasActed = true;
    this._reopenAction(player.id);
    this._advanceActingIndex();
  }

  // Erhöht einen bestehenden Einsatz. totalAmount ist der neue Gesamteinsatz
  // des Spielers in dieser Runde ("raise to"), nicht nur die Differenz.
  raise(playerId, totalAmount) {
    const player = this._assertPlayersTurn(playerId);
    if (this.currentBet === 0) {
      throw new Error('Noch kein Einsatz vorhanden, nutze placeBet.');
    }
    const additional = totalAmount - player.bet;
    if (!Number.isInteger(additional) || additional <= 0 || additional > player.chips) {
      throw new Error('Ungültiger Raise-Betrag.');
    }
    const isAllIn = additional === player.chips;
    const newBet = player.bet + additional;
    const raiseSize = newBet - this.currentBet;
    if (raiseSize <= 0) {
      throw new Error('Ein Raise muss den aktuellen Einsatz überbieten.');
    }
    if (!isAllIn && raiseSize < this.minRaise) {
      throw new Error(`Raise muss mindestens ${this.minRaise} über dem aktuellen Einsatz liegen.`);
    }

    player.chips -= additional;
    player.bet = newBet;
    player.totalContributed += additional;
    this.pot += additional;
    if (isAllIn) player.isAllIn = true;

    if (raiseSize >= this.minRaise) {
      this.minRaise = raiseSize;
    }
    this.currentBet = newBet;
    player.hasActed = true;
    this._reopenAction(player.id);
    this._advanceActingIndex();
  }

  // --- Fähigkeiten -----------------------------------------------------------
  //
  // Anders als fold/check/call/bet/raise ist useAbility() keine
  // Wettrunden-Aktion: sie ist nicht an den Zug gebunden (jeder Spieler
  // kann seine Fähigkeiten jederzeit während einer laufenden Hand einsetzen,
  // unabhängig davon, wer gerade am Zug ist) und rührt actingIndex/
  // hasActed nicht an.

  // Setzt eine der vier Fähigkeiten-Kategorien dieses Spielers für die
  // laufende Hand ein. Wirft, wenn keine Hand läuft, der Spieler bereits
  // gefoldet hat, die Kategorie unbekannt ist oder ihr Slot in dieser Hand
  // schon benutzt wurde.
  useAbility(playerId, category) {
    if (this.phase === 'waiting' || this.phase === 'showdown') {
      throw new Error('Keine laufende Hand, um eine Fähigkeit einzusetzen.');
    }
    const player = this.players.find((p) => p.id === playerId);
    if (!player) {
      throw new Error(`Spieler ${playerId} sitzt nicht an diesem Tisch.`);
    }
    if (player.folded) {
      throw new Error('Gefoldete Spieler können keine Fähigkeit mehr einsetzen.');
    }
    const slot = player.abilities && player.abilities[category];
    if (!slot) {
      throw new Error(`Unbekannte Fähigkeits-Kategorie "${category}".`);
    }
    if (slot.used) {
      throw new Error('Diese Fähigkeit wurde in dieser Hand bereits eingesetzt.');
    }

    switch (slot.id) {
      case 'cardSwap':
        this._applyCardSwap(player);
        break;
      case 'chipBoost':
        this._applyChipBoost(player);
        break;
      case 'potBonus':
        // Wirkt erst beim Hand-Ende, siehe _applyPotBonusIfActive() weiter
        // unten (in _checkWinByFold() und showdown() aufgerufen).
        slot.active = true;
        break;
      case 'spy':
        this._applySpy(player);
        break;
      default:
        throw new Error(`Unbekannte Fähigkeit "${slot.id}".`);
    }
    slot.used = true;
    return { ability: slot.id };
  }

  // Tauscht eine zufällige der beiden Hole Cards gegen eine neue vom Deck.
  // Die alte Karte wird verworfen statt zurück ins Deck gemischt (bei einem
  // 52-Karten-Deck und maximal 4 Spielern bleibt so oder so reichlich
  // Reserve für Board + weitere Fähigkeiten-Einsätze in derselben Hand).
  _applyCardSwap(player) {
    const index = Math.random() < 0.5 ? 0 : 1;
    const { drawn, remaining } = draw(this.deck, 1);
    this.deck = remaining;
    player.holeCards[index] = drawn[0];
  }

  // Schreibt sofort einen Chip-Bonus gut, finanziert vom "System", nicht von
  // anderen Spielern – mindestens 1 Chip, damit die Fähigkeit auch bei
  // einem sehr kleinen Stack spürbar etwas bringt.
  _applyChipBoost(player) {
    const bonus = Math.max(1, Math.round(player.chips * ABILITY_CHIP_BOOST_RATE));
    player.chips += bonus;
  }

  // Deckt eine zufällige Hole Card eines zufälligen, noch nicht gefoldeten
  // Gegners auf – nur für den einsetzenden Spieler sichtbar (siehe
  // getPublicState() unten). Kein Effekt (aber auch kein Fehler), falls kein
  // Gegner mehr im Spiel ist.
  _applySpy(player) {
    const opponents = this.players.filter((p) => p.id !== player.id && !p.folded);
    if (opponents.length === 0) return;
    const target = opponents[Math.floor(Math.random() * opponents.length)];
    const cardIndex = Math.floor(Math.random() * target.holeCards.length);
    this.spyReveals.push({ viewerId: player.id, targetId: target.id, cardIndex });
  }

  // Erhöht baseShare um ABILITY_POT_BONUS_RATE, falls der Spieler seinen
  // Pot-Bonus-Slot in dieser Hand aktiviert hat (siehe useAbility() oben) –
  // sonst unverändert. Wird sowohl bei einem Sieg durch Fold als auch beim
  // echten Showdown auf den tatsächlichen Chip-Zuwachs angewendet.
  _applyPotBonusIfActive(player, baseShare) {
    if (player.abilities?.pot?.active) {
      return Math.round(baseShare * (1 + ABILITY_POT_BONUS_RATE));
    }
    return baseShare;
  }

  // --- Interne Helfer --------------------------------------------------------

  // Ein Bet oder Raise zwingt alle anderen noch spielenden Spieler erneut zum
  // Handeln (auch wenn sie diese Runde schon agiert hatten). Vereinfachung:
  // das gilt auch für einen All-In-Raise unter dem Mindest-Raise – offizielle
  // Turnierregeln würden die Runde dann nicht für alle wieder öffnen.
  _reopenAction(aggressorId) {
    this.players.forEach((p) => {
      if (p.id !== aggressorId && !p.folded && !p.isAllIn) {
        p.hasActed = false;
      }
    });
  }

  _advanceActingIndex() {
    if (this._checkWinByFold()) return;
    if (this.isBettingRoundComplete()) {
      this.actingIndex = -1;
      return;
    }
    this.actingIndex = this._nextActiveIndex(this.actingIndex);
  }

  // Wenn nur noch ein Spieler nicht gefoldet hat, gewinnt er den gesamten
  // Pot sofort ohne Showdown – unabhängig von etwaigen Side-Pot-Grenzen,
  // denn ohne Showdown gibt es keine Hand zu vergleichen: Wer als Letzter
  // übrig bleibt, nimmt alles mit (genau wie am echten Tisch).
  _checkWinByFold() {
    const contenders = this.players.filter((p) => !p.folded);
    if (contenders.length !== 1) return false;
    const winner = contenders[0];
    const amount = this.pot;
    const potShare = this._applyPotBonusIfActive(winner, amount);
    winner.chips += potShare;
    this.pot = 0;
    this.phase = 'showdown';
    this.actingIndex = -1;
    this.lastHandResult = {
      reason: 'fold',
      pots: [{ amount, winners: [{ id: winner.id, name: winner.name }], potShare }],
    };
    return true;
  }

  // Nächster Spieler nach fromIndex, der noch mitspielt und noch handeln kann
  // (nicht gefoldet, nicht all-in). Gibt -1 zurück, wenn niemand mehr handeln kann.
  _nextActiveIndex(fromIndex) {
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const idx = (fromIndex + step) % n;
      const p = this.players[idx];
      if (!p.folded && !p.isAllIn) return idx;
    }
    return -1;
  }

  // Eine Wettrunde ist abgeschlossen, wenn jeder verbleibende Spieler entweder
  // all-in ist oder (gehandelt hat UND den aktuellen Einsatz mindestens
  // gematcht hat). ">=" statt "===", damit ein Small Blind, der wegen eines
  // kurzgestapelten Big-Blind-All-ins bereits mehr eingesetzt hat als
  // currentBet, nach einem check() korrekt als "fertig" zählt (siehe
  // check() weiter oben für dasselbe Prinzip).
  isBettingRoundComplete() {
    const contenders = this.players.filter((p) => !p.folded);
    if (contenders.length <= 1) return true;
    const toAct = contenders.filter((p) => !p.isAllIn);
    if (toAct.length === 0) return true;
    return toAct.every((p) => p.hasActed && p.bet >= this.currentBet);
  }

  getCurrentPlayer() {
    if (this.actingIndex === -1) return null;
    return this.players[this.actingIndex] || null;
  }

  _assertPlayersTurn(playerId) {
    const player = this.getCurrentPlayer();
    if (!player || player.id !== playerId) {
      throw new Error(`Spieler ${playerId} ist nicht am Zug.`);
    }
    return player;
  }

  _assertBettingRoundComplete() {
    if (this.actingIndex !== -1) {
      throw new Error('Wettrunde noch nicht abgeschlossen.');
    }
  }

  showdown() {
    this._assertPhase('river');
    this._assertBettingRoundComplete();

    const pots = this._computePots();
    const potResults = pots.map((potLayer) => {
      const eligiblePlayers = this.players.filter((p) => potLayer.eligiblePlayerIds.includes(p.id));
      const { winnerIndexes } = determineWinners(eligiblePlayers, this.communityCards);
      const winners = winnerIndexes.map((i) => eligiblePlayers[i]);
      const baseShare = Math.floor(potLayer.amount / winners.length);
      winners.forEach((w) => {
        w.chips += this._applyPotBonusIfActive(w, baseShare);
      });
      // Bei genau einem Gewinner (der weit überwiegende Fall) zeigt
      // potShare den tatsächlich inkl. Pot-Bonus ausgezahlten Betrag. Bei
      // einem seltenen Split-Pot mit mehreren Gewinnern bleibt potShare der
      // reine Basis-Anteil (ein einzelner Anzeigewert für ggf. mehrere
      // Namen, siehe potLines in app.js) – individuelle Pot-Boni fließen
      // dort trotzdem korrekt in die tatsächlichen Chip-Stände ein.
      const potShare = winners.length === 1 ? this._applyPotBonusIfActive(winners[0], baseShare) : baseShare;
      return {
        amount: potLayer.amount,
        winners: winners.map((w) => ({ id: w.id, name: w.name })),
        potShare,
      };
    });

    this.pot = 0;
    this.phase = 'showdown';
    this.lastHandResult = { reason: 'showdown', pots: potResults };
    return { pots: potResults };
  }

  // Teilt den Pot anhand der Gesamteinsätze (totalContributed) aller
  // Spieler dieser Hand in "Layer" auf: einen Hauptpot und ggf. mehrere
  // Neben-Pots, wenn Spieler mit unterschiedlich hohen Stacks all-in
  // gegangen sind. Jeder Layer ist nur unter den Spielern zu gewinnen, die
  // mindestens bis zur jeweiligen Grenze mitgegangen sind UND nicht
  // gefoldet haben – wer gefoldet hat, hat seinen Einsatz trotzdem
  // beigetragen (er bleibt im Pot), kann ihn aber nicht mehr gewinnen.
  _computePots() {
    const contributions = this.players
      .filter((p) => p.totalContributed > 0)
      .map((p) => ({ id: p.id, amount: p.totalContributed, folded: p.folded }));

    const levels = [...new Set(contributions.map((c) => c.amount))].sort((a, b) => a - b);

    const pots = [];
    let previousLevel = 0;
    for (const level of levels) {
      const layerSize = level - previousLevel;
      const contributors = contributions.filter((c) => c.amount >= level);
      const amount = layerSize * contributors.length;
      const eligiblePlayerIds = contributors.filter((c) => !c.folded).map((c) => c.id);
      // eligiblePlayerIds ist bei korrektem Spielverlauf nie leer: Sobald nur
      // noch ein Spieler nicht gefoldet ist, entscheidet _checkWinByFold die
      // Hand bereits vorher ohne Showdown. Die Prüfung bleibt als defensive
      // Absicherung stehen, damit kein Layer "ins Leere" ausgezahlt wird.
      if (amount > 0 && eligiblePlayerIds.length > 0) {
        pots.push({ amount, eligiblePlayerIds });
      }
      previousLevel = level;
    }
    return pots;
  }

  _assertPhase(expected) {
    if (this.phase !== expected) {
      throw new Error(`Aktion nicht erlaubt in Phase "${this.phase}", erwartet "${expected}".`);
    }
  }

  // Gibt eine für alle Clients sichere Sicht zurück (keine fremden Hole Cards)
  // extraVisibleIds: IDs weiterer Spieler, deren Hole Cards für forPlayerId
  // ebenfalls sichtbar sein sollen (z. B. das Teammitglied im Casual-Team-
  // Modus, siehe server.js). Normalerweise leer – dann sieht jeder wie
  // gewohnt nur die eigenen Karten.
  //
  // Bei einem echten Showdown (this.lastHandResult.reason === 'showdown',
  // also nachdem Hände tatsächlich verglichen wurden – im Unterschied zu
  // einem Sieg durch Fold, wo niemand seine Karten zeigt) werden zusätzlich
  // die Hole Cards aller nicht gefoldeten Spieler für JEDEN sichtbar, damit
  // klar ist, gegen welche Hand man gewonnen oder verloren hat – wie am
  // echten Tisch.
  getPublicState(forPlayerId, extraVisibleIds = []) {
    const revealAtShowdown = this.phase === 'showdown' && this.lastHandResult?.reason === 'showdown';
    return {
      phase: this.phase,
      pot: this.pot,
      communityCards: this.communityCards,
      currentBet: this.currentBet,
      // bigBlind/minRaise: nötig, damit das Frontend die legalen Grenzen für
      // Bet/Raise kennt (Mindesteinsatz bzw. Mindest-Raise-Schritt) – für
      // den Bet-Schieberegler samt Schnellwahl-Knöpfen (¼/½ Pot, All-In),
      // siehe renderBetSizer() in app.js. Server-seitig bleibt placeBet()/
      // raise() weiterhin die einzige verbindliche Validierung.
      bigBlind: this.bigBlind,
      minRaise: this.minRaise,
      actingPlayerId: this.getCurrentPlayer()?.id ?? null,
      dealerPlayerId: this.players[this.dealerIndex]?.id ?? null,
      lastHandResult: this.lastHandResult,
      players: this.players.map((p) => {
        const visible =
          p.id === forPlayerId ||
          extraVisibleIds.includes(p.id) ||
          (revealAtShowdown && !p.folded);
        // Spionage (siehe _applySpy()): deckt für forPlayerId gezielt eine
        // einzelne Hole Card eines Gegners auf, unabhängig von visible –
        // nur relevant, wenn dessen Karten sonst verborgen blieben (visible
        // zeigt ja bereits beide Karten).
        const spied = !visible && this.spyReveals.find((s) => s.viewerId === forPlayerId && s.targetId === p.id);
        return {
          id: p.id,
          name: p.name,
          chips: p.chips,
          bet: p.bet,
          folded: p.folded,
          isAllIn: p.isAllIn,
          disconnected: p.disconnected,
          holeCards: visible ? p.holeCards : null,
          spiedCard: spied ? p.holeCards[spied.cardIndex] : null,
          // Die eigenen Fähigkeits-Karten (siehe abilities.js) sind privat –
          // andere Spieler bekommen hier null, nur forPlayerId sieht seine
          // eigenen vier Kategorien samt Name/Icon/Beschreibung und
          // used-Status.
          abilities: p.id === forPlayerId ? describeAbilitiesForClient(p.abilities) : null,
        };
      }),
    };
  }
}

module.exports = { Table, PHASES };
