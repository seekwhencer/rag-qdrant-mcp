import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export default function TopNav() {
  const { t } = useTranslation();
  const location = useLocation();
  const isDashboard = location.pathname.startsWith('/dashboard');
  const isSettings = location.pathname.startsWith('/settings');
  const isLogs = location.pathname.startsWith('/logs');

  return (
    <nav className="topnav" aria-label="Main">
      <NavLink
        to="/dashboard"
        className={() => `topnav__link${isDashboard ? ' topnav__link--active' : ''}`}
      >
        {t('nav.dashboard')}
      </NavLink>
      <NavLink
        to="/settings/server"
        className={() => `topnav__link${isSettings ? ' topnav__link--active' : ''}`}
      >
        {t('nav.settings')}
      </NavLink>
      <NavLink
        to="/logs"
        className={() => `topnav__link${isLogs ? ' topnav__link--active' : ''}`}
      >
        {t('nav.logs')}
      </NavLink>
      <NavLink
        to="/about"
        className={({ isActive }) => `topnav__link${isActive ? ' topnav__link--active' : ''}`}
      >
        {t('nav.about')}
      </NavLink>
    </nav>
  );
}
