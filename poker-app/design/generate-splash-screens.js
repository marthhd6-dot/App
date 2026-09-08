// design/generate-splash-screens.js
// Erzeugt aus app-splash-logo.svg (in diesem Ordner) alle iOS-/Android-
// Splash-Screen-Dateien in den benötigten Pixelgrößen – ersetzt die
// Capacitor-Platzhalter (weißer Hintergrund + blaues "X"-Logo).
//
// Kein npm-Script/keine Projekt-Dependency, siehe generate-app-icons.js für
// dieselbe Begründung (Playwright bliebe sonst eine dauerhafte
// Abhängigkeit nur für diesen einmaligen Design-Schritt). Voraussetzung
// zum erneuten Ausführen: `npm install --no-save playwright && npx
// playwright install chromium`, dann:
//
//   node design/generate-splash-screens.js
//
// Anders als bei den App-Icons (feste 1:1-Canvas) haben Splash-Screens
// viele unterschiedliche Seitenverhältnisse (Hoch-/Querformat, jede
// Android-Dichtestufe). Statt für jede Zielgröße eigene
// Transform-Berechnungen zu pflegen, wird app-splash-logo.svg pro
// Zielgröße als verschachtelter <svg>-Viewport (eigenes Koordinaten-
// system, per width/height/x/y positioniert) mittig auf einen radialen
// Verlaufs-Hintergrund gesetzt, der die komplette Zielfläche füllt – das
// Logo bleibt dabei unverzerrt quadratisch, unabhängig vom Seiten-
// verhältnis der Zielgröße.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DESIGN_DIR = __dirname;
const REPO = path.join(__dirname, '..');

// Anteil der kürzeren Kantenlänge, den der Logo-Durchmesser einnimmt –
// groß genug, um sofort erkennbar zu sein, aber mit deutlichem Rand zum
// Bildschirmrand, wie beim ursetzten Capacitor-Platzhalter-Logo.
const LOGO_SIZE_RATIO = 0.42;

const IOS_TARGETS = [
  'ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png',
  'ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png',
  'ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png',
].map((p) => ({ file: p, width: 2732, height: 2732 }));

const ANDROID_TARGETS = [
  { file: 'android/app/src/main/res/drawable/splash.png', width: 480, height: 320 },
  { file: 'android/app/src/main/res/drawable-land-mdpi/splash.png', width: 480, height: 320 },
  { file: 'android/app/src/main/res/drawable-land-hdpi/splash.png', width: 800, height: 480 },
  { file: 'android/app/src/main/res/drawable-land-xhdpi/splash.png', width: 1280, height: 720 },
  { file: 'android/app/src/main/res/drawable-land-xxhdpi/splash.png', width: 1600, height: 960 },
  { file: 'android/app/src/main/res/drawable-land-xxxhdpi/splash.png', width: 1920, height: 1280 },
  { file: 'android/app/src/main/res/drawable-port-mdpi/splash.png', width: 320, height: 480 },
  { file: 'android/app/src/main/res/drawable-port-hdpi/splash.png', width: 480, height: 800 },
  { file: 'android/app/src/main/res/drawable-port-xhdpi/splash.png', width: 720, height: 1280 },
  { file: 'android/app/src/main/res/drawable-port-xxhdpi/splash.png', width: 960, height: 1600 },
  { file: 'android/app/src/main/res/drawable-port-xxxhdpi/splash.png', width: 1280, height: 1920 },
];

// Extrahiert alles zwischen dem öffnenden und schließenden <svg>-Tag der
// Logo-Quelle, damit es als Inhalt eines verschachtelten <svg>-Elements
// wiederverwendet werden kann (inkl. seiner eigenen <defs> mit dem
// Gold-Verlauf des Chips).
function extractSvgInner(svgSource) {
  const start = svgSource.indexOf('>') + 1;
  const end = svgSource.lastIndexOf('</svg>');
  return svgSource.slice(start, end);
}

function buildSplashSvg(width, height, logoInner) {
  const logoSize = Math.round(Math.min(width, height) * LOGO_SIZE_RATIO);
  const x = Math.round((width - logoSize) / 2);
  const y = Math.round((height - logoSize) / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <radialGradient id="splashBg" cx="50%" cy="46%" r="78%">
        <stop offset="0%" stop-color="#ff7a1a"/>
        <stop offset="55%" stop-color="#e2350f"/>
        <stop offset="100%" stop-color="#7a0f0a"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#splashBg)"/>
    <svg x="${x}" y="${y}" width="${logoSize}" height="${logoSize}" viewBox="0 0 1024 1024">
      ${logoInner}
    </svg>
  </svg>`;
}

async function renderPng(page, svgContent, width, height, outPath) {
  await page.setViewportSize({ width, height });
  await page.setContent(
    `<!doctype html><html><body style="margin:0">${svgContent.replace(
      '<svg xmlns',
      '<svg style="width:100%;height:100%;display:block" xmlns'
    )}</body></html>`
  );
  await page.waitForTimeout(60);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const logoSource = fs.readFileSync(path.join(DESIGN_DIR, 'app-splash-logo.svg'), 'utf8');
  const logoInner = extractSvgInner(logoSource);

  // Cache: identische Zielgrößen (z. B. alle drei iOS-Dateien, oder die
  // doppelt vorkommende 480x320 unter drawable/ + drawable-land-mdpi/)
  // nur einmal rendern und die PNG-Bytes wiederverwenden statt erneut zu
  // rasterisieren.
  const rendered = new Map();

  for (const target of [...IOS_TARGETS, ...ANDROID_TARGETS]) {
    const key = `${target.width}x${target.height}`;
    const outPath = path.join(REPO, target.file);
    if (rendered.has(key)) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.copyFileSync(rendered.get(key), outPath);
      console.log(`${target.file} (${key}, wiederverwendet)`);
      continue;
    }
    const svg = buildSplashSvg(target.width, target.height, logoInner);
    await renderPng(page, svg, target.width, target.height, outPath);
    rendered.set(key, outPath);
    console.log(`${target.file} (${key}) geschrieben`);
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
