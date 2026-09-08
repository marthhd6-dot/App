// src/bots.js
// Entscheidungslogik für Bot-Gegner im "Gegen Bots"-Übungsmodus (siehe
// play-vs-bots in server.js). Reine Funktionen ohne Bezug zu Sockets, damit
// sie unabhängig testbar bleiben (wie ranking.js).
//
// Kein echtes maschinelles Lernen oder vollständige Equity-Berechnung
// (kein Monte-Carlo gegen unbekannte Gegnerhände) – stattdessen eine
// einfache, klar nachvollziehbare Heuristik, deren Parameter pro Rang-Stufe
// (siehe RANK_TIERS in ranking.js) unterschiedlich stark "diszipliniert"
// spielen: höhere Ränge machen seltener Fehler, verlangen einen größeren
// Sicherheitsabstand zwischen Handstärke und Pot-Odds, bevor sie Chips
// riskieren, und setzen/erhöhen gezielter statt nur mitzugehen.

const { bestHand } = require('./game/handEvaluator');
const { RANK_TIERS } = require('./ranking');

// Pro Rang-Stufe:
// - mistakeRate: Wahrscheinlichkeit, dass der Bot statt der berechneten
//   Aktion eine simple Zufallsentscheidung trifft (folden oder callen bzw.
//   checken) – simuliert unerfahrenes, inkonsequentes Spiel.
// - tightness: wie viel Sicherheitsabstand über den reinen Pot-Odds der
//   Bot verlangt, bevor er einen Einsatz mitgeht (siehe requiredCallStrength).
//   Niedrig = callt zu großzügig ("Calling Station", typisch für schwache
//   Spieler), hoch = diszipliniertes Folden bei knappen Spots.
// - aggression: wie oft eine starke Hand tatsächlich zu einem Bet/Raise
//   statt nur zu Call/Check führt.
// - bluffRate: Wahrscheinlichkeit, trotz schwacher Hand weiterzuspielen
//   bzw. selbst zu erhöhen.
const BOT_PROFILES = {
  Bronze: { mistakeRate: 0.35, tightness: 0.12, aggression: 0.15, bluffRate: 0.03 },
  Silber: { mistakeRate: 0.22, tightness: 0.2, aggression: 0.25, bluffRate: 0.06 },
  Gold: { mistakeRate: 0.12, tightness: 0.28, aggression: 0.35, bluffRate: 0.09 },
  Platin: { mistakeRate: 0.06, tightness: 0.34, aggression: 0.45, bluffRate: 0.12 },
  Diamant: { mistakeRate: 0.02, tightness: 0.4, aggression: 0.55, bluffRate: 0.16 },
  Champion: { mistakeRate: 0, tightness: 0.46, aggression: 0.65, bluffRate: 0.2 },
};

const BOT_TIER_NAMES = RANK_TIERS.map((t) => t.name);

function isBotTier(name) {
  return Object.prototype.hasOwnProperty.call(BOT_PROFILES, name);
}

// Grobe Preflop-Handstärke (0..1) ohne Community Cards: hohe Karten, Paare,
// Suited- und Connector-Boni – angelehnt an einfache Preflop-Charts, aber
// bewusst kein vollständiges Ranking aller 169 Starthände.
function preflopStrength(holeCards) {
  const [a, b] = holeCards;
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  let score = (hi + lo - 4) / 24; // 2+2=4 -> 0, 14+14=28 -> 1
  if (a.rank === b.rank) score += 0.22;
  if (a.suit === b.suit) score += 0.07;
  const gap = hi - lo;
  if (gap === 1) score += 0.05;
  else if (gap === 2) score += 0.02;
  return Math.max(0, Math.min(1, score));
}

// Postflop-Handstärke (0..1): nutzt die tatsächliche beste 5-Karten-Hand
// (siehe bestHand() in handEvaluator.js) und bildet deren Rang (0 High Card
// .. 9 Royal Flush) linear auf 0..1 ab. Vereinfachung: berücksichtigt keine
// Draws/Outs, nur die aktuell fertige Hand.
function handStrength(holeCards, communityCards) {
  if (communityCards.length === 0) return preflopStrength(holeCards);
  const evaluated = bestHand(holeCards, communityCards);
  return Math.min(1, (evaluated.rank + 0.5) / 9);
}

