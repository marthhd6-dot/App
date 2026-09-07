// src/ranking.js
// Rating- und Rang-Logik für den 1v1-Ranked-Modus. Reine Funktionen ohne
// Bezug zu Sockets oder der Datenbank, damit sie unabhängig testbar bleiben.
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
// Beitritts-Reihenfolge) das erste passende Paar. Bevorzugt dabei immer den
// am längsten wartenden Spieler (Index 0 zuerst) und wählt unter dessen
// akzeptablen Gegnern den mit dem ähnlichsten Rating. Gibt [indexA, indexB]
// zurück (indexA < indexB) oder null, wenn aktuell niemand zusammenpasst.
function findMatchmakingPair(queue, now = Date.now()) {
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let j = i + 1; j < queue.length; j++) {
      const b = queue[j];
      const diff = Math.abs(a.rating - b.rating);
      const tolerance = Math.max(matchTolerance(now - a.joinedAt), matchTolerance(now - b.joinedAt));
      if (diff <= tolerance && diff < bestDiff) {
        bestDiff = diff;
        bestIdx = j;
      }
    }
    if (bestIdx !== -1) return [i, bestIdx];
  }
  return null;
}

module.exports = {
  RANK_TIERS,
  STARTING_RATING,
  K_FACTOR,
  tierForRating,
  expectedScore,
  applyMatchResult,
  matchTolerance,
  findMatchmakingPair,
};
