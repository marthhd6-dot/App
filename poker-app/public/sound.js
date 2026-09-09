// public/sound.js
// Rein synthetisch per Web Audio API erzeugte Soundeffekte (keine
// eingebundenen Audio-Dateien) – dockt an die bereits vorhandenen
// FX-Auslösepunkte in app.js an (spawnChipFly, showActionBubble,
// spawnFoldCards, burstConfetti, deal-in/reveal-flip, renderAbilities,
// justBecameMyTurn in renderBetSizer). Bewusst prozedural statt Audio-
// Dateien: keine zusätzlichen Assets/Requests, keine Lizenzfragen, passt
// zum "kein Build-Schritt nötig"-Ansatz des restlichen Frontends.
//
// Muted-Zustand in localStorage (SOUND_MUTED_KEY), siehe #sound-toggle-btn
// in index.html/app.js.

const SOUND_MUTED_KEY = 'pokerSoundMuted';

let audioCtx = null;
let masterGain = null;
let soundMuted = false;
try {
  soundMuted = localStorage.getItem(SOUND_MUTED_KEY) === '1';
} catch {
  // localStorage nicht verfügbar – Standard bleibt "an"
}

// AudioContext darf laut Autoplay-Policy der Browser erst nach einer
// echten Nutzerinteraktion erzeugt/fortgesetzt werden – siehe
// unlockAudioOnFirstInteraction() unten, einmalig an document gebunden.
function ensureAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.5;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function unlockAudioOnFirstInteraction() {
  ensureAudioContext();
  document.removeEventListener('pointerdown', unlockAudioOnFirstInteraction);
  document.removeEventListener('keydown', unlockAudioOnFirstInteraction);
}
document.addEventListener('pointerdown', unlockAudioOnFirstInteraction, { once: true });
document.addEventListener('keydown', unlockAudioOnFirstInteraction, { once: true });

function isSoundMuted() {
  return soundMuted;
}

function setSoundMuted(muted) {
  soundMuted = muted;
  try {
    localStorage.setItem(SOUND_MUTED_KEY, muted ? '1' : '0');
  } catch {
    // ignorieren, siehe oben
  }
}

// Ein einzelner kurzer Ton mit exponentiellem Decay (klingt weicher/
// "elektronischer" aus als ein hartes Abschneiden). frequency kann sich
// optional zu sweepTo hin verändern (z. B. für ein Fold-"Swish").
function tone({ frequency, duration = 0.12, type = 'sine', gain = 0.2, sweepTo = null, delay = 0 }) {
  const ctx = ensureAudioContext();
  if (!ctx || soundMuted) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  const startTime = ctx.currentTime + delay;
  osc.frequency.setValueAtTime(frequency, startTime);
  if (sweepTo !== null) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), startTime + duration);
  }
  g.gain.setValueAtTime(gain, startTime);
  g.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(g);
  g.connect(masterGain);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

// Kurzer, gefilterter Rausch-Burst – für "Whoosh"-artige Effekte (Karte
// aufdecken, Fold) deutlich organischer als ein reiner Sinuston.
function noiseBurst({ duration = 0.12, gain = 0.15, filterFreq = 1200, delay = 0 }) {
  const ctx = ensureAudioContext();
  if (!ctx || soundMuted) return;
  const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = filterFreq;
  const g = ctx.createGain();
  const startTime = ctx.currentTime + delay;
  g.gain.setValueAtTime(gain, startTime);
  g.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  source.connect(filter);
  filter.connect(g);
  g.connect(masterGain);
  source.start(startTime);
  source.stop(startTime + duration + 0.02);
}

function playDealSound(count = 1, staggerSec = 0.12) {
  for (let i = 0; i < count; i++) {
    noiseBurst({ duration: 0.06, gain: 0.12, filterFreq: 2200, delay: i * staggerSec });
  }
}

function playFlipSound() {
  noiseBurst({ duration: 0.09, gain: 0.14, filterFreq: 1800 });
  tone({ frequency: 700, duration: 0.08, type: 'triangle', gain: 0.1, delay: 0.02 });
}

function playCheckSound() {
  tone({ frequency: 320, duration: 0.09, type: 'sine', gain: 0.15 });
}

function playCallSound() {
  tone({ frequency: 520, duration: 0.07, type: 'triangle', gain: 0.16 });
  tone({ frequency: 620, duration: 0.07, type: 'triangle', gain: 0.13, delay: 0.06 });
}

// clickCount steigt mit dem Einsatz relativ zum eigenen Stack – simuliert
// einen größeren Chip-Stapel bei größeren Bets, ohne die Lautstärke selbst
// unangenehm laut werden zu lassen.
function playBetSound(amount = 0, stack = 1) {
  const ratio = stack > 0 ? Math.min(1, amount / stack) : 0.3;
  const clickCount = 2 + Math.round(ratio * 4);
  for (let i = 0; i < clickCount; i++) {
    tone({
      frequency: 900 + Math.random() * 200,
      duration: 0.045,
      type: 'square',
      gain: 0.08,
      delay: i * 0.035,
    });
  }
}

function playAllInSound() {
  playBetSound(1, 1);
  tone({ frequency: 180, duration: 0.35, type: 'sawtooth', gain: 0.18, sweepTo: 90, delay: 0.1 });
}

function playFoldSound() {
  tone({ frequency: 260, duration: 0.22, type: 'sine', gain: 0.14, sweepTo: 90 });
}

function playChipFlySound() {
  tone({ frequency: 1100, duration: 0.05, type: 'triangle', gain: 0.1 });
}

function playWinSound() {
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    tone({ frequency: freq, duration: 0.28, type: 'sine', gain: 0.14, delay: i * 0.09 });
  });
}

function playAbilitySound() {
  tone({ frequency: 500, duration: 0.09, type: 'sine', gain: 0.12, sweepTo: 1200 });
}

function playYourTurnSound() {
  tone({ frequency: 660, duration: 0.14, type: 'sine', gain: 0.16 });
  tone({ frequency: 880, duration: 0.16, type: 'sine', gain: 0.14, delay: 0.13 });
}

function playUiClickSound() {
  tone({ frequency: 1400, duration: 0.03, type: 'square', gain: 0.05 });
}

// Haptisches Feedback für die nativen Apps (siehe capacitor.config.json):
// window.Capacitor.Plugins.Haptics wird nur innerhalb der gebündelten
// nativen App automatisch bereitgestellt (Capacitor-Bridge) – im
// normalen Browser existiert window.Capacitor nicht, triggerHaptic() ist
// dort also ein No-Op. Kein Import von @capacitor/haptics nötig: die
// native Laufzeit registriert das Plugin selbst auf window.Capacitor.Plugins,
// dieselbe Deno-Import-freie Nutzung wie beim restlichen Frontend ohne
// Build-Schritt.
function triggerHaptic(style) {
  try {
    const capacitor = window.Capacitor;
    const isNative = capacitor && typeof capacitor.isNativePlatform === 'function' && capacitor.isNativePlatform();
    const haptics = isNative && capacitor.Plugins && capacitor.Plugins.Haptics;
    if (haptics) haptics.impact({ style });
  } catch {
    // Haptics-Plugin nicht verfügbar (z. B. noch nicht per `cap sync`
    // eingebunden) – einfach ignorieren, rein kosmetisches Feature.
  }
}

function hapticLight() {
  triggerHaptic('LIGHT');
}
function hapticMedium() {
  triggerHaptic('MEDIUM');
}
function hapticHeavy() {
  triggerHaptic('HEAVY');
}
