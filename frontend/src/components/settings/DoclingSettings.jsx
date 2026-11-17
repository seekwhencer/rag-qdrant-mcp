import { useTranslation } from 'react-i18next';
import SettingsField from './SettingsField.jsx';
import SaveFooter from './SaveFooter.jsx';
import useSettingsGroup from '../../hooks/useSettingsGroup.js';

const FIELDS = [
  { key: 'url', type: 'text', label: 'settings.docling.url', hint: 'settings.docling.urlHint', placeholder: 'settings.docling.urlPlaceholder' },
  { key: 'apiKey', type: 'password', label: 'settings.docling.apiKey', hint: 'settings.docling.apiKeyHint' },
  { key: 'statusPollIntervalSec', type: 'number', label: 'settings.docling.statusPollIntervalSec', hint: 'settings.docling.statusPollIntervalSecHint', min: 1, step: 1 },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

export default function DoclingSettings({ settings, loading, error, saving, saved, save }) {
  const { t } = useTranslation();
  const { draft, setField, isLocked, handleSave, handleReset } =
    useSettingsGroup('docling', FIELD_KEYS, settings, save);

  return (
    <>
      <div className="settings__body">
        {loading && <p className="settings__loading">{t('settings.loading')}</p>}
        {!loading && (
          <div className="settings__panel">
            <div className="settings__panel-header">
              <h3>{t('settings.docling.title')}</h3>
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
