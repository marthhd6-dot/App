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

module.exports = { RANK_TIERS, STARTING_RATING, K_FACTOR, tierForRating, expectedScore, applyMatchResult };
