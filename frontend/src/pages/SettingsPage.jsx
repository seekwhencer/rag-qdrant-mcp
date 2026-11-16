import { useTranslation } from 'react-i18next';
import { useParams, useNavigate } from 'react-router-dom';
import useSettings from '../hooks/useSettings.js';
import ServerSettings from '../components/settings/ServerSettings.jsx';
import QdrantSettings from '../components/settings/QdrantSettings.jsx';
import EmbeddingsSettings from '../components/settings/EmbeddingsSettings.jsx';
import ChatSettings from '../components/settings/ChatSettings.jsx';
import McpSettings from '../components/settings/McpSettings.jsx';
import StorageSettings from '../components/settings/StorageSettings.jsx';
import UiSettings from '../components/settings/UiSettings.jsx';

const CATEGORIES = [
  { id: 'server', title: 'settings.categories.server', component: ServerSettings },
  { id: 'storage', title: 'settings.categories.storage', component: StorageSettings },
  { id: 'qdrant', title: 'settings.categories.qdrant', component: QdrantSettings },
  { id: 'embeddings', title: 'settings.categories.embeddings', component: EmbeddingsSettings },
  { id: 'chat', title: 'settings.categories.chat', component: ChatSettings },
  { id: 'mcp', title: 'settings.categories.mcp', component: McpSettings },
  { id: 'ui', title: 'settings.categories.ui', component: UiSettings },
];

const DEFAULT_CATEGORY = 'server';

export default function SettingsPage() {
  const { t } = useTranslation();
  const { category } = useParams();
  const navigate = useNavigate();
  // Einmalig laden (bleibt über Tab-Wechsel erhalten) → kein leer-blitzen beim Umschalten.
  const { settings, loading, error, saving, saved, save } = useSettings();

  const active =
    CATEGORIES.find((c) => c.id === category) ||
    CATEGORIES.find((c) => c.id === DEFAULT_CATEGORY);
  const ActiveComponent = active.component;

  return (
    <div className="settings-page">
      <div className="settings">
        <div className="settings__tabs" role="tablist" aria-label={t('settings.title')}>
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              role="tab"
              aria-selected={active.id === cat.id}
              className={`settings__tab${active.id === cat.id ? ' settings__tab--active' : ''}`}
              onClick={() => navigate(`/settings/${cat.id}`)}
            >
              {t(cat.title)}
            </button>
          ))}
        </div>
        <ActiveComponent
          settings={settings}
          loading={loading}
          error={error}
          saving={saving}
          saved={saved}
          save={save}
        />
      </div>
    </div>
  );
}
