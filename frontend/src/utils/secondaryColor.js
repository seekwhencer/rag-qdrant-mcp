// Sekundärfarbe: nur der Farbton (Hue) ist einstellbar.
// Sättigung + Helligkeit sind FIX und werden aus der Basisfarbe abgeleitet.
//
// WICHTIG: SECONDARY_BASE_HEX muss mit --color-secondary in
// frontend/src/style/variables.css synchron bleiben (dort die Vorlage).

import { hexToHsl } from './primaryColor.js';

const SECONDARY_BASE_HEX = '#b45309';

// Fixe Sättigung + Helligkeit (aus der Basisfarbe) + Initial-Hue.
export const SECONDARY_BASE_HSL = hexToHsl(SECONDARY_BASE_HEX);

// Initialwert für den Hue-Slider (Farbton der Basisfarbe).
export function defaultSecondaryHue() {
  return SECONDARY_BASE_HSL.h;
}

// Farbe für einen Hue-Wert (Sättigung + Helligkeit fix). Für Live-Vorschau.
export function secondaryColorForHue(hue) {
  const h = Math.round(Number(hue));
  if (!Number.isFinite(h)) return null;
  const { s, l } = SECONDARY_BASE_HSL;
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
