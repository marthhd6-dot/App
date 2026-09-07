// src/game/table.js
// Verwaltet einen Poker-Tisch: Spieler, Deck, Phasen, Pot, Wettrunden.
//
// Bekannte Vereinfachung: Es gibt nur einen gemeinsamen Pot, keine Side Pots
// bei mehreren unterschiedlich hohen All-Ins. Für einen einfachen Heim-Tisch
// ausreichend, für ein Turnier mit vielen Stack-Größen müsste das nachgerüstet
// werden.

const { createDeck, shuffle, draw } = require('./deck');
const { determineWinners } = require('./handEvaluator');

const PHASES = ['waiting', 'preflop', 'flop', 'turn', 'river', 'showdown'];

class Table {
  constructor({ smallBlind = 5, bigBlind = 10 } = {}) {
    this.players = []; // { id, name, chips, holeCards, folded, isAllIn, bet, hasActed }
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
    });
  }

  removePlayer(id) {
    this.players = this.players.filter((p) => p.id !== id);
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
    });

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
    if (player.bet !== this.currentBet) {
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

  // Wenn nur noch ein Spieler nicht gefoldet hat, gewinnt er den Pot sofort
  // ohne Showdown.
  _checkWinByFold() {
    const contenders = this.players.filter((p) => !p.folded);
    if (contenders.length !== 1) return false;
    const winner = contenders[0];
    const potShare = this.pot;
    winner.chips += potShare;
    this.pot = 0;
    this.phase = 'showdown';
    this.actingIndex = -1;
    this.lastHandResult = {
      winners: [{ id: winner.id, name: winner.name }],
      reason: 'fold',
      potShare,
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
  // all-in ist oder (gehandelt hat UND den aktuellen Einsatz gematcht hat).
  isBettingRoundComplete() {
    const contenders = this.players.filter((p) => !p.folded);
    if (contenders.length <= 1) return true;
    const toAct = contenders.filter((p) => !p.isAllIn);
    if (toAct.length === 0) return true;
    return toAct.every((p) => p.hasActed && p.bet === this.currentBet);
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
    const activePlayers = this.players.filter((p) => !p.folded);
    const { winnerIndexes, results } = determineWinners(activePlayers, this.communityCards);
    const winners = winnerIndexes.map((i) => activePlayers[i]);
    const share = Math.floor(this.pot / winners.length);
    winners.forEach((w) => {
      w.chips += share;
    });
    const potShare = this.pot;
    this.pot = 0;
    this.phase = 'showdown';
    this.lastHandResult = {
      winners: winners.map((w) => ({ id: w.id, name: w.name })),
      reason: 'showdown',
      potShare: share,
    };
    return {
      winners: winners.map((w) => ({ id: w.id, name: w.name })),
      results: results.map((r) => ({ name: r.name })),
      potShare: share,
    };
  }

  _assertPhase(expected) {
    if (this.phase !== expected) {
      throw new Error(`Aktion nicht erlaubt in Phase "${this.phase}", erwartet "${expected}".`);
    }
  }

  // Gibt eine für alle Clients sichere Sicht zurück (keine fremden Hole Cards)
  getPublicState(forPlayerId) {
    return {
      phase: this.phase,
      pot: this.pot,
      communityCards: this.communityCards,
      currentBet: this.currentBet,
      actingPlayerId: this.getCurrentPlayer()?.id ?? null,
      dealerPlayerId: this.players[this.dealerIndex]?.id ?? null,
      lastHandResult: this.lastHandResult,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        folded: p.folded,
        isAllIn: p.isAllIn,
        holeCards: p.id === forPlayerId ? p.holeCards : null,
      })),
    };
  }
}

module.exports = { Table, PHASES };
