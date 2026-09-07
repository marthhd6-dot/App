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
    └── handEvaluator.test.js
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
- Socket.io-Server, der Spieler verbinden und Karten austeilen kann

## Nächste Schritte (für Claude Code)

Am besten der Reihe nach, jeweils mit Tests:

1. **Wettrunden-Logik** in `table.js`: `placeBet`, `fold`, `check`, `call`,
   `raise`. Muss verfolgen, wer schon dran war und ob die Runde
   abgeschlossen ist (alle haben gleich viel gesetzt oder gefoldet).
2. **Blinds automatisch einziehen** in `startHand()` und den Dealer-Button
   nach jeder Hand weiterrücken lassen.
3. **Server-Events** für die neuen Aktionen ergänzen (`src/server.js`),
   inklusive Validierung (ist der Spieler überhaupt dran?).
4. **Mehrere Tische/Räume** statt nur einem globalen Tisch — Räume über
   einen Code beitreten lassen.
5. **Frontend** (React oder React Native): verbindet sich per Socket.io,
   zeigt Karten, Pot, Buttons für Aktionen.
6. **Persistenz**: Chip-Stände über Sessions hinweg speichern
   (z. B. mit einer Datenbank wie Postgres oder Supabase).
7. **Reconnect-Handling**: Was passiert, wenn ein Spieler mitten in
   der Hand die Verbindung verliert?

## Guter erster Prompt für Claude Code

> "Lies dir table.js und server.js durch. Implementiere die
> Wettrunden-Logik (placeBet, fold, check, call, raise) inklusive
> Tests, die prüfen, wann eine Wettrunde abgeschlossen ist."
