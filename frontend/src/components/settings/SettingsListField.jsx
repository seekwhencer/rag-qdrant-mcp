import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import EnvLockBadge from './EnvLockBadge.jsx';

const toText = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '');
const toList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Rendert ein List-Feld (Komma-separierte Eingabe) als eigenes Textfeld.
 * Der Roh-String bleibt lokal, bis der Fokus das Feld verlässt (Blur),
 * damit man Kommas und Leerzeichen frei eintippen kann.
 * Beim Blur wird der String in ein Array aus Strings geparst und via onChange übergeben.
 *
 * @param {object} props
 * @param {object} props.field - Feld-Definition (key, type, label, hint, ...)
 * @param {unknown} props.value - Aktueller Wert (Array aus Strings oder String)
 * @param {(v: string[]) => void} props.onChange - Wert-Callback (erhält Array)
 * @param {string} [props.locked] - Name der Env-Variable, wenn das Feld per Env gesetzt ist
 */
export default function SettingsListField({ field, value, onChange, locked }) {
  const { t } = useTranslation();
  const isLocked = typeof locked === 'string' && locked !== '';
  const lockBadge = isLocked ? <EnvLockBadge envName={locked} /> : null;
  const baseClass = isLocked ? 'settings__field settings__field--locked' : 'settings__field';
  const hint = field.hint ? <span className="settings__hint">{t(field.hint)}</span> : null;

  const [text, setText] = useState(() => toText(value));
  const [focused, setFocused] = useState(false);

  // Externe Änderungen (Save/Reset) übernehmen, aber nicht während des Tippens überschreiben.
  useEffect(() => {
    if (!focused) setText(toText(value));
  }, [value, focused]);

  return (
    <label className={`${baseClass} settings__field--full`}>
      <span>{t(field.label)} {lockBadge}</span>
      <input
        type="text"
        value={text}
        placeholder={field.placeholder ? t(field.placeholder) : undefined}
        disabled={isLocked}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onChange(toList(text));
        }}
        onChange={(e) => setText(e.target.value)}
      />
      {hint}
    </label>
  );
}
