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
├── capacitor.config.json     # Native-App-Konfiguration (siehe "Native App" unten)
├── ios/                      # Generiertes Xcode-Projekt (Capacitor), Bauen nur auf macOS
├── android/                  # Generiertes Gradle-Projekt (Capacitor), Bauen via Android Studio/SDK
├── public/                   # Statisches Browser-Frontend (kein Build-Schritt)
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── server-config.js      # Server-URL-Routing Browser vs. native App
│   └── vendor/socket.io.min.js
├── src/
│   ├── game/
│   │   ├── deck.js           # Deck erzeugen, mischen, ziehen
│   │   ├── handEvaluator.js  # Beste 5-Karten-Hand aus 7 Karten finden
│   │   └── table.js          # Tisch-Zustand: Spieler, Phasen, Pot
│   ├── rooms.js              # Verwaltet mehrere Tische über Raum-Codes
│   ├── persistence.js        # Lädt/speichert Raum-Snapshots + Ränge in SQLite
│   ├── ranking.js            # ELO-artige Rating-/Rang-Logik für 1v1v1v1 Ranked
│   ├── blinds.js             # Turnier-Blind-Zeitplan für alle Modi
│   ├── bots.js                # Heuristische Bot-KI (Entscheidungen pro Rang-Stufe)
│   ├── botNames.js           # Pool menschlich klingender Bot-Nutzernamen
│   └── server.js             # Express + Socket.io Server, liefert public/ aus
├── data/                     # Gespeicherte Chip-Stände & Ränge (rooms.db, gitignored)
└── tests/
    ├── handEvaluator.test.js
    ├── table.test.js
    ├── rooms.test.js
    ├── persistence.test.js
    ├── ranking.test.js
    ├── blinds.test.js
    ├── bots.test.js
    └── botNames.test.js
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

## Native Apps (iOS + Android, über Capacitor)

