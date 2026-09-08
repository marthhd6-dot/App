// design/generate-app-icons.js
// Erzeugt aus app-icon-master.svg/app-icon-foreground.svg (in diesem Ordner)
// alle iOS-/Android-App-Icon-Dateien in den benötigten Pixelgrößen – siehe
// README.md, Abschnitt "App-Icons" für den Hintergrund.
//
// Kein npm-Script/keine Projekt-Dependency, weil dafür sonst Playwright
// (samt Chromium-Download) als reguläre Abhängigkeit mitgeschleppt werden
// müsste, obwohl es nur für diesen einmaligen Design-Schritt gebraucht
// wird. Voraussetzung zum erneuten Ausführen (z. B. nach einer
// Design-Anpassung): `npm install --no-save playwright && npx playwright
// install chromium` in einem Terminal mit Internetzugriff, dann:
//
//   node design/generate-app-icons.js
//
// Passt beide SVGs an, falls sich das Icon-Design ändert – app-icon-
// foreground.svg skaliert den kompletten Chip nur um denselben Mittelpunkt
// (512,512) wie app-icon-master.svg (Faktor 0.86, siehe Kommentar dort),
// damit er innerhalb der Android-"Safe Zone" bleibt – bei Änderungen am
// Master reicht es, dieselben Element-Koordinaten 1:1 in die Vordergrund-
// Datei zu übernehmen.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DESIGN_DIR = __dirname;
const REPO = path.join(__dirname, '..');

const ANDROID_DENSITIES = {
  mdpi: { legacy: 48, fg: 108 },
  hdpi: { legacy: 72, fg: 162 },
  xhdpi: { legacy: 96, fg: 216 },
  xxhdpi: { legacy: 144, fg: 324 },
  xxxhdpi: { legacy: 192, fg: 432 },
};

async function renderSquare(page, svgContent, size, outPath, transparent) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:${
      transparent ? 'transparent' : '#000'
    }"><div style="width:${size}px;height:${size}px">${svgContent.replace(
      '<svg xmlns',
      '<svg style="width:100%;height:100%;display:block" xmlns'
    )}</div></body></html>`
  );
  await page.waitForTimeout(60);
  await page.screenshot({ path: outPath, omitBackground: transparent });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const master = fs.readFileSync(path.join(DESIGN_DIR, 'app-icon-master.svg'), 'utf8');
  const foreground = fs.readFileSync(path.join(DESIGN_DIR, 'app-icon-foreground.svg'), 'utf8');

  // iOS: einzelnes 1024x1024 PNG, opak (kein Alpha-Kanal – Apple akzeptiert
  // keine transparenten App-Icons).
  const iosOut = path.join(REPO, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
  await renderSquare(page, master, 1024, iosOut, false);
  console.log('iOS-Icon geschrieben:', iosOut);

  // Android: Legacy-Launcher-Icons (ic_launcher/ic_launcher_round, dasselbe
  // Bild für beide – der Launcher wendet seine eigene Rund-/Squircle-Maske
  // ohnehin selbst an) + Adaptive-Icon-Vordergrund (transparent, innerhalb
  // der "Safe Zone" skaliert, siehe app-icon-foreground.svg).
  for (const [density, sizes] of Object.entries(ANDROID_DENSITIES)) {
    const base = path.join(REPO, `android/app/src/main/res/mipmap-${density}`);
    await renderSquare(page, master, sizes.legacy, path.join(base, 'ic_launcher.png'), false);
    await renderSquare(page, master, sizes.legacy, path.join(base, 'ic_launcher_round.png'), false);
    await renderSquare(page, foreground, sizes.fg, path.join(base, 'ic_launcher_foreground.png'), true);
    console.log(`Android ${density}: legacy ${sizes.legacy}px, foreground ${sizes.fg}px geschrieben`);
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
