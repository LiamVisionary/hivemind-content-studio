// Models view — the model manager, native.
//
// This used to be an iframe into the legacy Media Studio control panel: a whole
// second app inside the page, with its own sidebar, its own password gate and its
// own theme, reachable only while that Next.js frontend was up. It is now three
// tabs on the same design system as the rest of the hub, talking to the /local-ai
// bridge directly:
//   Models     — local workflows the studios can generate with, and a way into them
//   Installed  — every weight file on disk, searchable
//   Discover   — Civitai search and install
//
// Data loads on first activation (the hub keeps every view mounted forever) and
// refreshes after a download lands, so a newly installed model appears without a
// manual reload.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mapHivemindWorkflowModels } from '../../lib/hivemindStudio.js';
import { getLang } from '../../lib/i18n.js';
import { localAI } from '../../lib/localInferenceClient.js';
import { Button, IconButton, Segmented, Spinner } from '../../ui/kit.jsx';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { useHub } from '../hubData.js';
import { AssetDetail } from './models/AssetDetail.jsx';
import { CivitaiBrowser } from './models/CivitaiBrowser.jsx';
import { InstalledAssets } from './models/InstalledAssets.jsx';
import { RunnableModels } from './models/RunnableModels.jsx';

const zh = () => getLang() === 'zh-CN';

const TABS = () => [
  { value: 'models', label: zh() ? '模型' : 'Models' },
  { value: 'installed', label: zh() ? '已安装' : 'Installed' },
  { value: 'discover', label: zh() ? '发现' : 'Discover' },
];

export function ModelsView({ active }) {
  const hub = useHub();
  const [tab, setTab] = useState('models');
  const [models, setModels] = useState([]);
  const [library, setLibrary] = useState({ assets: [], stats: {}, baseModels: [] });
  const [civitaiBaseModels, setCivitaiBaseModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const loadedRef = useRef(false);

  // Video workflows live in the Media Studio MCP catalog, which the hub already
  // polls for the studios — so they come from there rather than a second fetch.
  const videoModels = useMemo(() => mapHivemindWorkflowModels(hub.simpleCatalog), [hub.simpleCatalog]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // A dead workflow catalog used to be swallowed into an empty Models tab
      // ("No matching models"); it is reported in the banner like the library.
      let modelsError = '';
      const [localModels, installed] = await Promise.all([
        localAI.listModels().catch((err) => { modelsError = err?.message || 'Could not read the local workflow catalog.'; return []; }),
        localAI.listLibrary(),
      ]);
      setModels(Array.isArray(localModels) ? localModels : []);
      setLibrary(installed);
      if (modelsError) setError(`Workflow catalog: ${modelsError}`);
    } catch (err) {
      setError(err.message || 'Could not reach the local model bridge.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    void load();
    void localAI.listCivitaiBaseModels().then(setCivitaiBaseModels);
  }, [active, load]);

  const runnableModels = useMemo(() => [...models, ...videoModels], [models, videoModels]);

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar
        kicker={zh() ? '本地运行时' : 'Local runtime'}
        title={zh() ? '模型' : 'Models'}
        right={
          <>
            {loading ? <Spinner size={14} className="text-honey" /> : null}
            <Segmented options={TABS()} value={tab} onChange={setTab} />
            <IconButton icon="refresh" label={zh() ? '重新扫描已安装的模型' : 'Rescan installed models'} onClick={() => void load()} />
          </>
        }
      />

      {error ? (
        <div className="flex items-center justify-between gap-3 border-b border-line1 bg-danger-tint px-4 py-2 md:px-5">
          <span className="min-w-0 truncate text-xs text-danger" title={error}>{error}</span>
          <Button size="sm" onClick={() => void load()}>{zh() ? '重试' : 'Retry'}</Button>
        </div>
      ) : null}

      {tab === 'models' ? (
        <RunnableModels models={runnableModels} loading={loading} />
      ) : tab === 'installed' ? (
        <InstalledAssets assets={library.assets} onOpenAsset={setSelected} />
      ) : (
        <CivitaiBrowser
          onInstalled={load}
          baseModelOptions={civitaiBaseModels.length ? civitaiBaseModels : library.baseModels}
        />
      )}

      {selected ? <AssetDetail asset={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
