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
│   ├── persistence.js        # Lädt/speichert Raum-Snapshots + Ränge in SQLite
│   ├── ranking.js            # ELO-artige Rating-/Rang-Logik für 1v1v1v1 Ranked
│   ├── blinds.js              # Turnier-Blind-Zeitplan für Ranked-Matches
│   └── server.js             # Express + Socket.io Server, liefert public/ aus
├── data/                     # Gespeicherte Chip-Stände & Ränge (rooms.db, gitignored)
└── tests/
    ├── handEvaluator.test.js
    ├── table.test.js
    ├── rooms.test.js
    ├── persistence.test.js
    ├── ranking.test.js
    └── blinds.test.js
```

## Setup

```bash
cd poker-app
npm install
npm test        # prüft Hand-Evaluator, Tisch-, Raum-, Persistenz-, Rang- und Blind-Logik
npm start        # startet den Server auf Port 3001, Frontend unter http://localhost:3001

# Gnadenfrist fürs Reconnect-Handling überschreiben (Standard: 30000ms):
RECONNECT_GRACE_MS=10000 npm start

# Speicherort der Chip-Stände überschreiben (Standard: data/rooms.db):
POKER_DATA_FILE=/tmp/rooms.db npm start
```

## Deployment (Render)

Im Repo-Root liegt eine `render.yaml` ([Render Blueprint](https://render.com/docs/blueprint-spec)),
die einen Web-Service für `poker-app/` samt persistenter Disk für die
Chip-Stände definiert.

1. Repo zu GitHub pushen (bereits erledigt, falls du diesen Text liest).
2. Auf [render.com](https://render.com): **New → Blueprint** → das Repo
   auswählen. Render erkennt `render.yaml` automatisch und schlägt den
   Service `poker-app` vor.
3. Deployen. Die App läuft danach unter der von Render vergebenen URL
   (z. B. `https://poker-app-xxxx.onrender.com`) – dort direkt im Browser
   testen, Raum-Code an Mitspieler weitergeben.

**Wichtig zu wissen:**

- Persistente Disks (für `data/rooms.db`, damit Chip-Stände einen
  Neustart/Deploy überleben) gibt es bei Render erst ab dem
  **Starter-Plan** (kostenpflichtig), nicht im Free-Tier. `render.yaml`
  ist entsprechend auf `plan: starter` gesetzt.
- Zum reinen Ausprobieren reicht auch der Free-Tier: dazu in
  `render.yaml` den `disk`-Block entfernen und `plan: starter` auf `plan:
  free` ändern. Dann startet die App bei jedem Neustart mit leeren
  Tischen (kein persistenter Speicher), und der Service schläft nach
  15 Minuten Inaktivität ein (Cold Start beim nächsten Aufruf trennt
  alle laufenden Verbindungen).
- `NODE_VERSION=22` ist in `render.yaml` gesetzt, weil `better-sqlite3`
  Node ≥22 voraussetzt (siehe `package.json#engines`).
- Ohne Blueprint geht es auch manuell: **New → Web Service**, Root
  Directory `poker-app`, Build Command `npm ci`, Start Command
  `npm start`, dieselben Env-Vars wie oben von Hand setzen.

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
  Gewinner-Anzeige am Ende einer Hand. Optisch als ovaler Tisch mit
  Holz-Rail: Sitzplätze kreisförmig um den Tisch (eigener Platz immer
  unten in der Mitte), animiertes Karten-Austeilen, ein pulsierender
  Rahmen um den aktiven Spieler, Konfetti bei einem eigenen Sieg, und
  eine identische Optik für Ranked-Warteschlange und Bestenliste.
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
  Dealer-Position pro Raum werden nach jeder Aktion in einer SQLite-Datei
  gespeichert (via `better-sqlite3`, Standard: `data/rooms.db`,
  überschreibbar via `POKER_DATA_FILE`) und beim Serverstart wieder
  geladen. Jeder Speichervorgang läuft in einer Transaktion (alte Räume
  löschen, aktuelle neu einfügen), sodass ein Absturz mitten im
  Speichern nie einen halb geschriebenen Zustand hinterlässt. Eine
  laufende Hand (Karten, Einsätze, Phase) wird bewusst nicht gespeichert
  – nach einem Neustart sind alle wiederhergestellten Spieler als
  "disconnected" markiert und kommen über den normalen Reconnect-Weg
  (`join-room` mit demselben Namen) an ihren Platz zurück. Bei SIGINT/
  SIGTERM (z. B. Ctrl+C oder ein Deploy-Neustart) wird zusätzlich ein
  letztes Mal explizit gespeichert.
