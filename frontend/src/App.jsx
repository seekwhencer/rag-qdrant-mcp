import { useEffect } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import DashboardPage from './pages/DashboardPage.jsx';
import FilesPage from './pages/FilesPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import AboutPage from './pages/AboutPage.jsx';
import LogsPage from './pages/LogsPage.jsx';
import TopNav from './components/TopNav.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import LanguageSwitcher from './components/LanguageSwitcher.jsx';
import { useAppSettings } from './services/appSettings.js';
import { applyPrimaryHue } from './utils/primaryColor.js';
import { applySecondaryHue } from './utils/secondaryColor.js';
import { applyRadiusFactor } from './utils/radius.js';

export default function App() {
  const { primaryHue, secondaryHue, radiusFactor } = useAppSettings();

  // Primary color: replaces :root --color-primary (saturation + lightness fixed).
  useEffect(() => {
    applyPrimaryHue(primaryHue);
  }, [primaryHue]);

  // Secondary color: replaces :root --color-secondary (saturation + lightness fixed).
  useEffect(() => {
    applySecondaryHue(secondaryHue);
  }, [secondaryHue]);

  // Roundness: replaces :root --radius-factor (all --radius-* follow).
  useEffect(() => {
    applyRadiusFactor(radiusFactor);
  }, [radiusFactor]);

  return (
    <>
      <header className="topbar">
        <Link to="/about" className="topbar__brand">rag-qdrant-mcp</Link>
        <TopNav />
        <div className="topbar__actions">
          <ThemeToggle />
          <LanguageSwitcher />
        </div>
      </header>

      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/settings/:category?" element={<SettingsPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </>
  );
}
