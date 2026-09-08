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
- **1v1v1v1 Casual** (Matchmaking in `server.js`, Warteschlange über
  `join-casual-queue`): dieselbe Idee wie Ranked – automatisch zu viert
  an einem neuen Tisch zusammenfinden, ohne Raum-Code zu teilen –, aber
  ohne jeden Rating-Bezug. Die Warteschlange ist reines FIFO: sobald vier
  Spieler warten, spielen die ersten vier zusammen (kein
  Toleranz-Fenster nötig, da kein Rating verglichen wird). Fester
  Tisch wie ein normaler Casual-Tisch (1000 Chips, feste Blinds 5/10,
  kein Turnier-Zeitplan). Wie beim Ranked-Modus endet das Match, sobald
  nur noch ein Spieler Chips übrig hat, und alle werden nach
  Bust-Reihenfolge platziert (`casual-match-over`-Event mit `place`/
  `totalPlayers`) – nur eben ohne jede Auswirkung auf Rang oder
  Bestenliste. Die gemeinsame Bust-Erkennung für beide 4-Spieler-Modi
  steckt in `trackEliminations()`.
- **2v2 Ranked & 2v2 Casual** (Matchmaking in `server.js`, Warteschlangen
  über `join-ranked-team-queue`/`join-casual-team-queue`): dieselben vier
  Spieler wie bei 1v1v1v1, aber in zwei Teams à zwei Spieler aufgeteilt.
  Bei Ranked sucht `findMatchmakingGroup()` wie gewohnt vier ratingmäßig
  ähnliche Spieler, `balanceIntoTeams()` teilt sie danach in zwei möglichst
  ausgeglichene Teams (stärkster + schwächster gegen die beiden mittleren –
  minimiert die Differenz der Team-Rating-Summen); bei Casual ist es wieder
  reines FIFO. Ein Match endet, sobald ein ganzes Team ausgeschieden ist
  (`trackTeamEliminations()` – Bust-Erkennung analog zu
  `trackEliminations()`, aber pro Team statt pro Spieler). Bei Ranked
  werden die Ratings danach teambasiert aktualisiert: jedes Mitglied des
  Sieger-Teams gilt als Sieger gegen jedes Mitglied des Verlierer-Teams,
  also vier einzelne 1v1-Duelle (`applyTeamMatchResult()` in `ranking.js`)
  – Teamkollegen werden nie gegeneinander gewertet. Bei 2v2 Casual sieht
  jeder Spieler zusätzlich die Hole Cards seines Teammitglieds (nicht bei
  Ranked): `table.getPublicState(forPlayerId, extraVisibleIds)` nimmt dafür
  eine Liste weiterer Spieler-IDs entgegen, deren Karten ebenfalls sichtbar
  sein sollen, befüllt von `broadcastRoomState()` anhand der Team-Zuordnung
  des jeweiligen Casual-2v2-Raums.
- **Freundesliste** (`public/app.js` + Präsenz in `server.js`): Die Liste
  selbst (nur Namen) liegt rein im `localStorage` des Browsers – Freunde
  sind unabhängig davon, ob einer der beiden einen Account hat (s. u.).
  Der Server merkt sich, welcher Name gerade online ist (`onlineByName`,
  befüllt über `markOnline()` bei jedem Betreten eines Raums/einer
  Warteschlange sowie über `set-name`, sobald ein Name auf dem
  Startbildschirm eingegeben wird). Ein Client fragt mit
  `get-friends-status` (Namen aus seiner lokalen Liste) ab, welche davon
  online sind, und kann einen Online-Freund mit `invite-friend` direkt in
  den eigenen aktuellen Raum einladen – der Empfänger bekommt `friend-invite`
  (Absendername + Raum-Code) und kann per Klick sofort beitreten, auch ohne
  vorher selbst in einem Raum gewesen zu sein.
