# Poker-App — Startgerüst

Ein Grundgerüst für ein Online-Texas-Hold'em mit mehreren Spielern.
Die Kartenlogik ist fertig und getestet. Netzwerk-Sync und Wettrunden
sind als Skelett angelegt — das baust du mit Claude Code weiter aus.

## Struktur

```
poker-app/
├── package.json
├── src/
│   ├── game/
│   │   ├── deck.js           # Deck erzeugen, mischen, ziehen
│   │   ├── handEvaluator.js  # Beste 5-Karten-Hand aus 7 Karten finden
│   │   └── table.js          # Tisch-Zustand: Spieler, Phasen, Pot
│   └── server.js             # Express + Socket.io Server
└── tests/
    ├── handEvaluator.test.js
    └── table.test.js
```

## Setup

```bash
cd poker-app
npm install
npm test        # prüft den Hand-Evaluator
npm start        # startet den Server auf Port 3001
```

## Was schon funktioniert

- Deck erzeugen & fair mischen
- Beste Hand aus 2 Hole Cards + 5 Community Cards ermitteln
  (inkl. Splitpot-Erkennung, Ass-tief-Straße)
- Grundstruktur für einen Tisch mit mehreren Spielern
- **Wettrunden-Logik** in `table.js`: `placeBet`, `raise`, `call`, `check`,
  `fold`, inklusive Zugreihenfolge, Big-Blind-Option, Mindest-Raise,
  All-In-Behandlung und automatischem Rundenabschluss
- **Blinds werden automatisch eingezogen**, der Dealer-Button rückt nach
  jeder Hand weiter (inkl. Heads-up-Sonderregel)
- Sofortiger Gewinn durch Fold, wenn nur noch ein Spieler übrig ist
- Socket.io-Server, der Spieler verbinden, Karten austeilen und
  Wettrunden-Aktionen (`bet`, `raise`, `call`, `check`, `fold`) entgegennehmen
  kann, inklusive Validierung und automatischem Weiterschalten zu
  Flop/Turn/River/Showdown, sobald eine Wettrunde abgeschlossen ist

## Nächste Schritte (für Claude Code)

Am besten der Reihe nach, jeweils mit Tests:

1. **Mehrere Tische/Räume** statt nur einem globalen Tisch — Räume über
   einen Code beitreten lassen.
2. **Frontend** (React oder React Native): verbindet sich per Socket.io,
   zeigt Karten, Pot, Buttons für Aktionen.
3. **Persistenz**: Chip-Stände über Sessions hinweg speichern
   (z. B. mit einer Datenbank wie Postgres oder Supabase).
4. **Reconnect-Handling**: Was passiert, wenn ein Spieler mitten in
   der Hand die Verbindung verliert?
5. **Side Pots**: Aktuell gibt es nur einen gemeinsamen Pot; bei mehreren
   unterschiedlich hohen All-Ins wird (noch) nicht korrekt aufgeteilt.

## Guter erster Prompt für Claude Code

> "Lies dir server.js und table.js durch. Baue ein einfaches
> Web-Frontend, das sich per Socket.io verbindet, die Karten und den
> Pot anzeigt und Buttons für bet/raise/call/check/fold bereitstellt."
