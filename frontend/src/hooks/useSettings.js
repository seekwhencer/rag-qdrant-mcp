import { useCallback, useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../api/settings.js';

/**
 * Lädt die Settings vom Server und speichert Änderungen.
 * Der Server liest die Werte dynamisch → Änderungen wirken sofort.
 */
export default function useSettings() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSettings();
      setSettings(data);
    } catch (err) {
      setError(err.message || 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async (patch) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await updateSettings(patch);
      // Reload to get the authoritative state from the server.
      const data = await getSettings();
      setSettings(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      return result;
    } catch (err) {
      setError(err.message || 'Failed to save settings');
      throw err;
    } finally {
      setSaving(false);
    }
  }, []);

  return { settings, loading, saving, error, saved, load, save };
}
