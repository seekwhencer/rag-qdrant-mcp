import { useTranslation } from 'react-i18next';
import SettingsField from './SettingsField.jsx';
import SaveFooter from './SaveFooter.jsx';
import useSettingsGroup from '../../hooks/useSettingsGroup.js';

const FIELDS = [
  { key: 'rerankEnabled', type: 'checkbox', label: 'settings.search.rerankEnabled', hint: 'settings.search.rerankEnabledHint' },
  { key: 'rerankBoost', type: 'number', label: 'settings.search.rerankBoost', hint: 'settings.search.rerankBoostHint', min: 0, step: 0.01 },
  { key: 'citationEnabled', type: 'checkbox', label: 'settings.search.citationEnabled', hint: 'settings.search.citationEnabledHint' },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

export default function SearchSettings({ settings, loading, error, saving, saved, save }) {
  const { t } = useTranslation();
  const { draft, setField, isLocked, handleSave, handleReset } =
    useSettingsGroup('search', FIELD_KEYS, settings, save);

  return (
    <>
      <div className="settings__body">
        {loading && <p className="settings__loading">{t('settings.loading')}</p>}
        {!loading && (
          <div className="settings__panel">
            <div className="settings__panel-header">
              <h3>{t('settings.search.title')}</h3>
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
