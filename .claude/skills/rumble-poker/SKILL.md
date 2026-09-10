---
name: rumble-poker
description: Arbeitsweise für die Poker-App in poker-app/ (Rumble Poker) – Ablauf von Branch bis Pull Request, die harten Randbedingungen des Frontends, die Prüfungen, die hier schon echte Fehler gefunden haben, und die gestalterischen Leitplanken. Nutze diesen Skill bei jeder Änderung an poker-app/, besonders bei UI-, Layout- oder Animationsarbeit.
---

# Rumble Poker

Texas Hold'em unter `poker-app/`. Node/Express + Socket.io im Backend, das
Frontend ist **reines Browser-JavaScript ohne Build-Schritt**: drei Dateien
(`public/index.html`, `public/app.js`, `public/style.css`) plus
`public/sound.js`, ausgeliefert wie sie im Repo liegen. Zusätzlich läuft
dieselbe `public/`-Ablage über Capacitor als native iOS-/Android-App und
als installierbare PWA.

**Alles auf Deutsch**: Oberfläche, Code-Kommentare, Commit-Nachrichten,
PR-Texte, Antworten an den Nutzer.

## Ablauf

1. **Branch frisch von `main`** – nie auf gemergter Historie weiterbauen:
   `git fetch origin main && git checkout -B <branch> origin/main`
2. Umsetzen.
3. `cd poker-app && npm test` – 100+ Tests, reines Node-`assert`, kein
   Framework. Neue Spiellogik gehört in `tests/` mitgetestet.
4. **Live prüfen** (siehe unten). Nicht überspringen: Fast jeder Fehler in
   diesem Projekt wurde hier gefunden, nicht von den Unit-Tests.
5. Committen, pushen, Pull Request mit **Testplan** im Text – jeder Punkt
   benennt, was tatsächlich geprüft wurde, nicht was geprüft werden sollte.
6. `subscribe_pr_activity`, CI abwarten, Status berichten.
7. **Erst auf ausdrückliche Aufforderung mergen.** Danach abmelden und
   einen etwaigen Check-in löschen.

## Live prüfen

Server: `cd poker-app && node src/server.js` (Port 3001, per `PORT`
überschreibbar). Für einen sauberen Start vorher `data/rooms.db*` löschen.

Am schnellsten kommt man über **„Gegen Bots üben"** an einen vollen Tisch:
Namen eintragen → `#bots-setup-btn` → Botanzahl wählen → `#bots-start-btn`
→ `#start-hand-btn`. Für einen echten Showdown mehrere Hände lang
`#call-btn`/`#check-btn` klicken, bis `#start-hand-btn` wieder sichtbar
wird.

In dieser Umgebung läuft Playwright über
`NODE_PATH=/opt/node22/lib/node_modules node <skript>.js` mit
`chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })` –
Playwright ist bewusst **keine** Projekt-Abhängigkeit.

### Die Bildschirmgrößen, die hier Fehler gefunden haben

| Größe | Was sie aufdeckt |
|---|---|
| 375×667 | knappste Höhe – hier reißt das Layout zuerst |
| 390×844 | übliches Handy |
| 844×390 | Handy quer, eigenes Raster |
| 768×1024 | Tablet hoch |
| 1180×820 | Tablet quer, eigenes Raster |
| 1440×900 | Desktop |

**Nicht nur mitten in einer Hand messen.** Der Showdown blendet zusätzlich
die aufgedeckten Gegnerkarten ein und hat genau deshalb schon zweimal das
Layout gesprengt, nachdem „alles grün" gemeldet war.

Automatisch prüfen statt Screenshots deuten – diese vier Messungen haben
sich bewährt:

```js
const d = document.documentElement;
const bar = document.querySelector('.action-bar').getBoundingClientRect();
const potR = document.querySelector('.pot-display').getBoundingClientRect();
const comR = document.getElementById('community-cards').getBoundingClientRect();
({
  scrollen: d.scrollHeight > d.clientHeight + 2,          // muss false sein
  ueberlaufX: d.scrollWidth - d.clientWidth,              // muss 0 sein
  aktionenSichtbar: bar.bottom <= d.clientHeight + 1,     // muss true sein
  potVerdeckt: potR.bottom > comR.top && potR.top < comR.bottom
             && potR.right > comR.left && potR.left < comR.right, // muss false sein
})
```

Dazu `pageerror`/`console`-Fehler mitschreiben und am Ende ausgeben.
Screenshots ergänzen die Messung, ersetzen sie nicht.

## Harte Randbedingungen

- **Kein Build-Schritt, kein Framework, kein Tailwind.** Keine
  npm-Abhängigkeit fürs Frontend hinzufügen. Werkzeuge für einmalige
  Design-Schritte liegen als eigenständige Skripte in `design/` und werden
  mit `--no-save` betrieben.
- **Der Tisch-Screen füllt exakt den Viewport.** `#table-screen` rechnet
  seine Höhe als `100dvh` minus dem `body`-Padding – deshalb liegen beide
  Werte als `--body-pad-y`/`--body-pad-x` in `:root`. Wer das Padding
  ändert, muss beide Stellen im Blick behalten. Alles Feste behält seine
  Höhe, nur `.table-felt` gibt nach.
