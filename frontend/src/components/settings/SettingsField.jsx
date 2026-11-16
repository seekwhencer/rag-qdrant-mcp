import { useTranslation } from 'react-i18next';
import EnvLockBadge from './EnvLockBadge.jsx';
import Toggle from '../ui/Toggle.jsx';

/**
 * Rendert ein einzelnes Settings-Feld (text/number/checkbox/textarea/select/list).
 *
 * @param {object} props
 * @param {object} props.field - Feld-Definition (key, type, label, hint, ...)
 * @param {unknown} props.value - Aktueller Wert
 * @param {(v: unknown) => void} props.onChange - Wert-Callback
 * @param {string} [props.locked] - Name der Env-Variable, wenn das Feld per Env gesetzt ist
 */
export default function SettingsField({ field, value, onChange, locked }) {
  const { t } = useTranslation();
  const isLocked = typeof locked === 'string' && locked !== '';
  const lockBadge = isLocked ? <EnvLockBadge envName={locked} /> : null;
  const baseClass = isLocked ? 'settings__field settings__field--locked' : 'settings__field';
  const hint = field.hint ? <span className="settings__hint">{t(field.hint)}</span> : null;

  if (field.type === 'checkbox') {
    return (
      <div className={`${baseClass} settings__field--check`}>
        <Toggle
          checked={Boolean(value)}
          onChange={onChange}
          disabled={isLocked}
          label={t(field.label)}
          labelExtra={lockBadge}
          id={field.key}
          name={field.key}
        />
        {hint}
      </div>
    );
  }

  if (field.type === 'number') {
    return (
      <label className={baseClass}>
        <span>{t(field.label)} {lockBadge}</span>
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={isLocked}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
        {hint}
      </label>
    );
  }

  if (field.type === 'textarea') {
    return (
      <label className={`${baseClass} settings__field--full`}>
        <span>{t(field.label)} {lockBadge}</span>
        <textarea
          className="settings__textarea"
          rows={4}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder ? t(field.placeholder) : undefined}
          disabled={isLocked}
          onChange={(e) => onChange(e.target.value)}
        />
        {hint}
      </label>
    );
  }

  if (field.type === 'select') {
    return (
      <label className={baseClass}>
        <span>{t(field.label)} {lockBadge}</span>
        <select
          className="select"
          value={value === undefined || value === null ? '' : String(value)}
          disabled={isLocked}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        {hint}
      </label>
    );
  }

  if (field.type === 'list') {
    const display = Array.isArray(value) ? value.join(', ') : (typeof value === 'string' ? value : '');
    return (
      <label className={`${baseClass} settings__field--full`}>
        <span>{t(field.label)} {lockBadge}</span>
        <input
          type="text"
          value={display}
          placeholder={field.placeholder ? t(field.placeholder) : undefined}
          disabled={isLocked}
          onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
        />
        {hint}
      </label>
    );
  }

  if (field.type === 'readonly') {
    return (
      <label className={`${baseClass} settings__field--full`}>
        <span>{t(field.label)} {lockBadge}</span>
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          disabled
          readOnly
        />
        {hint}
      </label>
    );
  }

  // default: text
  return (
    <label className={baseClass}>
      <span>{t(field.label)} {lockBadge}</span>
      <input
        type="text"
        value={typeof value === 'string' ? value : ''}
        placeholder={field.placeholder ? t(field.placeholder) : undefined}
        disabled={isLocked}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint}
    </label>
  );
}
