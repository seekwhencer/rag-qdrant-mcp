import { useTranslation } from 'react-i18next';
import SettingsField from './SettingsField.jsx';
import SaveFooter from './SaveFooter.jsx';
import useSettingsGroup from '../../hooks/useSettingsGroup.js';

const FIELDS = [
  { key: 'url', type: 'text', label: 'settings.qdrant.url', hint: 'settings.qdrant.urlHint' },
  { key: 'port', type: 'number', label: 'settings.qdrant.port', min: 1, max: 65535, step: 1 },
  { key: 'collection', type: 'text', label: 'settings.qdrant.collection', hint: 'settings.qdrant.collectionHint' },
  { key: 'retryDelaySec', type: 'number', label: 'settings.qdrant.retryDelaySec', hint: 'settings.qdrant.retryDelaySecHint', min: 0, max: 3600, step: 1 },
  { key: 'maxRetries', type: 'number', label: 'settings.qdrant.maxRetries', hint: 'settings.qdrant.maxRetriesHint', min: 0, max: 100, step: 1 },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

export default function QdrantSettings({ settings, loading, error, saving, saved, save }) {
  const { t } = useTranslation();
  const { draft, setField, isLocked, handleSave, handleReset } =
    useSettingsGroup('qdrant', FIELD_KEYS, settings, save);

  return (
    <>
      <div className="settings__body">
        {loading && <p className="settings__loading">{t('settings.loading')}</p>}
        {!loading && (
          <div className="settings__panel">
            <div className="settings__panel-header">
              <h3>{t('settings.qdrant.title')}</h3>
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
