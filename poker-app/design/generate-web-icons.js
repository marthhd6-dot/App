// design/generate-web-icons.js
// Erzeugt aus app-icon-master.svg die PNG-Icons, die das Web-App-Manifest
// (public/manifest.webmanifest) für die Installation als PWA braucht –
// getrennt von generate-app-icons.js, das die nativen iOS-/Android-Projekte
// bedient.
//
// Kein npm-Script/keine Projekt-Dependency, siehe generate-app-icons.js für
// dieselbe Begründung. Voraussetzung zum erneuten Ausführen:
// `npm install --no-save playwright && npx playwright install chromium`, dann:
//
//   node design/generate-web-icons.js
//
// "maskable": Android schneidet Icons je nach Launcher kreisförmig oder als
// Squircle zu. Damit dabei nichts Wichtiges abgeschnitten wird, verlangt die
// Spezifikation, dass der eigentliche Inhalt innerhalb eines Kreises mit 80%
// Durchmesser liegt. Statt dafür ein zweites SVG zu pflegen, wird der
// Master-Inhalt hier um denselben Mittelpunkt auf 78% skaliert und der
// entstehende Rand mit der Hintergrundfarbe des Icons gefüllt.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DESIGN_DIR = __dirname;
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
const BACKGROUND = '#7a0f0a'; // äußerster Stop des bg-Verlaufs in app-icon-master.svg

const TARGETS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

function extractSvgInner(svgSource) {
  const start = svgSource.indexOf('>') + 1;
  const end = svgSource.lastIndexOf('</svg>');
  return svgSource.slice(start, end);
}

function buildSvg(inner, maskable) {
  const content = maskable
    ? `<rect width="1024" height="1024" fill="${BACKGROUND}"/>
       <g transform="translate(512,512) scale(0.78) translate(-512,-512)">${inner}</g>`
    : inner;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${content}</svg>`;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const master = fs.readFileSync(path.join(DESIGN_DIR, 'app-icon-master.svg'), 'utf8');
  const inner = extractSvgInner(master);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const target of TARGETS) {
    const svg = buildSvg(inner, target.maskable);
    await page.setViewportSize({ width: target.size, height: target.size });
    await page.setContent(
      `<!doctype html><html><body style="margin:0">${svg.replace(
        '<svg xmlns',
        '<svg style="width:100%;height:100%;display:block" xmlns'
      )}</body></html>`
    );
    await page.waitForTimeout(60);
    const outPath = path.join(OUT_DIR, target.file);
    await page.screenshot({ path: outPath });
    console.log(`${target.file} (${target.size}x${target.size}) geschrieben`);
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
