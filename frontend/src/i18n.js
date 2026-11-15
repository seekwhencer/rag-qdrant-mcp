import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import de from './locales/de.json';
import it from './locales/it.json';

const LANG_KEY = 'ui.lang';
const SUPPORTED = ['en', 'de', 'it'];

function detectLng() {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored && SUPPORTED.includes(stored)) return stored;
  } catch {
    // localStorage unavailable (e.g. Private Mode) → fall back to navigator
  }
  const nav = (typeof navigator !== 'undefined' && navigator.language) || '';
  const navLc = nav.toLowerCase();
  if (navLc.startsWith('de')) return 'de';
  if (navLc.startsWith('it')) return 'it';
  return 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    de: { translation: de },
    it: { translation: it },
  },
  lng: detectLng(),
  fallbackLng: 'en',
  supportedLngs: SUPPORTED,
  interpolation: {
    escapeValue: false, // React already escapes (XSS)
  },
  react: {
    useSuspense: false, // resources are synchronous in the bundle → no Suspense needed
  },
});

// Persist the language so the switcher survives reloads.
i18n.on('languageChanged', (lng) => {
  try {
    localStorage.setItem(LANG_KEY, lng);
  } catch {
    // ignore
  }
});

export default i18n;
