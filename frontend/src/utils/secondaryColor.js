// Sekundärfarbe: nur der Farbton (Hue) ist einstellbar.
// Sättigung + Helligkeit sind FIX und werden aus der CSS-Basisfarbe abgeleitet.
//
// Die Basisfarbe kommt zur Laufzeit aus --color-secondary in
// frontend/src/style/variables.css (dort die Vorlage).
// SECONDARY_FALLBACK_HEX ist nur Notnagel, falls das CSS noch nicht geladen ist,
// und muss mit --color-secondary dort synchron bleiben.

import { hexToHsl, parseColorToHsl } from './primaryColor.js';

const SECONDARY_FALLBACK_HEX = '#b45309';

// Basis-HSL (aus CSS). Lazy + gecacht.
// Fallback wird NICHT gecacht → nächster Aufruf retryt, falls das CSS später lädt.
let baseHsl = null;
export function getSecondaryBaseHsl() {
  if (baseHsl) return baseHsl;
  if (typeof document !== 'undefined') {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--color-secondary').trim();
    const hsl = parseColorToHsl(raw);
    if (hsl) {
      baseHsl = hsl;
      return hsl;
    }
  }
  return hexToHsl(SECONDARY_FALLBACK_HEX);
}

// Initialwert für den Hue-Slider (Farbton der Basisfarbe).
export function defaultSecondaryHue() {
  return getSecondaryBaseHsl().h;
}

// Farbe für einen Hue-Wert (Sättigung + Helligkeit fix). Für Live-Vorschau.
export function secondaryColorForHue(hue) {
  const h = Math.round(Number(hue));
  if (!Number.isFinite(h)) return null;
  const { s, l } = getSecondaryBaseHsl();
  return `hsl(${h}, ${s}%, ${l}%)`;
}

// Setzt :root --color-secondary auf hsl(hue, fixS%, fixL%).
// Sättigung + Helligkeit bleiben dabei unverändert.
export function applySecondaryHue(hue) {
  if (typeof document === 'undefined') return;
  const color = secondaryColorForHue(hue);
  if (!color) return;
  document.documentElement.style.setProperty('--color-secondary', color);
}
