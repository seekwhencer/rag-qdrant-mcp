import { useSyncExternalStore } from 'react';
import { defaultPrimaryHue } from '../utils/primaryColor.js';
import { defaultSecondaryHue } from '../utils/secondaryColor.js';
import { defaultRadiusFactor } from '../utils/radius.js';

const KEY = 'rag-qdrant-mcp.appSettings';

// UI-Settings (nur Frontend, lokal im Browser):
// primaryHue:    Farbton (0-360); Sättigung + Helligkeit fix (s. primaryColor.js)
// secondaryHue:  Farbton (0-360); Sättigung + Helligkeit fix (s. secondaryColor.js)
// radiusFactor:  Roundness (0-1); skaliert --radius-* (s. radius.js)
export const APP_SETTINGS_DEFAULTS = {
  primaryHue: defaultPrimaryHue(),
  secondaryHue: defaultSecondaryHue(),
  radiusFactor: defaultRadiusFactor(),
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...APP_SETTINGS_DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...APP_SETTINGS_DEFAULTS };
  }
}

let cache = read();
const listeners = new Set();

export function getAppSettings() {
  return cache;
}

export function setAppSettings(patch) {
  cache = { ...cache, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // localStorage nicht verfügbar (z. B. Private Mode) → nur In-Memory
  }
  listeners.forEach((listener) => listener());
}

export function resetAppSettings() {
  setAppSettings({ ...APP_SETTINGS_DEFAULTS });
}

export function subscribeAppSettings(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React-Hook: reagiert auf Änderungen der UI-Settings. */
export function useAppSettings() {
  return useSyncExternalStore(subscribeAppSettings, getAppSettings, getAppSettings);
}
