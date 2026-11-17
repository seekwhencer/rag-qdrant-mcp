import { useTranslation } from 'react-i18next';
import SettingsField from './SettingsField.jsx';
import SaveFooter from './SaveFooter.jsx';
import useSettingsGroup from '../../hooks/useSettingsGroup.js';

const FIELDS = [
  { key: 'enabled', type: 'checkbox', label: 'settings.storage.enabled', hint: 'settings.storage.enabledHint' },
  { key: 'root', type: 'text', label: 'settings.storage.root', hint: 'settings.storage.rootHint', placeholder: 'settings.storage.rootPlaceholder' },
  { key: 'concurrency', type: 'number', label: 'settings.storage.concurrency', hint: 'settings.storage.concurrencyHint', min: 1, max: 16, step: 1 },
  { key: 'dummyDelaySec', type: 'number', label: 'settings.storage.dummyDelaySec', hint: 'settings.storage.dummyDelaySecHint', min: 0, step: 0.5 },
  { key: 'retryDelaySec', type: 'number', label: 'settings.storage.retryDelaySec', hint: 'settings.storage.retryDelaySecHint', min: 0, step: 1 },
  { key: 'maxRetries', type: 'number', label: 'settings.storage.maxRetries', hint: 'settings.storage.maxRetriesHint', min: 0, max: 10, step: 1 },
  { key: 'maxFileSizeMb', type: 'number', label: 'settings.storage.maxFileSizeMb', hint: 'settings.storage.maxFileSizeMbHint', min: 1, step: 1 },
  { key: 'ignore', type: 'list', label: 'settings.storage.ignore', hint: 'settings.storage.ignoreHint', placeholder: 'settings.storage.ignorePlaceholder' },
  { key: 'whitelist', type: 'list', label: 'settings.storage.whitelist', hint: 'settings.storage.whitelistHint', placeholder: 'settings.storage.whitelistPlaceholder' },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

export default function StorageSettings({ settings, loading, error, saving, saved, save }) {
  const { t } = useTranslation();
  const { draft, setField, isLocked, handleSave, handleReset } =
    useSettingsGroup('storage', FIELD_KEYS, settings, save);

  return (
    <>
      <div className="settings__body">
        {loading && <p className="settings__loading">{t('settings.loading')}</p>}
        {!loading && (
          <div className="settings__panel">
            <div className="settings__panel-header">
              <h3>{t('settings.storage.title')}</h3>
            </div>
            <div className="settings__grid">
              {FIELDS.map((f) => (
                <SettingsField
                  key={f.key}
                  field={f}
                  value={draft?.[f.key]}
                  onChange={(v) => setField(f.key, v)}
                  locked={isLocked(f.key)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <SaveFooter error={error} saving={saving} saved={saved} onSave={handleSave} onReset={handleReset} />
    </>
  );
}
