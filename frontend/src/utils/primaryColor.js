// Primärfarbe: nur der Farbton (Hue) ist einstellbar.
// Sättigung + Helligkeit sind FIX und werden aus der CSS-Basisfarbe abgeleitet.
//
// Die Basisfarbe kommt zur Laufzeit aus --color-primary in
// frontend/src/style/variables.css (dort die Vorlage).
// PRIMARY_FALLBACK_HEX ist nur Notnagel, falls das CSS noch nicht geladen ist,
// und muss mit --color-primary dort synchron bleiben.

const PRIMARY_FALLBACK_HEX = '#17b2ff';

// Hex → { r, g, b } (0-255).
function hexToRgb(hex) {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// { r, g, b } (0-255) → HSL. Gibt { h: 0-360, s: 0-100, l: 0-100 } zurück.
function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  let s = 0;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return { h: Math.round(hue), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// Hex → HSL. Gibt { h: 0-360, s: 0-100, l: 0-100 } zurück, null bei Fehler.
export function hexToHsl(hex) {
  const { r, g, b } = hexToRgb(hex);
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return rgbToHsl(r, g, b);
}

// CSS-Farbangabe (hex, rgb(a), hsl(a)) → HSL. null bei Fehler.
export function parseColorToHsl(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;

  if (v.startsWith('#')) return hexToHsl(v);

  const rgb = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (rgb) return rgbToHsl(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));

  const hsl = v.match(/^hsla?\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%/);
  if (hsl) {
    let h = Number(hsl[1]) % 360;
    if (h < 0) h += 360;
    return { h: Math.round(h), s: Math.round(Number(hsl[2])), l: Math.round(Number(hsl[3])) };
  }

  return null;
}

// Basis-HSL (aus CSS). Lazy + gecacht.
// Fallback wird NICHT gecacht → nächster Aufruf retryt, falls das CSS später lädt.
let baseHsl = null;
export function getPrimaryBaseHsl() {
  if (baseHsl) return baseHsl;
  if (typeof document !== 'undefined') {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim();
    const hsl = parseColorToHsl(raw);
    if (hsl) {
      baseHsl = hsl;
      return hsl;
    }
  }
  return hexToHsl(PRIMARY_FALLBACK_HEX);
}

// Initialwert für den Hue-Slider (Farbton der Basisfarbe).
export function defaultPrimaryHue() {
  return getPrimaryBaseHsl().h;
}

// Farbe für einen Hue-Wert (Sättigung + Helligkeit fix). Für Live-Vorschau.
export function primaryColorForHue(hue) {
  const h = Math.round(Number(hue));
  if (!Number.isFinite(h)) return null;
  const { s, l } = getPrimaryBaseHsl();
  return `hsl(${h}, ${s}%, ${l}%)`;
}

// Setzt :root --color-primary auf hsl(hue, fixS%, fixL%).
// Sättigung + Helligkeit bleiben dabei unverändert.
export function applyPrimaryHue(hue) {
  if (typeof document === 'undefined') return;
  const color = primaryColorForHue(hue);
  if (!color) return;
  document.documentElement.style.setProperty('--color-primary', color);
}
