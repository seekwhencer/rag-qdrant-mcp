import { useEffect, useState } from 'react';

/**
 * Verwaltet den Draft-State für eine Settings-Gruppe.
 * `settings` und `save` kommen von der Seite (einmalig geladen, bleibt über Tab-Wechsel erhalten).
 *
 * @param {string} groupKey - 'root' für Top-Level-Felder, sonst der Gruppen-Key
 *                            (z. B. 'qdrant', 'embeddings', 'chat', 'mcp')
 * @param {string[]} fieldKeys - Die Feld-Keys der Gruppe (stabile Referenz)
 * @param {object|null} settings - Geladene Settings (von der Seite)
 * @param {function} save - Save-Funktion (von der Seite)
 */
export default function useSettingsGroup(groupKey, fieldKeys, settings, save) {
  const buildDraft = () => {
    if (!settings) return null;
    const source = groupKey === 'root' ? settings : settings[groupKey];
    const d = {};
    for (const k of fieldKeys) d[k] = source?.[k];
    return d;
  };

  // Lazy-Init: erste Render hat direkt die Werte (kein leerer Frame beim Tab-Wechsel).
  const [draft, setDraft] = useState(buildDraft);

  // Bei Settings-Änderung (z. B. nach Save) Draft neu initialisieren.
  useEffect(() => {
    setDraft(buildDraft());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, groupKey]);

  const setField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const isLocked = (key) => settings?.envLocked?.[groupKey]?.[key];

  const handleSave = async () => {
    if (!draft) return;
    const patch = groupKey === 'root' ? { ...draft } : { [groupKey]: { ...draft } };
    await save(patch);
  };

  const handleReset = () => setDraft(buildDraft());

  return { draft, setField, isLocked, handleSave, handleReset };
}
