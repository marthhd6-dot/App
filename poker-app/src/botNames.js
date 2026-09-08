// src/botNames.js
// Namens-Pool für Auffüll-/Übungs-Bots. Statt eines Schemas wie "Gold-Bot 2"
// (das einen Bot sofort als solchen verrät) bekommt jeder Bot einen
// zufälligen, menschlich klingenden Nutzernamen aus diesem Pool – ähnlich
// dem, was auch ein echter Spieler beim Registrieren wählen würde. Reine
// Erfindungen, kein Bezug zu echten Personen.

const BOT_NAME_POOL = [
  'Nico92', 'LeaM', 'Deniz_T', 'PokerFuchs', 'Mia2001', 'JonasB', 'xLuca',
  'Selin99', 'Sturmvogel', 'AnnaW', 'Kevin_HH', 'Lilly23', 'MaxPower',
  'ElifY', 'Noah_B', 'Fiete', 'ZoeL', 'Rico84', 'Vanessa_K', 'Timo77',
  'Sophie_M', 'Ben_Q', 'Katharina', 'Yusuf19', 'Pia_K', 'Robin_S', 'Ida88',
  'Finn_K', 'Melina', 'David_R', 'Greta21', 'Paul_T', 'Hannah_L', 'Emre_D',
  'Charlotte9', 'Julian_F', 'Marlene', 'Tarek_B', 'Ronja', 'Fabian_K',
  'Amelie_S', 'Levi77', 'Nora_W', 'Simon_P', 'Ines88', 'Malte_H', 'Yara_B',
  'Jannik', 'Frieda_L', 'Cem_A', 'Lasse_N', 'Merle', 'Okan_Y', 'Wiebke',
  'Bjarne', 'Sila_T', 'Henrik99', 'Aylin', 'Dario_M', 'Tessa_L',
];

// Wählt `count` eindeutige Namen aus dem Pool (Fisher-Yates-Shuffle), ohne
// Namen aus `exclude` (z. B. die echten Spieler, die schon am Tisch sitzen –
// verhindert Verwirrung durch einen Bot mit demselben Namen). Reicht der
// Pool nach Ausschluss nicht aus (praktisch nie, da pro Tisch max. 3 Bots
// nötig sind), werden weitere Namen mit einer laufenden Nummer eindeutig
// gemacht statt die Funktion fehlschlagen zu lassen.
function pickBotNames(count, exclude = []) {
  const excludeSet = new Set(exclude);
  const shuffled = BOT_NAME_POOL.filter((n) => !excludeSet.has(n));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picked = shuffled.slice(0, count);
  while (picked.length < count) {
    const base = BOT_NAME_POOL[picked.length % BOT_NAME_POOL.length];
    picked.push(`${base}${picked.length + 1}`);
  }
  return picked;
}

module.exports = { BOT_NAME_POOL, pickBotNames };
