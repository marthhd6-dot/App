# Poker-App — Startgerüst

Ein spielbares Online-Texas-Hold'em mit mehreren Spielern und mehreren
gleichzeitigen Tischen: Kartenlogik (inkl. Side Pots), Wettrunden, Räume,
Reconnect-Handling, Persistenz und ein einfaches Browser-Frontend sind
fertig. Ideen für mögliche nächste Schritte stehen unten — das baust du
mit Claude Code weiter aus.

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
│   ├── persistence.js        # Lädt/speichert Raum-Snapshots als JSON-Datei
│   └── server.js             # Express + Socket.io Server, liefert public/ aus
├── data/                     # Gespeicherte Chip-Stände (rooms.json, gitignored)
└── tests/
    ├── handEvaluator.test.js
    ├── table.test.js
    ├── rooms.test.js
    └── persistence.test.js
```

## Setup

```bash
cd poker-app
npm install
npm test        # prüft Hand-Evaluator, Tisch-, Raum- und Persistenz-Logik
npm start        # startet den Server auf Port 3001, Frontend unter http://localhost:3001

# Gnadenfrist fürs Reconnect-Handling überschreiben (Standard: 30000ms):
RECONNECT_GRACE_MS=10000 npm start

# Speicherort der Chip-Stände überschreiben (Standard: data/rooms.json):
POKER_DATA_FILE=/tmp/rooms.json npm start
```

## Was schon funktioniert

- Deck erzeugen & fair mischen
- Beste Hand aus 2 Hole Cards + 5 Community Cards ermitteln
  (inkl. Splitpot-Erkennung, Ass-tief-Straße)
- Grundstruktur für einen Tisch mit mehreren Spielern
- **Wettrunden-Logik** in `table.js`: `placeBet`, `raise`, `call`, `check`,
  `fold`, inklusive Zugreihenfolge, Big-Blind-Option, Mindest-Raise,
  All-In-Behandlung und automatischem Rundenabschluss
- **Side Pots**: Sind mehrere Spieler mit unterschiedlich hohen Stacks
  all-in, teilt `Table._computePots()` den Pot beim Showdown korrekt in
  Haupt- und Neben-Pots auf – jeder Layer ist nur unter den Spielern zu
  gewinnen, die genug eingesetzt haben, um dafür infrage zu kommen.
  Gefoldete Spieler finanzieren die Pots weiter mit, können sie aber
  nicht mehr gewinnen. Verlässt nur noch ein Spieler das Feld durch
  Fold, gewinnt er weiterhin sofort den kompletten Pot ohne Showdown.
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
- **Persistenz** (`persistence.js`): Name, Chips, Blinds und
  Dealer-Position pro Raum werden nach jeder Aktion als JSON-Datei
  gespeichert (Standard: `data/rooms.json`, überschreibbar via
  `POKER_DATA_FILE`) und beim Serverstart wieder geladen. Eine laufende
  Hand (Karten, Einsätze, Phase) wird bewusst nicht gespeichert – nach
  einem Neustart sind alle wiederhergestellten Spieler als
  "disconnected" markiert und kommen über den normalen Reconnect-Weg
  (`join-room` mit demselben Namen) an ihren Platz zurück. Bei SIGINT/
  SIGTERM (z. B. Ctrl+C oder ein Deploy-Neustart) wird zusätzlich ein
  letztes Mal explizit gespeichert.

## Mögliche nächste Schritte (für Claude Code)

Die ursprüngliche Roadmap ist komplett. Ideen, um weiterzubauen:

- **Echte Datenbank statt JSON-Datei**: `persistence.js` schreibt
  aktuell synchron auf eine einzelne Datei – kein Problem für einen
  Heim-Tisch, aber ohne Nebenläufigkeitsschutz oder Historie. Für mehr
  Robustheit z. B. auf SQLite oder Postgres umstellen.
- **Turnier-Modus**: Blinds automatisch nach einem Zeitplan erhöhen,
  Spieler mit 0 Chips aus dem Tisch nehmen.
- **Hand-Historie & Chat**: vergangene Hände und Nachrichten pro Raum
  anzeigen.
- **Mobile-optimiertes UI**: Die Action-Bar und Karten-Reihen sind noch
  nicht für kleine Bildschirme optimiert.

## Guter erster Prompt für Claude Code

> "Lies dir persistence.js und rooms.js durch. Wie robust ist die
> aktuelle JSON-Datei-Persistenz bei mehreren gleichzeitigen Schreib-
> zugriffen? Schlage vor, wie man das auf SQLite umstellen könnte, ohne
> die restliche App-Logik anzufassen."
