import { useTranslation } from 'react-i18next';
import SettingsField from './SettingsField.jsx';
import SaveFooter from './SaveFooter.jsx';
import useSettingsGroup from '../../hooks/useSettingsGroup.js';

const FIELDS = [
  { key: 'serverPort', type: 'number', label: 'settings.server.port', hint: 'settings.server.portHint', min: 1, max: 65535, step: 1 },
  { key: 'dataDir', type: 'text', label: 'settings.server.dataDir', hint: 'settings.server.dataDirHint', placeholder: 'settings.server.dataDirPlaceholder' },
  { key: 'verbose', type: 'checkbox', label: 'settings.server.verbose', hint: 'settings.server.verboseHint' },
  { key: 'searchTopK', type: 'number', label: 'settings.server.searchTopK', hint: 'settings.server.searchTopKHint', min: 1, step: 1 },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

// Read-only: Config-Pfad (CONFIG_PATH-Env oder Default) – nur Anzeige, nie per UI änderbar.
const CONFIG_PATH_FIELD = {
  key: 'configPath',
  type: 'readonly',
  label: 'settings.server.configPath',
  hint: 'settings.server.configPathHint',
};

export default function ServerSettings({ settings, loading, error, saving, saved, save }) {
  const { t } = useTranslation();
  const { draft, setField, isLocked, handleSave, handleReset } =
    useSettingsGroup('root', FIELD_KEYS, settings, save);

  return (
    <>
      <div className="settings__body">
        {loading && <p className="settings__loading">{t('settings.loading')}</p>}
        {!loading && (
          <div className="settings__panel">
            <div className="settings__panel-header">
              <h3>{t('settings.server.title')}</h3>
            </div>
            <div className="settings__grid">
              <SettingsField
                field={CONFIG_PATH_FIELD}
                value={settings?.configPath}
                locked="CONFIG_PATH"
              />
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