Die App ist im Kern weiterhin reines Server-gerendertes HTML/CSS/JS ohne
Build-Schritt (siehe `public/`) – für App Store/Play Store braucht es
trotzdem eine native Hülle. Dafür ist [Capacitor](https://capacitorjs.com/)
für beide Plattformen eingerichtet: `capacitor.config.json` (App-ID,
App-Name, `webDir: public`), ein generiertes Xcode-Projekt unter `ios/App/`
und ein generiertes Gradle-Projekt unter `android/`. Capacitor packt dafür
eine **lokale Kopie** von `public/` in die jeweilige App (kein Server im
App-Bundle – der bleibt separat gehostet, z. B. auf Render), die native
Shell lädt `index.html` also als Datei statt per HTTP.

Damit `socket.io` trotzdem den richtigen Server findet, unterscheidet
`public/server-config.js` (vor `app.js` geladen, plattformunabhängig für
iOS und Android gleichermaßen) zwei Fälle:

- **Normaler Browser-Betrieb** (lokal per `npm start` oder z. B. über
  Render): `window.POKER_SERVER_URL` bleibt leer, `io()` verbindet sich
  wie bisher automatisch mit dem eigenen Origin – unverändertes Verhalten.
- **Native App**: erkannt über `window.Capacitor.isNativePlatform()` (von
  der Capacitor-Laufzeit automatisch bereitgestellt, kein zusätzliches
  `<script>`-Tag nötig) – dann wird explizit die in `server-config.js`
  hinterlegte `NATIVE_SERVER_URL` angesprochen (Standard: die aktuelle
  Render-URL aus `public/sitemap.xml`). **Bei einem Domain-/Server-Wechsel
  muss dieser Wert manuell angepasst werden.**

Das `socket.io`-Client-Skript selbst liegt dafür als lokale Kopie unter
`public/vendor/socket.io.min.js` (kopiert aus
`node_modules/socket.io/client-dist/`, Version an den Server in
`package.json` angleichen) statt wie vorher vom Server unter
`/socket.io/socket.io.js` ausgeliefert zu werden – das funktioniert nur,
solange ein Express-Server tatsächlich läuft, in der gebündelten
Datei-Kopie der nativen Apps aber nicht.

```bash
cd poker-app
npm install                 # zieht auch @capacitor/core, @capacitor/cli, @capacitor/ios, @capacitor/android
npm run cap:sync            # kopiert public/ erneut in beide Plattform-Projekte + synct Plugins
```

### iOS

**Braucht einen Mac mit Xcode** – diese Session lief in einer
Linux-Umgebung ohne Xcode/CocoaPods, das Xcode-Projekt selbst wurde aber
bereits generiert (`npx cap add ios`) und lässt sich committen; Bauen/
Signieren/Ausführen/Einreichen geht nur auf einem Mac:

```bash
npm run cap:open:ios        # öffnet ios/App/App.xcodeproj in Xcode
```

1. **Signing & Capabilities** → euer Apple-Developer-Team auswählen
   (Apple Developer Program, 99 $/Jahr, siehe
   [developer.apple.com](https://developer.apple.com)).
2. Falls CocoaPods-Plugins dazukommen: `cd ios/App && pod install`, danach
   `App.xcworkspace` statt `App.xcodeproj` öffnen.
3. App-Icon und Splash-Screen sind bereits gesetzt (wilder Poker-Chip,
   siehe "App-Icons" und "Splash-Screens" unten) – kein
   Capacitor-Platzhalter mehr.
4. Auf Simulator/eigenem Gerät testen, dann über **TestFlight** verteilen,
   bevor ihr zur App-Review einreicht.

### Android

**Braucht Android Studio bzw. das Android SDK** – anders als iOS geht das
auch unter Linux/Windows, nicht nur auf einem Mac. Diese Session konnte
das Android-SDK aus dieser Sandbox heraus trotzdem nicht laden (Netzwerk-
Zugriff auf `dl.google.com` ist hier gesperrt) – das Gradle-Projekt wurde
deshalb nur generiert (`npx cap add android`) und statisch geprüft
(`applicationId`/App-Name korrekt in `build.gradle`/`strings.xml`
gesetzt), aber noch nie tatsächlich gebaut:

```bash
npm run cap:open:android    # öffnet android/ in Android Studio (falls installiert)
# oder headless, sobald ANDROID_HOME/ANDROID_SDK_ROOT gesetzt ist:
cd android && ./gradlew assembleDebug
```

1. Android Studio öffnet das Projekt und installiert fehlende SDK-Pakete
   normalerweise automatisch (Prompt beim ersten Öffnen).
2. App-Icon und Splash-Screen sind bereits gesetzt (dasselbe Motiv wie
   iOS, siehe "App-Icons" und "Splash-Screens" unten) – kein
   Capacitor-Platzhalter mehr.
3. Für den Play Store: einen Signing-Keystore erzeugen (`keytool`/Android
   Studios eigener Assistent unter *Build → Generate Signed Bundle/APK*)
   und **sicher aufbewahren** – ohne ihn lassen sich spätere Updates nicht
   mehr signieren.
4. Erst über einen **internen Test-Track** in der Google Play Console
   verteilen, bevor ihr zur Produktions-Review einreicht.

### App-Icons

Echte App-Icons statt der Capacitor-Platzhalter, für iOS und Android aus
derselben Vektor-Vorlage generiert (kein Fremd-Tool nötig – Playwright
rendert das SVG headless auf jede benötigte Pixelgröße, dasselbe Prinzip
wie die Playwright-Screenshots, die in dieser Session sonst zum
UI-Testen dienen): ein leicht schräg gekippter goldener Poker-Chip mit
klassischem rot-goldenem Kerbenrand, aber mit einem wilden, breit
grinsenden Comic-Gesicht (schielende Augen, hochgezogene Augenbrauen,
Zahnreihe, rote Wangen) auf einem knalligen Orange-Rot-Comic-Starburst
mit Karten-Symbol-Konfetti drumherum – passend zum Namen "Rumble Poker"
deutlich verspielter/wilder als ein klassisches, seriöses Casino-Icon.

- **iOS**: ein einzelnes opakes 1024×1024-PNG,
  `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`
  (Xcodes modernes Single-Size-App-Icon-Format – Xcode skaliert selbst
  auf alle benötigten Anzeigegrößen herunter).
- **Android**: Legacy-Icons (`ic_launcher`/`ic_launcher_round`, dasselbe
  Bild – der Launcher wendet seine eigene Rund-/Squircle-Maske ohnehin
  selbst an) bei 48/72/96/144/192px sowie ein **Adaptive-Icon-
  Vordergrund** (`ic_launcher_foreground`, transparent, innerhalb der
  Safe Zone zentriert, damit auf keiner Icon-Form etwas abgeschnitten
  wird) bei 108/162/216/324/432px, je Dichtestufe unter
  `android/app/src/main/res/mipmap-*`. Die Adaptive-Icon-Hintergrundfarbe
  (`values/ic_launcher_background.xml`) ist auf dasselbe dunkle Glut-Rot
  gesetzt wie der Hintergrund-Verlauf im Master-SVG, statt des weißen
  Platzhalters.
- Quelle: `design/app-icon-master.svg` (iOS + Android-Legacy-Icons) und
  `design/app-icon-foreground.svg` (Android-Adaptive-Vordergrund –
  derselbe Chip, per SVG-Transform um denselben Mittelpunkt auf 86 %
  skaliert, damit er innerhalb der Safe Zone bleibt, ohne alle
  Element-Koordinaten von Hand neu berechnen zu müssen).
  `design/generate-app-icons.js` rendert beide SVGs per Playwright auf
  alle benötigten Pixelgrößen neu – nützlich, falls sich das Design mal
  ändern soll (Kommentar im Script erklärt Voraussetzungen/Aufruf).

### Splash-Screens

Echte Splash-Screens statt des weißen Capacitor-Platzhalters (kleines
blaues "X"-Logo auf Weiß): derselbe Farbverlauf wie im App-Icon-Hintergrund
(Orange-Rot) füllt den kompletten Bildschirm, mit dem Chip-Maskottchen
(ohne Gesicht, siehe "App-Icons" oben) mittig darauf – bewusst ohne
Text/Wortmarke, damit es bei
jeder Bildschirmgröße (vom kleinsten Android-Legacy-Format 320×480 bis
zum iOS-Quadrat 2732×2732) lesbar bleibt, analog zum ursprünglichen
Capacitor-Platzhalter, der ebenfalls nur ein zentriertes Symbol ohne Text
zeigt.

Anders als die App-Icons (feste 1:1-Canvas) brauchen Splash-Screens viele
verschiedene Seitenverhältnisse (Hoch-/Querformat, jede Android-
Dichtestufe). Statt für jede Zielgröße eigene Transform-Berechnungen zu
pflegen, bettet `design/generate-splash-screens.js` die Logo-Quelle
(`design/app-splash-logo.svg` – derselbe Chip wie im App-Icon, aber
unskaliert und ohne den Comic-Starburst-Hintergrund) pro Zielgröße als
verschachtelten `<svg>`-Viewport mittig auf einen Farbverlaufs-
Hintergrund, der die komplette Zielfläche füllt – das Logo bleibt dabei
unverzerrt quadratisch, unabhängig vom Seitenverhältnis:

- **iOS**: ein einzelnes opakes 2732×2732-PNG (dieselbe Datei für alle
  drei in `Contents.json` gelisteten Skalierungsstufen, wie schon beim
  Capacitor-Platzhalter), unter
  `ios/App/App/Assets.xcassets/Splash.imageset/`.
- **Android**: 11 Dateien unter `android/app/src/main/res/drawable*/
  splash.png` – je eine Hoch- und Querformat-Variante für jede
  Dichtestufe (mdpi bis xxxhdpi) plus die dichte-unabhängige
  `drawable/splash.png`.

### Gemeinsame Punkte für beide Plattformen

- Der angezeigte App-Name ist **"Rumble Poker"** (`capacitor.config.json`
  → `appName`, iOS `CFBundleDisplayName`, Android `strings.xml` →
  `app_name`/`title_activity_main`, sowie Browser-Titel/-Logo in
  `public/index.html`). Die interne Bundle-/Package-ID
  `com.pokerapp.texasholdem` (`appId` in `capacitor.config.json`, iOS
  Bundle-Identifier, Android `applicationId`/Java-Package) ist davon
  unabhängig und bewusst unverändert geblieben – sie ist für Nutzer nicht
  sichtbar, und sie umzubenennen würde die Java-Package-Ordnerstruktur
  unter `android/app/src/main/java/` sowie die Xcode-Projekteinstellungen
  verändern, was ohne lokale Build-Tools (Android Studio/Xcode) riskant
  zu verifizieren ist.
- `capacitor.config.json` → `appId` (`com.pokerapp.texasholdem`) ist ein
  **Platzhalter** – vor der echten Einreichung auf die im eigenen Apple-/
  Google-Developer-Account registrierte ID ändern (danach `npm run
  cap:sync`, damit beide nativen Projekte den neuen Wert übernehmen).
- **Zur Einordnung (Store-Richtlinien für Poker/Glücksspiel-nahe Apps):**
  sowohl Apple als auch Google prüfen Poker-/Karten-Apps mit "Chips"
  strenger, auch ohne Echtgeld (Apple: Guideline 4.7/3.1.1; Google Play:
  Richtlinie zu Glücksspielen/simulierten Glücksspielen). Wichtig für eine
  Freigabe ohne Glücksspiel-Lizenz: konsequent klarstellen, dass es
  **kein Echtgeld, keinen Chip-Kauf und keinen Cash-out** gibt (steht in
  der App bereits so in der Meta-Beschreibung), Altersfreigabe vermutlich
  17+/PEGI 16-18, und für den Multiplayer-Chat/die Namensvergabe eine
  Melde-/Blockier-Möglichkeit sowie eine Datenschutzerklärungs-URL in App
  Store Connect bzw. der Play Console einplanen.

## Was schon funktioniert

- Deck erzeugen & fair mischen
- Beste Hand aus 2 Hole Cards + 5 Community Cards ermitteln
  (inkl. Splitpot-Erkennung, Ass-tief-Straße)
- Grundstruktur für einen Tisch mit mehreren Spielern
- **Wettrunden-Logik** in `table.js`: `placeBet`, `raise`, `call`, `check`,
  `fold`, inklusive Zugreihenfolge, Big-Blind-Option, Mindest-Raise,
  All-In-Behandlung und automatischem Rundenabschluss. `check()` und
  `isBettingRoundComplete()` vergleichen den eigenen Einsatz mit
  `>=` statt `===` gegen `currentBet`: Postet ein kurzgestapelter Big
  Blind weniger als den vollen Big Blind (All-in-Blind), kann `currentBet`
  unter dem Einsatz des Small Blind liegen – der darf dann trotzdem
  checken, statt in einer Sackgasse zu landen (weder exaktes `check()`
  noch `call()` mit `owed > 0` wären sonst möglich gewesen).
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
  unten in der Mitte), animiertes Karten-Austeilen (siehe unten), ein
  pulsierender Rahmen um den aktiven Spieler, Konfetti bei einem eigenen
  Sieg, und eine identische Optik für Ranked-Warteschlange und Bestenliste.
- **Casino-Lobby-Menü statt loser Knopf-Liste** (`public/index.html`/
  `style.css`): Das Hauptmenü gruppiert die Spielmodi in klar beschriftete
  Abschnitte ("Eigener Tisch", "Ranked", "Casual", "Üben") mit
  Sektions-Label und farbigem Chip-Punkt (`.lobby-section`,
  `.lobby-chip-dot-*`) – wie die Kategorien einer echten Casino-Lobby. Eine
  einzige Farbe pro KATEGORIE statt pro einzelnem Modus: Gold ist exklusiv
  für Ranked reserviert (`.btn-mode-ranked`, egal ob 1v1v1v1 oder 2v2),
  Grün für Casual (`.btn-mode-casual`), Blau-Grau für den Übungsmodus
  (`.btn-mode-practice`) – derselbe Farbcode zieht sich weiter zu den
  Tisch-Badges (`.ranked-badge`/`.ranked-team-badge` usw.), damit die
  Kategorie am Tisch genauso erkennbar bleibt wie im Menü. Zusätzlich
  bekommen Tisch-Kopfzeile (`.table-header`) und Aktions-Leiste
  (`.action-bar`) eine eigene, dezente Hintergrund-Fläche statt lose auf dem
  Seitenhintergrund zu schweben – wie eine Infotafel bzw. ein Bedienpult an
  einem echten Casino-Tisch. Nebenbei behoben: `#bots-screen` und
  `#rank-screen` hingen zuvor am linken Rand statt zentriert zu sein, weil
  die alte Zentrierung nur für drei einzelne Screen-IDs per Hand nachgezogen
  war – jetzt zentriert sich jedes `.panel` einheitlich über `margin: 0
  auto`.
- **Glaubwürdiger 3D-Look für den Tisch, reines CSS** (`public/style.css`/
  `app.js`, keine neue Engine/kein Canvas/WebGL – die App bleibt reines
  Server-gerendertes HTML/CSS/JS ohne Build-Schritt, siehe Struktur oben):
  Spieler werden weiterhin nur durch Name, Chip-Anzahl und Label
  repräsentiert, keine Avatare/Figuren – die Tiefenwirkung kommt
  ausschließlich aus Licht, Schatten und Material, nicht aus echter 3D-Geo­
  metrie oder einer Kamera-Rotation (die hätte die Prozent-Koordinaten der
  Sitzplätze in `renderSeats()`/`seatPositionByOrderedIndex()` unnötig
  verkompliziert und Text lesbar zu halten wäre bei einer echten Perspektiv-
  Rotation riskant gewesen).
  - **Tisch** (`.felt-surface`/`.felt-rail-sheen`/`.table-drop-shadow`):
    asymmetrische Inset-Schatten formen eine leicht konkave "Schüssel"
    statt einer flachen Kreisfläche (heller Anriss oben, dunkler unten);
    ein per `mask` auf die Breite der Holzkante zugeschnittener
    `conic-gradient`-Ring simuliert deren Rundung/Prägung; ein separates,
    breit verblurtes Schatten-Element hinter dem Tisch lässt ihn sichtbar
    vor dem Hintergrund "schweben". Die Filz-Webstruktur (`.felt-rail`) hat
    jetzt zwei sich überlagernde Diagonal-Muster (hell/dunkel) für mehr
    Stoff-Textur.
  - **Beleuchtung**: ein `radial-gradient` als erste (oberste)
    Hintergrund-Ebene von `.felt-surface` simuliert ein Spotlicht über der
    Tischmitte; eine `.bg-vignette` über der ganzen Seite dunkelt die Ränder
    sanft ab und lenkt den Blick zur Mitte.
  - **Karten** (`.card`/`.card::after`): ein diagonaler Glanzstreifen als
    zusätzliche `background`-Ebene (kein `::before`, damit `border-radius`
    automatisch greift, ohne `overflow: hidden` zu brauchen – das hätte den
    Schatten in `::after` abgeschnitten) sowie ein eigener, unscharfer
    Schlagschatten unter jeder Karte lassen sie sichtbar auf dem Filz
    liegen statt nur zu schweben. Neu: `.reveal-flip`
    (`@keyframes card-reveal-flip`) lässt aufgedeckte Gegner-Hände beim
    echten Showdown einmalig um die eigene Achse "umkippen" statt nur zu
    erscheinen (`justRevealed`-Parameter in `renderSeats()`, gesetzt aus
    `justResolved` in `render()`).
  - **Chips** (`.chip-stack-mini`/`.chip-icon`/`.chip-fly`): Inset-Schatten
    oben/unten geben den bestehenden Chip-Kreisen eine Zylinder-Rundung,
    ein zusätzlicher äußerer Schlagschatten hebt sie vom Filz ab. Der
    fliegende Chip (`spawnChipFly()`) rollt jetzt sichtbar
    (`@keyframes chip-roll`, Rotation + kurzes Aufplustern) während des
    Flugs zum Pot bzw. zu den Gewinnern, statt nur stumpf zu gleiten.
  - **Spieler-Panels ohne Avatare** (`.seat-pod`/`.seat-avatar`/
    `.dealer-button`): ein schmaler Lichtsaum oben und ein Schatten unten
    (Inset-Box-Shadow) geben den Panels ein Glas-/Materialgefühl statt
    einer Flachfarbe; die Buchstaben-Badges (Sitzplatz-Initiale, Dealer-
    Button) sind jetzt geprägt (Bevel/Emboss: heller Rand oben, Schatten
    unten, dünner Rahmen) statt flacher Vollton-Kreise.
  - **Pot/Einsatz**: Chips fliegen schon länger sichtbar zur Tischmitte
    (`spawnChipFly()`/`spawnPotPayout()`, unverändert); neu pulsiert der
    Pot-Betrag bei jeder Änderung kurz golden auf (`.pot-pulse`,
    `animatePotTo()` in `app.js`) statt den Text nur kommentarlos
    auszutauschen.
  - **Hintergrund-Atmosphäre** (`.dust-particles`): sechs feste, langsam
    nach oben treibende, unscharfe Lichtpunkte simulieren Staub/Bokeh im
    Spotlicht – bewusst eine feste, kleine Anzahl DOM-Elemente statt eines
    generischen Partikelsystems, damit die Kosten fix und vorhersehbar
    bleiben.
  - **UI-Elemente** (`.btn`/`button`): ein Lichtsaum oben (Inset) gibt
    Knöpfen eine gewölbte, glänzende Oberfläche; `:active` tauscht ihn
    gegen einen inneren Schatten statt nur die Position zu verschieben –
    fühlt sich sichtbar "eingedrückt" an.
  - **Was bewusst NICHT simuliert wird** (echte Normal-Maps, Echtzeit-
    Schatten, echtes Bloom/Post-Processing): all das braucht eine
    Render-Pipeline (Canvas/WebGL/Shader), die dieses Projekt nicht hat.
    Stattdessen approximieren gestapelte CSS-Gradients/Box-Shadows densel­
    ben visuellen Eindruck, ohne die Architektur (server-gerendertes
    HTML/CSS/JS, kein Build-Schritt) zu ändern – Bloom z. B. über
    `text-shadow`/`box-shadow`-Glow statt echtem Licht-Streuen.
  - **Performance-Kompromisse & Mobile** (siehe
    `@media (max-width: 640px)` in `style.css`): `mask` (Rail-Sheen) und
    große `filter: blur()`-Radien (Tisch-Schatten) sind die teuersten rein
    dekorativen Ebenen – auf schmalen/mobilen Bildschirmen wird der
    Rail-Sheen-Ring komplett abgeschaltet (die Holzkante bleibt als
    massive Farbfläche trotzdem sichtbar) und der Tisch-Schatten mit einem
    kleineren Blur-Radius gerendert; die sechs Staub-Partikel werden
    ausgeblendet (dauerhaft laufende, zusätzlich compositierte Ebenen ohne
    spielerischen Mehrwert auf kleinen Bildschirmen). `filter: blur()` und
    `mask-image` sind auf Desktop-GPUs praktisch kostenlos (Compositor-
    Ebene), auf älteren/schwachen Mobile-GPUs aber die Effekte mit dem
    größten Overdraw – deshalb die ersten Kandidaten zum Abschalten statt
    nur zu verkleinern. Alle Animationen respektieren weiterhin die
    globale `@media (prefers-reduced-motion: reduce)`-Regel ganz oben in
    `style.css` (setzt jede `animation`/`transition` auf ~0).
- **Deal-Animationen** (`public/app.js`/`style.css`): Community Cards und
  die eigenen Hole Cards fliegen beim Austeilen mit Stagger-Delay ein
  (`.deal-in`, siehe `renderCommunityCards()`/`renderMyCards()`), erkannt
  über `isNewHand` (Phase wechselt zu `preflop`). Zusätzlich zeigt
  `renderSeats()` an jedem Sitzplatz eines Gegners, der noch im Spiel ist
  und dessen Karten für mich nicht sichtbar sind, zwei kleine, gefächerte
  verdeckte Mini-Karten (`.mini-card-back`) – sie fliegen beim Start einer
  Hand reihum ein (zwei Runden mit `n` Sitzplätzen Versatz, wie
  `Table.startHand()` intern austeilt), damit das Austeilen am ganzen Tisch
  sichtbar ist statt nur bei der eigenen Hand. `@keyframes deal-in` dreht
  dabei zusätzlich per `rotateY` von 180° auf 0° (mit `perspective` auf
  `.card-row`), sodass Karten sich beim Austeilen sichtbar "umdrehen"
  statt nur einzufliegen.
- **Weitere Tisch-Animationen** (`public/app.js`, Funktionen rund um
  `detectAndShowActionFx()`): Ein persistenter `#fx-layer` über dem Tisch
  trägt kurzlebige Effekt-Elemente, die – anders als die Sitzplätze selbst
  – ein Neu-Rendern überleben und ihre eigene Animation zu Ende spielen,
  bevor sie sich selbst entfernen:
  - **Aktions-Sprechblasen**: `detectAndShowActionFx()` vergleicht jeden
    neuen `state` mit dem vorherigen Snapshot (`prevState`) und zeigt bei
    Bet/Call/Raise/Check/Fold eine kurze Sprechblase über dem jeweiligen
    Sitzplatz – rein aus der Differenz der öffentlichen Spieler-Daten
    hergeleitet, ohne dass der Server den Aktionstyp explizit mitschicken
    müsste.
  - **Chip-Flug**: bei Bet/Call/Raise fliegt ein kleiner Chip vom
    Sitzplatz zum Pot (`spawnChipFly()`); ist eine Hand gerade eben zu
    Ende gegangen (`lastHandResult` neu gesetzt), fliegen die Chips
    umgekehrt vom Pot zu jedem Gewinner zurück (`spawnPotPayout()`).
  - **Fold-Wegschieben**: beim Fold zusätzlich zur Sprechblase zwei kleine
    Karten, die vom Sitzplatz wegdriften und ausblenden
    (`spawnFoldCards()`).
  - **Gleitender Dealer-Button** (`updateDealerButton()`): ein einziges
    persistentes `#dealer-button`-Element statt eines pro Sitzplatz neu
    erzeugten Badges, das per CSS-`transition` sichtbar zum neuen
    Dealer-Sitzplatz hinübergleitet statt hart zu springen.
  - **"Denkt nach …"-Punkte bei Bots**: `state.botIds` listet die
    Bot-Sitzplätze des aktuellen Raums (egal ob reiner Übungsmodus oder ein
    mit Bots aufgefülltes Ranked/Casual-Match, siehe `broadcastRoomState()`
    in `server.js`) – `renderSeats()` zeigt drei pulsierende Punkte am
    Sitzplatz des gerade handelnden Bots.
  - **Gewinner-Hand-Glow**: nach einem echten Showdown (nicht bei einem
    reinen Fold-Sieg) leuchten die Community Cards kurz golden auf
    (`.card.glow`, nutzt dieselbe `winner-glow`-Animation wie der
    Gewinner-Sitzplatz), zusätzlich die eigenen Karten, falls ich selbst
    gewonnen habe.
  - **Karten-Reveal beim Showdown**: Bei einem echten Showdown (Karten
    tatsächlich verglichen, nicht bei einem Sieg durch Fold) schickt der
    Server über `getPublicState()` (`table.js`) die Hole Cards aller nicht
    gefoldeten Spieler an JEDEN Client mit, statt sie wie sonst nur dem
    jeweiligen Spieler selbst zu zeigen – gefoldete Spieler bleiben
    verborgen (es gibt nichts zu vergleichen). Das Frontend zeigt die
    aufgedeckten Gegner-Hände zweifach: als kleine, gefächerte Karten direkt
    am Sitzplatz (`renderSeats()`, dieselbe Optik wie die verdeckten
    `.mini-card-back`, nur mit sichtbarem Rang/Symbol) und zusätzlich groß
    und namentlich gelistet im Panel "Karten beim Showdown"
    (`#showdown-reveal`, generalisiert aus dem bisherigen
    Teammitglied-Panel), damit klar wird, gegen welche Hand man gewonnen
    oder verloren hat. Die Teammitglied-Erkennung (2v2 Casual) prüft dafür
    jetzt `state.teams`, statt allein daran zu erkennen, dass `holeCards`
    nicht `null` ist – sonst würde ein beim Showdown aufgedeckter Gegner
    fälschlich im Teammitglied-Panel landen.

  Ein gemeinsamer Positions-Helfer (`seatPositionByOrderedIndex()`/
  `seatPositionForPlayer()`) berechnet die Kreisposition eines Sitzplatzes
  einmal zentral, damit sowohl `renderSeats()` als auch alle Effekt-
  Funktionen dieselbe Formel nutzen, statt sie zu duplizieren.
- **Bet-Schieberegler mit ¼-/½-Pot- und All-In-Schnellwahl** (`#bet-sizer`
  in `index.html`, `renderBetSizer()`/`setBetSizerValue()` in `app.js`):
  Statt den Betrag nur eintippen zu können, lässt sich der Bet-/Raise-Betrag
  jetzt auch per Regler ziehen oder über drei Schnellwahl-Knöpfe (¼ Pot,
  ½ Pot, All-In) setzen – alle drei Bedienwege schreiben denselben Wert in
  das jeweils aktive Betrag-Feld (`bet-input` im Bet-Modus, `raise-input`
  im Raise-Modus; welches gerade aktiv ist, richtet sich wie zuvor nach
  `state.currentBet`), sodass der bestehende "Bet"/"Raise"-Knopf zum
  Abschicken weiterhin unverändert funktioniert. Die legalen Grenzen
  (Mindesteinsatz = großer Blind bzw. Mindest-Raise-Schritt, Maximum = das
  eigene Chip-Guthaben fürs All-In) berechnet `renderBetSizer()` aus
  `state.bigBlind`/`state.minRaise` – zwei neue Felder, die `getPublicState()`
  in `table.js` jetzt mitschickt, rein zur Anzeige; verbindlich validiert
  wird nach wie vor ausschließlich server-seitig in `placeBet()`/`raise()`.
  Zu Beginn eines eigenen Zugs springt der Regler frisch auf das Minimum,
  statt einen Betrag aus einer ganz anderen Wettrunde stehen zu lassen.
- **Größere, deutlicher lesbare Karten** (`style.css`): die eigenen Hole
  Cards und die des Teammitglieds (`.my-card-row .card`, geteilte Klasse
  für `#my-cards`/`#teammate-cards`) sind spürbar größer als Community
  Cards (60×84 → 76×106 px), und auch die Basisgröße für Community Cards
  sowie die beim Showdown aufgedeckten Gegner-Hände (`.card`, sowohl die
  große Auflistung in `#showdown-reveal` als auch die kleinen gefächerten
  Karten direkt am Sitzplatz, `.seat-cards .card`) wurde vergrößert.
  Zusätzlich sind Eckindizes (Rang) und das große Symbol in der Mitte
  (`.card-corner`/`.card-suit-big`) deutlich größer skaliert, damit Rang
  und Farbe auch über den Tisch hinweg auf einen Blick eindeutig lesbar
  sind – die Rang-Zahl/-Buchstabe selbst (`.card-rank`, eigene Klasse für
  den ersten `<span>` in `.card-corner`) sitzt dabei nochmal deutlich
  größer als das kleine Farbsymbol direkt daneben (`.card-suit-mini`), wie
  auf einer echten Spielkarte. Eigene Mobile-Breakpoints
  (`@media (max-width: 640px)`) skalieren
  Community Cards und eigene Karten proportional zurück, damit auf
  schmalen Bildschirmen nichts überläuft.
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
- **"Zurück zum Hauptmenü"** (`#leave-table-btn` im Tisch-Header): lässt
  den Tisch jederzeit verlassen, nicht nur nach Matchende (dafür gibt es
  bereits `#ranked-back-to-menu-btn` im Sieg/Niederlage-Banner). Nutzt
  denselben Mechanismus: `sessionStorage`-Eintrag löschen (verhindert den
  automatischen Wieder-Beitritt beim nächsten Verbindungsaufbau) und die
  Seite neu laden. Serverseitig kein eigener "Leave"-Socket-Event nötig –
  der getrennte Socket wird wie jeder andere Verbindungsabbruch behandelt
  (siehe Reconnect-Handling oben: Gnadenfrist, danach Entfernen vom
  Tisch). Ein Bestätigungsdialog verhindert versehentliches Verlassen.
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
  Toleranz-Fenster nötig, da kein Rating verglichen wird). Startkapital wie
  ein normaler Casual-Tisch (1000 Chips), aber mit demselben
  Turnier-Blind-Zeitplan wie Ranked (`blindsForHandsPlayed()`, 5/10 bis
  160/320). Wie beim Ranked-Modus endet das Match, sobald
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
- **Bot-Auffüllung in allen vier Matchmaking-Modi** (`maybeBackfillQueueWithBots()`
  in `server.js`): Findet sich innerhalb von `BOT_BACKFILL_DELAY_MS`
  (Standard 15s, überschreibbar) keine volle Menschen-Gruppe, werden die
  restlichen Plätze mit Bots aufgefüllt – deren Rang-Stufe leitet sich aus
  dem durchschnittlichen Rating der wartenden Spieler ab (`tierForRating()`
  in `ranking.js`), damit sie fair zur Warteschlange passen (auch bei
  Casual, obwohl das gespeicherte Rating dort sonst keine Rolle spielt).
  Bots nehmen wie echte Mit-/Gegenspieler am Match teil, inklusive
  normaler Rating-Auswirkung für die Menschen in den Ranked-Modi
  (`maybeFinishRankedMatch()`/`maybeFinishRankedTeamMatch()`) – bewusste
  Entscheidung, damit sich ein aufgefülltes Match nicht anders anfühlt als
  ein echtes. Die Bots selbst haben aber keinen dauerhaften Account: ihr
  Rating für die ELO-Rechnung ist nur für dieses eine Match gültig und wird
  nie in `player_ranks`/der Bestenliste gespeichert. Ihr Name kommt aus
  einem Pool menschlich klingender Nutzernamen (`pickBotNames()` in
  `botNames.js`, zufällig gewählt und ohne Überschneidung mit den
  Namen der echten Spieler am Tisch), statt sie über ein erkennbares Schema
  wie "Gold-Bot 2" zu verraten – erkennbar bleiben sie serverseitig trotzdem
  über die `bots`-Map jedes Raums bzw. `state.botIds` im Client (z. B. für
  die "Denkt nach …"-Anzeige). Dieselbe
  Bot-Infrastruktur (`decideBotAction()` aus `bots.js`,
  `maybeTriggerBotActions()` für die automatischen Züge inkl. Bedenkzeit)
  wird auch vom expliziten "Gegen Bots üben"-Modus genutzt –
  `getMatchEntry()` findet dafür den passenden Raum-Eintrag unabhängig vom
  konkreten Modus.
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
  ohne Auswirkung auf Rang oder Bestenliste. Bevor ein Bot-Zug tatsächlich
  ausgeführt wird, wartet `maybeTriggerBotActions()` eine kurze zufällige
  "Bedenkzeit" (700-1800ms, `botThinkDelayMs()`, über `BOT_THINK_DELAY_MIN_MS`/
  `BOT_THINK_DELAY_MAX_MS` überschreibbar) – rein kosmetisch, damit Bots
  nicht unnatürlich sofort reagieren; die Entscheidung selbst steht davor
  schon fest.
- **Fähigkeiten-System** (`src/game/abilities.js`, integriert in `table.js`/
  `server.js`/`bots.js`, UI in `public/app.js`/`style.css`): In JEDEM Modus
  (Ranked wie Casual, 1v1v1v1 wie 2v2, auch gegen Bots) bekommt jeder
  Spieler zu Beginn jeder Hand eine Fähigkeit aus jeder der vier Kategorien
  zugeteilt – einmal Karten, einmal Wette/Pot, einmal Info/Gegner, einmal
  Ressourcen (`CATEGORIES` in `abilities.js`) – dargestellt als vier
  klickbare Karten neben den eigenen Hole Cards (`#my-abilities`), jede pro
  Hand genau einmal einsetzbar. Da jeder Spieler exakt dieselben vier
  Kategorien bekommt, bleibt Ranked-Matchmaking/-Rating unangetastet fair –
  es kommt nur taktische Abwechslung dazu, kein struktureller Vorteil.
  Aktuell eine Fähigkeit je Kategorie (das Datenmodell trägt aber
  problemlos mehrere zufällig wählbare Optionen pro Kategorie, ohne
  `assignAbilities()` oder die Aufrufer anzupassen):
  - **Kartentausch** (Karten): tauscht eine zufällige der beiden Hole Cards
    gegen eine neue vom Deck – eine echte Ja/Nein-Entscheidung, da die neue
    Karte auch schlechter sein kann.
  - **Pot-Bonus** (Wette/Pot): +20 % Bonus-Chips auf den eigenen
    Gewinn-Anteil dieser Hand (`ABILITY_POT_BONUS_RATE`), falls vor
    Hand-Ende aktiviert – wirkt sowohl bei einem Sieg durch Fold als auch
    beim echten Showdown (`Table._applyPotBonusIfActive()`).
  - **Spionage** (Info/Gegner): deckt eine zufällige Hole Card eines
    zufälligen, noch nicht gefoldeten Gegners auf – nur für den
    einsetzenden Spieler sichtbar (`spyReveals`/`spiedCard` in
    `getPublicState()`), am Gegner-Sitzplatz als aufgedeckte Mini-Karte mit
    blauem Ring statt der üblichen verdeckten Rückseite zu erkennen.
  - **Chip-Boost** (Ressourcen): sofortiger Chip-Bonus in Höhe von 10 % des
    aktuellen eigenen Stacks (`ABILITY_CHIP_BOOST_RATE`), vom "System"
    gutgeschrieben statt anderen Spielern abgezogen.

  Anders als `fold`/`check`/`call`/`bet`/`raise` ist `useAbility()` keine
  Wettrunden-Aktion: jeder Spieler kann seine Fähigkeiten jederzeit während
  einer laufenden Hand einsetzen, unabhängig davon, wer gerade am Zug ist
  (rührt `actingIndex`/`hasActed` nicht an). Bots entscheiden einmalig
  direkt nach dem Austeilen über `decideAbilityActions()` in `bots.js`:
  Chip-Boost/Pot-Bonus/Spionage haben in diesem einfachen Design keinerlei
  Nachteil, werden also immer sofort eingesetzt; Kartentausch nur bei einer
  erkennbar schwachen Preflop-Hand (`preflopStrength() < 0.4`).

## Mögliche nächste Schritte (für Claude Code)

Die ursprüngliche Roadmap ist komplett. Ideen, um weiterzubauen:

- **Postgres/Supabase statt lokaler SQLite-Datei**: sinnvoll, sobald die
  App auf mehreren Server-Prozessen/Maschinen laufen soll (SQLite ist
  an eine einzelne Datei auf einer Maschine gebunden).
- **Hand-Historie & Chat**: vergangene Hände und Nachrichten pro Raum
  anzeigen (SQLite ist dafür bereits vorhanden und würde sich anbieten).
- **Mobile-optimiertes UI**: Die Action-Bar und Karten-Reihen sind noch
  nicht für kleine Bildschirme optimiert.

## Guter erster Prompt für Claude Code

> "Lies dir ranking.js und server.js durch. Erweitere den Ranked-Modus um
> ein zweites Format mit 6 Spielern pro Tisch (analog zu
> RANKED_GROUP_SIZE), wählbar über einen zweiten Warteschlangen-Button im
> Frontend."
