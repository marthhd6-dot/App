// src/ranking.js
// Rating- und Rang-Logik für den Ranked-Modus (4 Spieler pro Tisch, siehe
// RANKED_GROUP_SIZE in server.js). Reine Funktionen ohne Bezug zu Sockets
// oder der Datenbank, damit sie unabhängig testbar bleiben.
//
// Bekannte Vereinfachung: Die Spieler-Identität ist allein der Name (wie
// beim Reconnect-Handling) – es gibt keine echte Authentifizierung. Zwei
// Spieler mit demselben Namen teilen sich denselben Rang.

const RANK_TIERS = [
  { name: 'Bronze', min: 0 },
  { name: 'Silber', min: 500 },
  { name: 'Gold', min: 1000 },
  { name: 'Platin', min: 1500 },
  { name: 'Diamant', min: 2000 },
  { name: 'Champion', min: 2500 },
];

const STARTING_RATING = 250; // liegt fest in der Bronze-Spanne
const K_FACTOR = 32; // Standard-Wert, wie im Schach-ELO gebräuchlich

function tierForRating(rating) {
  let tier = RANK_TIERS[0];
  for (const t of RANK_TIERS) {
    if (rating >= t.min) tier = t;
  }
  return tier.name;
}

// Erwarteter Punktgewinn von A gegen B (zwischen 0 und 1), Standard-ELO-Formel.
function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// Aktualisiert beide Ratings nach einem 1v1-Match. Rating fällt nie unter 0.
function applyMatchResult(winnerRating, loserRating) {
  const expectedWinner = expectedScore(winnerRating, loserRating);
  const expectedLoser = 1 - expectedWinner;
  return {
    winnerRating: Math.max(0, Math.round(winnerRating + K_FACTOR * (1 - expectedWinner))),
    loserRating: Math.max(0, Math.round(loserRating + K_FACTOR * (0 - expectedLoser))),
  };
}

// Wie weit die Ratings zweier Spieler auseinanderliegen dürfen, damit das
// Matchmaking sie zusammenlegt. Wächst mit der Wartezeit, damit niemand
// unbegrenzt in der Warteschlange hängen bleibt, nur weil kein ähnlich
// bewerteter Gegner da ist.
const MATCH_TOLERANCE_BASE = 100;
const MATCH_TOLERANCE_GROWTH_PER_SEC = 15;

function matchTolerance(waitedMs) {
  return MATCH_TOLERANCE_BASE + (Math.max(0, waitedMs) / 1000) * MATCH_TOLERANCE_GROWTH_PER_SEC;
}

// Sucht in einer Warteschlange (Array aus { rating, joinedAt }, in
// Beitritts-Reihenfolge) die erste passende Gruppe der Größe groupSize.
// Bevorzugt dabei immer den am längsten wartenden Spieler (Index 0 zuerst)
// und füllt seine Gruppe mit den (groupSize - 1) Spielern auf, deren Rating
// am nächsten an seinem liegt (einfache Heuristik, kein optimales
// Fenster-Matching – für eine kleine Warteschlange aber ausreichend genau).
// Passt die Gruppe nur, wenn die Spanne (höchstes minus niedrigstes Rating
// in der Gruppe) innerhalb der Toleranz aller Beteiligten liegt. Gibt ein
// aufsteigend sortiertes Array von Indizes zurück, oder null, wenn aktuell
// keine Gruppe zusammenpasst.
function findMatchmakingGroup(queue, groupSize, now = Date.now()) {
  if (groupSize < 2 || queue.length < groupSize) return null;

  for (let i = 0; i < queue.length; i++) {
    const anchor = queue[i];
    const others = [];
    for (let j = 0; j < queue.length; j++) {
      if (j === i) continue;
      others.push({ idx: j, diff: Math.abs(queue[j].rating - anchor.rating) });
    }
    if (others.length < groupSize - 1) continue;

    others.sort((a, b) => a.diff - b.diff);
    const chosenIdx = [i, ...others.slice(0, groupSize - 1).map((c) => c.idx)];
    const chosenEntries = chosenIdx.map((idx) => queue[idx]);

    const ratings = chosenEntries.map((e) => e.rating);
    const spread = Math.max(...ratings) - Math.min(...ratings);
    const tolerance = Math.max(...chosenEntries.map((e) => matchTolerance(now - e.joinedAt)));

    if (spread <= tolerance) {
      return chosenIdx.sort((a, b) => a - b);
    }
  }
  return null;
}

// Berechnet aus einer Platzierungsliste (bester Platz zuerst) alle
// paarweisen Match-Ergebnisse: jeder Spieler gilt als Sieger gegen jeden
// schlechter Platzierten (ein 4-Spieler-Match zählt so als 6 einzelne
// 1v1-Duelle). Nützlich für Ranked-Tische mit mehr als zwei Spielern, ohne
// applyMatchResult() selbst anfassen zu müssen.
// ratings: { [name]: aktuelles Rating vor dem Match }.
// Gibt { [name]: { rating, wins, losses } } zurück – wins/losses sind die
// Anzahl gewonnener/verlorener paarweiser Duelle in diesem einen Match.
function applyMultiwayMatchResult(placements, ratings) {
  const result = {};
  placements.forEach((name) => {
    result[name] = { rating: ratings[name], wins: 0, losses: 0 };
  });

  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const winnerName = placements[i];
      const loserName = placements[j];
      const { winnerRating, loserRating } = applyMatchResult(result[winnerName].rating, result[loserName].rating);
      result[winnerName].rating = winnerRating;
      result[winnerName].wins += 1;
      result[loserName].rating = loserRating;
      result[loserName].losses += 1;
    }
  }
  return result;
}

module.exports = {
  RANK_TIERS,
  STARTING_RATING,
  K_FACTOR,
  tierForRating,
  expectedScore,
  applyMatchResult,
  matchTolerance,
  findMatchmakingGroup,
  applyMultiwayMatchResult,
};
