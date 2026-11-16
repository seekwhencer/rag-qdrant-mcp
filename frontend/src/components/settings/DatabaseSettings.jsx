import { useTranslation } from 'react-i18next';
import SettingsField from './SettingsField.jsx';
import SaveFooter from './SaveFooter.jsx';
import useSettingsGroup from '../../hooks/useSettingsGroup.js';

const FIELDS = [
  { key: 'host', type: 'text', label: 'settings.db.host', hint: 'settings.db.hostHint', placeholder: 'settings.db.hostPlaceholder' },
  { key: 'port', type: 'number', label: 'settings.db.port', hint: 'settings.db.portHint', min: 1, max: 65535, step: 1 },
  { key: 'user', type: 'text', label: 'settings.db.user', hint: 'settings.db.userHint' },
  { key: 'password', type: 'password', label: 'settings.db.password', hint: 'settings.db.passwordHint' },
  { key: 'database', type: 'text', label: 'settings.db.database', hint: 'settings.db.databaseHint' },
  { key: 'poolSize', type: 'number', label: 'settings.db.poolSize', hint: 'settings.db.poolSizeHint', min: 1, max: 50, step: 1 },
  { key: 'connectTimeoutMs', type: 'number', label: 'settings.db.connectTimeoutMs', hint: 'settings.db.connectTimeoutMsHint', min: 1000, step: 500 },
  { key: 'retryDelaySec', type: 'number', label: 'settings.db.retryDelaySec', hint: 'settings.db.retryDelaySecHint', min: 0, step: 1 },
  { key: 'maxRetries', type: 'number', label: 'settings.db.maxRetries', hint: 'settings.db.maxRetriesHint', min: 0, max: 100, step: 1 },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

export default function DatabaseSettings({ settings, loading, error, saving, saved, save }) {
  const { t } = useTranslation();
  const { draft, setField, isLocked, handleSave, handleReset } =
    useSettingsGroup('db', FIELD_KEYS, settings, save);

  return (
    <>
      <div className="settings__body">
        {loading && <p className="settings__loading">{t('settings.loading')}</p>}
        {!loading && (
          <div className="settings__panel">
            <div className="settings__panel-header">
              <h3>{t('settings.db.title')}</h3>
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
