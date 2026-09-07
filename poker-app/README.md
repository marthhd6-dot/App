# Poker-App — Startgerüst

Ein spielbares Online-Texas-Hold'em mit mehreren Spielern: Kartenlogik,
Wettrunden und ein einfaches Browser-Frontend sind fertig. Räume/mehrere
Tische, Persistenz und Reconnect-Handling sind offen — das baust du mit
Claude Code weiter aus.

## Struktur

```
poker-app/
├── package.json
├── public/                   # Statisches Browser-Frontend (kein Build-Schritt)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── src/
│   ├── game/
│   │   ├── deck.js           # Deck erzeugen, mischen, ziehen
│   │   ├── handEvaluator.js  # Beste 5-Karten-Hand aus 7 Karten finden
│   │   └── table.js          # Tisch-Zustand: Spieler, Phasen, Pot
│   └── server.js             # Express + Socket.io Server, liefert public/ aus
└── tests/
    ├── handEvaluator.test.js
    └── table.test.js
```

## Setup

```bash
cd poker-app
npm install
npm test        # prüft Hand-Evaluator und Tisch-Logik
npm start        # startet den Server auf Port 3001, Frontend unter http://localhost:3001
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
- **Browser-Frontend** (`public/`, reines HTML/CSS/JS ohne Build-Schritt):
  Beitreten, Hole Cards, Community Cards, Pot/Einsatz, wer am Zug ist,
  Aktions-Buttons (nur aktiv, wenn der Spieler dran ist und die Aktion
  gerade gültig ist) und die Gewinner-Anzeige am Ende einer Hand

## Nächste Schritte (für Claude Code)

Am besten der Reihe nach, jeweils mit Tests:

1. **Mehrere Tische/Räume** statt nur einem globalen Tisch — Räume über
   einen Code beitreten lassen.
2. **Persistenz**: Chip-Stände über Sessions hinweg speichern
   (z. B. mit einer Datenbank wie Postgres oder Supabase).
3. **Reconnect-Handling**: Was passiert, wenn ein Spieler mitten in
   der Hand die Verbindung verliert?
4. **Side Pots**: Aktuell gibt es nur einen gemeinsamen Pot; bei mehreren
   unterschiedlich hohen All-Ins wird (noch) nicht korrekt aufgeteilt.

## Guter erster Prompt für Claude Code

> "Lies dir server.js und table.js durch. Ergänze Räume/mehrere Tische:
> Spieler sollen über einen Raum-Code einem bestimmten Tisch statt nur
> dem einen globalen Tisch beitreten können."
