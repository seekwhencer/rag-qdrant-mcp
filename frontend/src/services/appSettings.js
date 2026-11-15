import { useSyncExternalStore } from 'react';
import { defaultPrimaryHue } from '../utils/primaryColor.js';
import { defaultSecondaryHue } from '../utils/secondaryColor.js';
import { defaultRadiusFactor } from '../utils/radius.js';

const KEY = 'rag-qdrant-mcp.appSettings';

// UI-Settings (nur Frontend, lokal im Browser):
// primaryHue:    Farbton (0-360); Sättigung + Helligkeit fix (s. primaryColor.js)
// secondaryHue:  Farbton (0-360); Sättigung + Helligkeit fix (s. secondaryColor.js)
// radiusFactor:  Roundness (0-1); skaliert --radius-* (s. radius.js)
//
// Defaults werden LAZY berechnet (erster Zugriff, nicht Modul-Init), damit die
// CSS-Basisfarbe (Hue) schon geladen ist, wenn sie gelesen wird.
function computeDefaults() {
  return {
    primaryHue: defaultPrimaryHue(),
    secondaryHue: defaultSecondaryHue(),
    radiusFactor: defaultRadiusFactor(),
  };
}

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? JSON.parse(raw) : {};
    return { ...computeDefaults(), ...saved };
  } catch {
    return computeDefaults();
  }
}

let cache = null;
const listeners = new Set();

export function getAppSettings() {
  if (cache === null) cache = read();
  return cache;
}

export function setAppSettings(patch) {
  if (cache === null) cache = read();
  cache = { ...cache, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // localStorage nicht verfügbar (z. B. Private Mode) → nur In-Memory
  }
  listeners.forEach((listener) => listener());
}

export function resetAppSettings() {
  setAppSettings(computeDefaults());
}

export function subscribeAppSettings(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React-Hook: reagiert auf Änderungen der UI-Settings. */
export function useAppSettings() {
  return useSyncExternalStore(subscribeAppSettings, getAppSettings, getAppSettings);
}
