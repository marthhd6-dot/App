// src/game/abilities.js
// Fähigkeiten-System: Zu Beginn jeder Hand bekommt jeder Spieler in jedem
// Modus (Ranked wie Casual, 1v1v1v1 wie 2v2, auch gegen Bots) eine
// Fähigkeit aus jeder der vier Kategorien zugeteilt – einmal Karten, einmal
// Wette/Pot, einmal Info/Gegner, einmal Ressourcen. Jede Fähigkeit ist pro
// Hand genau einmal einsetzbar (siehe Table.useAbility() in table.js).
//
// Da jeder Spieler exakt dieselben vier Kategorien bekommt (aktuell mit
// genau einer Fähigkeit pro Kategorie), bleibt das Matchmaking/Rating in
// Ranked fair – niemand hat einen strukturellen Vorteil, es kommt nur mehr
// taktische Abwechslung dazu. ABILITIES_BY_CATEGORY ist bewusst so gebaut,
// dass sich eine Kategorie später leicht um weitere Fähigkeiten erweitern
// ließe (dann zufällige Auswahl statt der aktuell einzigen Option je
// Kategorie), ohne assignAbilities() oder die Aufrufer anpassen zu müssen.

const CATEGORIES = ['cards', 'pot', 'intel', 'resource'];

// Chip-Boost: sofortiger Chip-Bonus in Höhe dieses Anteils der aktuellen
// eigenen Chips (vom "System" gutgeschrieben, nicht von anderen Spielern
// abgezogen).
const ABILITY_CHIP_BOOST_RATE = 0.1;
// Pot-Bonus: Bonus-Anteil auf den eigenen Gewinn-Anteil dieser Hand, falls
// die Fähigkeit vor dem Hand-Ende aktiviert wurde (siehe
// Table._applyPotBonusIfActive()).
const ABILITY_POT_BONUS_RATE = 0.2;

// Der Katalog führt bewusst kein Feld für die Darstellung. Früher stand
// hier je ein Emoji, das der Server bis in die Seite durchgereicht hat.
// Welches Bild eine Fähigkeit bekommt, entscheidet jetzt allein das
// Frontend anhand der id (siehe ABILITY_SYMBOLS in public/app.js).
const ABILITIES = {
  cardSwap: {
    id: 'cardSwap',
    category: 'cards',
    name: 'Kartentausch',
    description: 'Tausche eine deiner Hole Cards gegen eine neue, zufällige Karte vom Deck.',
  },
  potBonus: {
    id: 'potBonus',
    category: 'pot',
    name: 'Pot-Bonus',
    description: `Gewinnst du diese Hand, erhältst du zusätzlich ${Math.round(
      ABILITY_POT_BONUS_RATE * 100
    )}% Bonus-Chips obendrauf.`,
  },
  spy: {
    id: 'spy',
    category: 'intel',
    name: 'Spionage',
    description: 'Deckt eine zufällige Hole Card eines zufälligen Gegners auf – nur für dich sichtbar.',
  },
  chipBoost: {
    id: 'chipBoost',
    category: 'resource',
    name: 'Chip-Boost',
    description: `Erhalte sofort ${Math.round(ABILITY_CHIP_BOOST_RATE * 100)}% deiner aktuellen Chips als Bonus.`,
  },
};

const ABILITIES_BY_CATEGORY = CATEGORIES.reduce((acc, category) => {
  acc[category] = Object.values(ABILITIES).find((a) => a.category === category);
  return acc;
}, {});

// Weist einem Spieler zu Beginn einer Hand für jede der vier Kategorien
// einen frischen, ungenutzten Fähigkeits-Slot zu: { [category]: { id, used,
// active } }. "active" wird nur von Fähigkeiten genutzt, deren Wirkung erst
// später (z. B. beim Hand-Ende) eintritt, siehe potBonus.
function assignAbilities() {
  const assigned = {};
  for (const category of CATEGORIES) {
    assigned[category] = { id: ABILITIES_BY_CATEGORY[category].id, used: false, active: false };
  }
  return assigned;
}

// Baut aus den rohen Slots eines Spielers (assignAbilities()) die für den
// Client bestimmte Sicht: jeder Slot ergänzt um Name/Icon/Beschreibung aus
// dem Katalog, damit das Frontend keine eigene Kopie der Fähigkeits-Texte
// pflegen muss. Gibt null zurück, solange der Spieler noch keine Hand
// mitgespielt hat (abilities noch nicht zugewiesen).
function describeAbilitiesForClient(abilities) {
  if (!abilities) return null;
  return CATEGORIES.map((category) => {
    const slot = abilities[category];
    const meta = ABILITIES[slot.id];
    return {
      category,
      id: slot.id,
      name: meta.name,
      description: meta.description,
      used: slot.used,
    };
  });
}

module.exports = {
  CATEGORIES,
  ABILITIES,
  ABILITY_CHIP_BOOST_RATE,
  ABILITY_POT_BONUS_RATE,
  assignAbilities,
  describeAbilitiesForClient,
};