// Ab welcher Handstärke der Bot einen Einsatz mitgeht, gegeben die reinen
// Pot-Odds (owed / (pot + owed)) und die tightness der Rang-Stufe: bei
// tightness 0 reicht genau der mathematische Break-even, bei tightness 1
// wird praktisch nie gecallt. Als eigene, pure Funktion exportiert, damit
// sich die Rang-Abstufung ohne echte Karten testen lässt.
function requiredCallStrength(potOdds, tierName) {
  const profile = BOT_PROFILES[tierName] || BOT_PROFILES.Bronze;
  return potOdds + profile.tightness * (1 - potOdds);
}

// Setzt eine Eröffnungs-Wette (aktueller Einsatz ist 0). Zielgröße ~60 % des
// Pots, mindestens der Big Blind, gedeckelt vom eigenen Stack (All-in, falls
// der Stack kleiner als die Zielgröße ist).
function computeBetAmount(table, player) {
  const target = Math.round(Math.max(table.bigBlind, table.pot * 0.6));
  const amount = Math.min(target, player.chips);
  return { type: 'bet', amount };
}

// Erhöht einen bestehenden Einsatz. Gibt null zurück, wenn der Bot nach dem
// Call keine Chips mehr für einen sinnvollen Raise übrig hätte – der
// Aufrufer callt dann stattdessen (siehe decideBotAction).
function computeRaiseAmount(table, player) {
  const owed = table.currentBet - player.bet;
  if (player.chips <= owed) return null;

  const raiseSize = Math.max(table.minRaise, Math.round(table.pot * 0.6));
  const totalAmount = Math.min(table.currentBet + raiseSize, player.bet + player.chips);
  return { type: 'raise', amount: totalAmount };
}

// Wählt eine legale Aktion für den Bot mit der Spieler-ID botId. rng ist
// injizierbar (Standard Math.random), damit Tests deterministisch bleiben.
// Gibt immer eine an der aktuellen Tisch-Situation legale Aktion zurück
// ({ type: 'fold' | 'check' | 'call' } oder { type: 'bet' | 'raise', amount }).
function decideBotAction(table, botId, tierName, rng = Math.random) {
  const profile = BOT_PROFILES[tierName] || BOT_PROFILES.Bronze;
  const player = table.players.find((p) => p.id === botId);
  if (!player) {
    throw new Error(`Bot ${botId} sitzt nicht an diesem Tisch.`);
  }

  const owed = table.currentBet - player.bet;

  // "Fehler"-Chance: eine einfache, aber legale Alternative statt der
  // berechneten Aktion – lässt schwächere Ränge realistisch inkonsequent
  // wirken, ohne die restliche Logik zu verkomplizieren.
  if (rng() < profile.mistakeRate) {
    if (owed > 0) return rng() < 0.5 ? { type: 'fold' } : { type: 'call' };
    return { type: 'check' };
  }

  const strength = handStrength(player.holeCards, table.communityCards);
  const wantsToBluff = rng() < profile.bluffRate;
  const wantsToRaise = rng() < profile.aggression && strength > 0.55 + (1 - profile.aggression) * 0.3;

  if (owed > 0) {
    const potOdds = owed / (table.pot + owed);
    const willingToContinue = strength >= requiredCallStrength(potOdds, tierName) || strength > 0.7;
    if (!willingToContinue && !wantsToBluff) {
      return { type: 'fold' };
    }
    if ((wantsToRaise || wantsToBluff) && player.chips > owed) {
      const raiseAction = computeRaiseAmount(table, player);
      if (raiseAction) return raiseAction;
    }
    return { type: 'call' };
  }

  if ((wantsToRaise || wantsToBluff) && player.chips > 0) {
    if (table.currentBet === 0) {
      return computeBetAmount(table, player);
    }
    // owed ist 0, aber currentBet nicht (Big-Blind-Option preflop: die
    // eigene Bet entspricht bereits dem aktuellen Einsatz) – hier ist nur
    // ein raise() gültig, kein neuer placeBet().
    const raiseAction = computeRaiseAmount(table, player);
    if (raiseAction) return raiseAction;
  }
  return { type: 'check' };
}

module.exports = {
  BOT_PROFILES,
  BOT_TIER_NAMES,
  isBotTier,
  preflopStrength,
  handStrength,
  requiredCallStrength,
  decideBotAction,
};