- **1v1v1v1 Ranked** (`ranking.js` + `blinds.js` + Matchmaking in
  `server.js`): Über `join-ranked-queue` reiht sich ein Spieler in eine
  Warteschlange ein. `findMatchmakingGroup()` sucht **Rating-basiert** eine
  Gruppe von `RANKED_GROUP_SIZE` (4) Spielern: bevorzugt wird immer der am
  längsten wartende Spieler, um den herum die drei Kandidaten mit dem
  ähnlichsten Rating gewählt werden. Die akzeptierte Rating-Spanne
  innerhalb der Gruppe wächst mit der Wartezeit (Start: 100 Punkte, +15 pro
  Sekunde), damit niemand unbegrenzt hängen bleibt, nur weil keine ähnlich
  bewerteten Mitspieler da sind – die Suche läuft bei jedem neuen Beitritt
  sofort und zusätzlich alle 2 Sekunden erneut. Gefundene Gruppen spielen
  zu viert an einem neuen Tisch mit demselben Startkapital wie ein Casual-
  Tisch (1000 Chips) – kein manueller Raum-Code nötig. Damit ein Match
  trotzdem in endlicher Zeit endet, steigen die Blinds turnierartig:
  `blindsForHandsPlayed()` startet bei 5/10 und verdoppelt sie alle 2
  Hände, gedeckelt bei 160/320. Scheidet ein Spieler nach einer Hand mit 0
  Chips aus, wird er vom Tisch entfernt und seine Bust-Reihenfolge
  gemerkt; das Match läuft mit den verbliebenen Spielern weiter. Sobald nur
  noch einer übrig ist, steht die Platzierung fest
  (Sieger zuerst, dann die Ausgeschiedenen in umgekehrter
  Bust-Reihenfolge). Aus der Platzierung ergeben sich alle sechs
  paarweisen 1v1-Duelle (`applyMultiwayMatchResult()`), jedes bewertet
  mit einem ELO-artigen System (K-Faktor 32, Startrating 250) – der
  Sieger gewinnt so gegen alle drei anderen, der Letzte verliert gegen
  alle drei. Sechs Ränge von **Bronze** bis **Champion** (Schwellenwerte
  in `RANK_TIERS`), Rating und Sieg/Niederlage-Zähler liegen dauerhaft in
  der `player_ranks`-Tabelle. Eine einfache Bestenliste
  (`get-leaderboard`) zeigt die Top 20 nach Rating. Identität ist wie
  beim Reconnect-Handling allein der Name, keine echte Authentifizierung.

## Mögliche nächste Schritte (für Claude Code)

Die ursprüngliche Roadmap ist komplett. Ideen, um weiterzubauen:

- **Postgres/Supabase statt lokaler SQLite-Datei**: sinnvoll, sobald die
  App auf mehreren Server-Prozessen/Maschinen laufen soll (SQLite ist
  an eine einzelne Datei auf einer Maschine gebunden).
- **Turnier-Modus**: Blinds automatisch nach einem Zeitplan erhöhen,
  Spieler mit 0 Chips aus dem Tisch nehmen.
- **Hand-Historie & Chat**: vergangene Hände und Nachrichten pro Raum
  anzeigen (SQLite ist dafür bereits vorhanden und würde sich anbieten).
- **Mobile-optimiertes UI**: Die Action-Bar und Karten-Reihen sind noch
  nicht für kleine Bildschirme optimiert.

## Guter erster Prompt für Claude Code

> "Lies dir ranking.js und server.js durch. Erweitere den Ranked-Modus um
> ein zweites Format mit 6 Spielern pro Tisch (analog zu
> RANKED_GROUP_SIZE), wählbar über einen zweiten Warteschlangen-Button im
> Frontend."