- **Accounts** (optional; `users`-Tabelle in `persistence.js`, Handler in
  `server.js`): Ohne Account bleibt der Name weiterhin frei wählbar wie
  überall sonst in dieser App (keine echte Authentifizierung). Wer sich
  registriert (`register-account`) oder anmeldet (`login-account`), schützt
  seinen Namen mit einem Passwort – gespeichert wird dabei nie das
  Passwort selbst, sondern nur `crypto.scrypt(password, salt)` (Node-
  Bordmittel) plus ein zufälliger Salt pro Account, verglichen beim Login
  zeitkonstant über `crypto.timingSafeEqual`. Nutzernamen sind
  case-insensitive eindeutig. Ein eingeloggter Socket bekommt
  `socket.data.authenticatedUsername` gesetzt; `resolveName()` überschreibt
  danach bei **jedem** Event, das einen Namen entgegennimmt (Raum
  erstellen/beitreten, alle vier Warteschlangen, `set-name`), einen vom
  Client mitgeschickten Namen mit dem Account-Namen – das gilt serverseitig,
  nicht nur im UI, ein manipulierter Client kann den Namen also nicht
  umgehen. Angemeldet bleiben: `login-account`/`register-account` erzeugen
  ein zufälliges Session-Token (`sessionTokens`, nur im Server-Speicher –
  überlebt keinen Neustart), das der Client in `localStorage` ablegt und
  bei jedem neuen Verbindungsaufbau erneut schickt (`login-with-token`), um
  automatisch angemeldet zu bleiben.
- **„Mein Rang"-Pfad** (`public/app.js`, Button auf dem Startbildschirm):
  zeigt alle sechs Ränge (Bronze bis Champion) als Pfad, hebt den
  aktuellen Rang optisch hervor (Glow-Ring, noch nicht erreichte Ränge
  ausgegraut) und zeigt einen Fortschrittsbalken bis zum nächsten Rang.
  Die Schwellenwerte (`RANK_TIERS`) kommen dafür im `rank-info`-Event vom
  Server mit, damit das Frontend sie nicht separat duplizieren muss.
- **Gegen Bots üben** (`bots.js`, Handler `play-vs-bots` in `server.js`):
  startet sofort (kein Matchmaking/Warteschlange) einen eigenen Raum mit
  1-3 Bot-Gegnern einer wählbaren Rang-Stufe (Bronze bis Champion,
  dieselben Namen wie im Rang-Pfad). Bots haben keinen echten Socket – ihre
  Züge kommen aus `decideBotAction()`, das nach jeder menschlichen (und
  jeder eigenen) Aktion automatisch nachgezogen wird
  (`maybeTriggerBotActions()`), solange der aktuell Handelnde ein Bot ist.
  Kein echtes maschinelles Lernen oder vollständige Equity-Berechnung,
  sondern eine einfache Heuristik aus vier Parametern pro Rang-Stufe:
  `mistakeRate` (Zufallsentscheidung statt der berechneten Aktion),
  `tightness` (Sicherheitsabstand zwischen Handstärke und den tatsächlichen
  Pot-Odds, bevor der Bot mitgeht – niedrig bei Bronze, also eher eine
  "Calling Station", hoch bei Champion, also diszipliniertes Folden),
  `aggression` (wie oft eine starke Hand zu einem Bet/Raise statt nur
  Call/Check führt) und `bluffRate`. Handstärke: preflop eine grobe
  Chart-Heuristik (hohe Karten, Paare, Suited-/Connector-Boni), postflop die
  tatsächlich beste 5-Karten-Hand (`bestHand()` aus `handEvaluator.js`),
  linear auf 0..1 abgebildet. Bust-Erkennung und Match-Ende nutzen dieselbe
  `trackEliminations()` wie 1v1v1v1 Ranked/Casual (`vs-bots-over`-Event für
  den Menschen). Bot-Räume werden bewusst nicht persistiert (siehe
  `persist()`), damit nach einem Server-Neustart kein nie wieder
  erreichbarer Bot-Platzhalter an einem Tisch übrig bleibt – rein zum Üben,
  ohne Auswirkung auf Rang oder Bestenliste.

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