- **Jedes zusätzliche Element im Fluss von `#table-screen` drückt die
  Aktions-Leiste unter die Falz.** Neue Panels gehören als schwebende
  Ebene darüber (wie `.chat-drawer`), nicht in die Spalte.
- **Sitzplätze ragen über die Filzkante hinaus** (Mittelpunkt bei 44 %
  Radius, halbe Sitzbreite). Deshalb hat `#table-screen` seitliches
  Padding als Reservestreifen – ohne das ragen sie in bestimmten
  Fensterbreiten aus dem Viewport.
- **Zwischen zwei Händen** (`waiting`/`showdown`) blendet `render()` alles
  aus, was ohnehin nicht bedienbar ist: Regler, Wett-Knöpfe,
  Fähigkeiten-Karten. Das ist kein Schönheitsfehler, sondern schafft den
  Platz für den Showdown-Bereich.

## Fallstricke, die schon zugeschlagen haben

- **`opacity` unter 1 hebt `transform-style: preserve-3d` auf.** Die Karten
  haben eine echte Rückseite (`.card::before`); animiert man ihre
  Deckkraft, flacht die 3D-Ebene ab und die Karte verschwindet mitten in
  der Drehung. Die Deal-/Flip-Keyframes animieren deshalb keine Deckkraft.
- **Gebackene Federkurven brauchen `linear`.** Die Stützstellen der
  Karten-Animationen sind eine nachgerechnete Federbahn; eine zusätzliche
  `cubic-bezier` würde sie ein zweites Mal verzerren.
- **Pot und Community Cards sind ein gemeinsamer Stapel** (`.felt-center`),
  keine zwei Prozentpositionen – sonst verdecken sich beide auf flachen
  Tischen. Positionen für Chip-Flüge deshalb **messen** (`potPosition()`),
  nicht verdrahten.
- **Server-Zustand ist die Wahrheit.** Was im Client aktiv oder deaktiviert
  wirkt, muss zur Server-Regel passen. Der Raise-Knopf war lange gegen ein
  deckendes All-In aktiv, obwohl kein legaler Raise existierte – jeder
  Klick quittierte nur mit einer Fehlermeldung.

## Gestaltung

Rumble Poker hat bereits eine eigene Handschrift: dunkler Casino-Filz,
Gold als einzige Leitfarbe, Outfit für Überschriften und Inter für Fließtext,
handgeschriebene Verläufe und Schatten mit echter Tiefenwirkung. **Neue
Oberfläche fügt sich dort ein, statt eine zweite Sprache einzuführen** –
also über die vorhandenen Custom Properties in `:root` (`--accent`,
`--text-dim`, `--panel`, `--danger` …) und die bestehenden
Knopf-/Panel-Klassen, nicht über neue Einzelwerte.

Diese Punkte stammen aus Anthropics `frontend-design`-Skill
(Apache-2.0, siehe `NOTICE.md` daneben) und gelten hier weiter:

- **Zurückhaltung.** Ein Element darf laut sein, der Rest bleibt still. Am
  Tisch ist das die Hand des Spielers – Kopfzeile, Sitzplätze und
  Aktions-Leiste ordnen sich unter.
- **Struktur ist Information, keine Dekoration.** Rahmen, Trennlinien und
  Nummerierungen nur, wenn sie etwas über den Inhalt aussagen. Nummerierte
  Marken (01/02/03) nur bei echten Abfolgen.
- **Bewegung ohne Nutzerauslöser sparsam.** Ein orchestrierter Moment
  wirkt stärker als überall verstreute Effekte. Bewegung, die auf eine
  Aktion antwortet – Karte fliegt zum Pot, Chip wandert zum Gewinner –
  ist willkommen, weil sie zeigt, was sich geändert hat.
- **Typografische Verlegenheitslösungen meiden**, sie sind die deutlichsten
  Merkmale generierter Oberflächen: ein einzelnes hervorgehobenes Wort in
  einer Überschrift, Versalien als Label, überflüssige Beschriftungen über
  Inhalten, Meta-Angaben mit Mittelpunkten aneinandergereiht, ein
  angehängtes „→" an Knopftexten.
- **Text ist Gestaltungsinhalt.** Aktiv formulieren, benennen was passiert:
  ein Knopf „Chips nachkaufen" erzeugt eine Bestätigung, die dasselbe Wort
  benutzt. Fehlermeldungen sagen, was schiefging und was jetzt hilft –
  ohne Entschuldigung und ohne Vagheit.
- **Qualitätsuntergrenze ohne Ankündigung**: bis aufs Handy hinunter
  benutzbar, sichtbarer Tastaturfokus, Touch-Ziele ab 44 px, ausreichender
  Kontrast. Dialoge folgen dem bestehenden Muster (Escape, Fokusfalle,
  Fokus-Rückgabe, `aria-modal`) – siehe `dialogOeffnen()` in `app.js`.

Prüfe deine eigene Arbeit mit Screenshots, während du baust. Und bevor du
fertig meldest: ein Detail wieder wegnehmen.
