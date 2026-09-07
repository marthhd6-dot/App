// src/game/table.js
// Verwaltet einen Poker-Tisch: Spieler, Deck, Phasen, Pot.
// Die Wett-Logik (Runden, Side Pots, All-In) ist bewusst als TODO markiert –
// das ist der Teil, den du mit Claude Code als Nächstes ausbaust.

const { createDeck, shuffle, draw } = require('./deck');
const { determineWinners } = require('./handEvaluator');

const PHASES = ['waiting', 'preflop', 'flop', 'turn', 'river', 'showdown'];

class Table {
  constructor({ smallBlind = 5, bigBlind = 10 } = {}) {
    this.players = []; // { id, name, chips, holeCards, folded, isAllIn }
    this.deck = [];
    this.communityCards = [];
    this.pot = 0;
    this.phase = 'waiting';
    this.dealerIndex = 0;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
  }

  addPlayer(id, name, chips = 1000) {
    if (this.players.find((p) => p.id === id)) return;
    this.players.push({ id, name, chips, holeCards: [], folded: false, isAllIn: false });
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
    this.players.forEach((p) => {
      p.holeCards = [];
      p.folded = false;
      p.isAllIn = false;
    });

    // Hole Cards austeilen (zwei Runden, wie am echten Tisch)
    for (let round = 0; round < 2; round++) {
      for (const p of this.players) {
        const { drawn, remaining } = draw(this.deck, 1);
        this.deck = remaining;
        p.holeCards.push(drawn[0]);
      }
    }

    // TODO: Blinds einziehen (small/big blind Spieler bestimmen, Chips abziehen, in pot legen)
    // TODO: Wettrunde starten – Reihenfolge ab dem Spieler nach dem Big Blind
  }

  dealFlop() {
    this._assertPhase('preflop');
    const { drawn, remaining } = draw(this.deck, 3);
    this.deck = remaining;
    this.communityCards.push(...drawn);
    this.phase = 'flop';
  }

  dealTurn() {
    this._assertPhase('flop');
    const { drawn, remaining } = draw(this.deck, 1);
    this.deck = remaining;
    this.communityCards.push(...drawn);
    this.phase = 'turn';
  }

  dealRiver() {
    this._assertPhase('turn');
    const { drawn, remaining } = draw(this.deck, 1);
    this.deck = remaining;
    this.communityCards.push(...drawn);
    this.phase = 'river';
  }

  // TODO: placeBet(playerId, amount) – validiert und verbucht Einsätze,
  //       prüft ob die Wettrunde abgeschlossen ist (alle gleich eingesetzt oder gefoldet).
  // TODO: fold(playerId), check(playerId), call(playerId), raise(playerId, amount)

  showdown() {
    this._assertPhase('river');
    const activePlayers = this.players.filter((p) => !p.folded);
    const { winnerIndexes, results } = determineWinners(activePlayers, this.communityCards);
    const winners = winnerIndexes.map((i) => activePlayers[i]);
    const share = Math.floor(this.pot / winners.length);
    winners.forEach((w) => {
      w.chips += share;
    });
    this.phase = 'showdown';
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
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        folded: p.folded,
        isAllIn: p.isAllIn,
        holeCards: p.id === forPlayerId ? p.holeCards : null,
      })),
    };
  }
}

module.exports = { Table, PHASES };
