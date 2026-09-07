# Poker-App — Startgerüst

Ein spielbares Online-Texas-Hold'em mit mehreren Spielern und mehreren
gleichzeitigen Tischen: Kartenlogik, Wettrunden, Räume, Reconnect-Handling
und ein einfaches Browser-Frontend sind fertig. Persistenz und Side Pots
sind offen — das baust du mit Claude Code weiter aus.

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
│   ├── rooms.js              # Verwaltet mehrere Tische über Raum-Codes
│   └── server.js             # Express + Socket.io Server, liefert public/ aus
└── tests/
    ├── handEvaluator.test.js
    ├── table.test.js
    └── rooms.test.js
```

## Setup

```bash
cd poker-app
npm install
npm test        # prüft Hand-Evaluator, Tisch-Logik und Raum-Verwaltung
npm start        # startet den Server auf Port 3001, Frontend unter http://localhost:3001

# Gnadenfrist fürs Reconnect-Handling überschreiben (Standard: 30000ms):
RECONNECT_GRACE_MS=10000 npm start
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
  neuen Tisch erstellen oder per Code beitreten, Hole Cards, Community
  Cards, Pot/Einsatz, wer am Zug ist, Aktions-Buttons (nur aktiv, wenn der
  Spieler dran ist und die Aktion gerade gültig ist) und die
  Gewinner-Anzeige am Ende einer Hand
- **Mehrere Tische/Räume** (`rooms.js`): `create-room` legt einen neuen
  Tisch mit 4-stelligem Code an, `join-room` tritt einem bestehenden Raum
  bei. Jeder Raum hat einen komplett unabhängigen Tisch-Zustand; ein
  Socket kann nur einem Raum gleichzeitig angehören. Leere Räume werden
  beim Verlassen des letzten Spielers automatisch aufgeräumt.
- **Reconnect-Handling**: Trennt sich ein Spieler (Netzwerk-Aussetzer,
  Tab neu geladen), bleibt er 30 Sekunden lang mit Chips, Karten und
  Sitzplatz am Tisch ("disconnected"-Badge für die anderen). Tritt er
  innerhalb dieser Frist mit demselben Namen demselben Raum erneut bei
  (`table.reconnectPlayer()`), bekommt er seinen Platz zurück. Das
  Frontend merkt sich Raum-Code und Namen in `sessionStorage` und tritt
  nach einem Verbindungsabbruch automatisch wieder bei. Bekannte
  Vereinfachung: Die Wiedererkennung läuft allein über den Namen, es gibt
  keine echte Authentifizierung – zwei Spieler mit demselben Namen im
  selben Raum können sich gegenseitig den Platz "stehlen".

## Nächste Schritte (für Claude Code)

Am besten der Reihe nach, jeweils mit Tests:

1. **Persistenz**: Chip-Stände über Sessions hinweg speichern
   (z. B. mit einer Datenbank wie Postgres oder Supabase).
2. **Side Pots**: Aktuell gibt es nur einen gemeinsamen Pot; bei mehreren
   unterschiedlich hohen All-Ins wird (noch) nicht korrekt aufgeteilt.

## Guter erster Prompt für Claude Code

> "Lies dir table.js und handEvaluator.js durch. Implementiere Side
> Pots: Wenn mehrere Spieler mit unterschiedlich hohen Stacks all-in
> gehen, muss der Pot in Haupt- und Neben-Pots aufgeteilt werden, auf
> die jeweils nur die Spieler Anspruch haben, die genug Chips eingesetzt
> haben, um dabei zu sein."
