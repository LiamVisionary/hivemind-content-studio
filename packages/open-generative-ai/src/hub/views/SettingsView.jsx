// Settings — the machine's knobs, in the app, for a build that has no terminal.
//
// Everything here used to be an environment variable: a person who wanted their
// models on an external drive, a different port, or output encryption off had to
// hand-write `stack-local.env` and restart launchd. The rows below are the typed
// allow-list in `src/hivemind_content_studio/settings.py`, fetched from
// `GET /api/settings` with each value's SOURCE — so a variable pinned on this
// machine is named rather than silently beating the person's choice.
//
// **Settings is never the only door.** Nothing a first-time user needs lives
// only on this page:
// - the MUAPI key is asked for by AuthModal at the moment a generation needs it;
// - local models are managed on the Models page (this page embeds the same
//   manager for continuity with the old dialog, not as their only home);
// - the completion chime has its toggle in every studio (CompletionPingToggle);
// - a missing ComfyUI is a setup card on the Models page, not a hunt for a URL.
// What this page adds is one place to SEE all of it, and the only place some of
// it can be changed at all.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { STUDIO_RESTART_COMMAND } from '../../app/statusStore.js';
import { t, zh } from '../../lib/i18n.js';
import { isHostedLocalAI, isLocalAIAvailable } from '../../lib/localInferenceClient.js';
import {
  SETTINGS_SECTIONS, displayValue, isDefault, restartPending, sectionRows, settingLabel,
  settingsFilename, sourceNote,
} from '../../lib/machineSettings.js';
import { muapiKeyIsOnServer } from '../../lib/modelRunner.js';
import { browserMuapiKey, forgetBrowserMuapiKey, storeMuapiKey } from '../../lib/muapiKey.js';
import {
  STUDIO_PREFERENCE_KEYS, exportPrefs, importPrefs, prefsWereUnreadable, resetPrefs,
  resetStudioPreferences, setPrefs, subscribePrefs, pref,
} from '../../lib/prefs.js';
import { LocalModelManager } from '../../dialogs/LocalModelManager.jsx';
import { Icon } from '../../ui/icons.jsx';
import { ConfirmModal } from '../../ui/Modal.jsx';
import {
  Button, Card, Field, NativeSelect, Pill, SectionLabel, Spinner, TextInput, Toggle, cx,
} from '../../ui/kit.jsx';
import { HubToolbar } from '../components/HubToolbar.jsx';
import { api, toastFailed } from '../hubData.js';

const STUDIO_LABELS = { image: 'Image', video: 'Video', lipsync: 'Lip sync' };

/** Read one studio's saved generation defaults for the read-out below. Never
 *  the prompt: the studios strip that before they persist (AGENTS.md). */
function studioDefaults(studio) {
  try {
    const parsed = JSON.parse(localStorage.getItem(STUDIO_PREFERENCE_KEYS[studio]) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const shown = [parsed.modelId || parsed.model, parsed.aspectRatio || parsed.aspect, parsed.resolution]
      .filter((value) => typeof value === 'string' && value.trim());
    return shown.length ? shown.join(' · ') : null;
  } catch {
    return null;
  }
}

function SettingRow({ row, busy, onChange }) {
  const note = sourceNote(row, zh());
  const label = settingLabel(row);
  const [draft, setDraft] = useState(() => displayValue(row));
  // The row is the source of truth; a save (or somebody else's save) rewrites it.
  useEffect(() => { setDraft(displayValue(row)); }, [row.value]);

  const commit = (value) => {
    if (String(value) === String(row.value)) return;
    onChange(row.key, value);
  };

  return (
    <div className="flex flex-col gap-1.5 border-b border-line1 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-ink1">{label}</span>
        {note ? <Pill tone={note.tone}>{note.label}</Pill> : null}
        {row.restart_required ? (
          <span className="text-[11px] text-ink3">{zh() ? '需要重启' : 'needs a restart'}</span>
        ) : null}
      </div>
      <p className="text-xs leading-relaxed text-ink3">{row.summary}</p>
      {row.kind === 'bool' ? (
        <div className="pt-0.5">
          <Toggle checked={Boolean(draft)} disabled={busy} onChange={(next) => commit(next)} label={label} />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <TextInput
            value={draft}
            disabled={busy}
            type={row.kind === 'int' ? 'number' : 'text'}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          />
          {!isDefault(row) ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onChange(row.key, null)}>
              {zh() ? '恢复默认' : 'Default'}
            </Button>
          ) : null}
        </div>
      )}
      {note?.detail ? <p className="text-xs leading-relaxed text-warn">{note.detail}</p> : null}
    </div>
  );
}

function Group({ title, hint, children, right }) {
  return (
    <Card className="flex flex-col gap-1 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <SectionLabel>{title}</SectionLabel>
          {hint ? <p className="mt-1 text-xs leading-relaxed text-ink3">{hint}</p> : null}
        </div>
        {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
      </div>
      <div className="mt-1">{children}</div>
    </Card>
  );
}

// `initialSettings` and `initialSection` are the test seam: the rows only exist
// once GET /api/settings has answered, and effects do not run under the static
// render the hub smoke tests use — so without a way in, the whole table below
// would be unrendered code. The app passes neither.
export function SettingsView({ active, initialSettings = null, initialSection = 'general' }) {
  const [payload, setPayload] = useState(initialSettings);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restart, setRestart] = useState([]);
  const [version, setVersion] = useState(null);
  const [section, setSection] = useState(initialSection);
  const [confirm, setConfirm] = useState(null);
  const [prefsEpoch, setPrefsEpoch] = useState(0);
  const [studioEpoch, setStudioEpoch] = useState(0);
  const [apiKey, setApiKey] = useState(() => browserMuapiKey());
  const fileRef = useRef(null);
  const loaded = useRef(false);

  useEffect(() => subscribePrefs(() => setPrefsEpoch((n) => n + 1)), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settings, identity] = await Promise.all([
        api('/api/settings'),
        api('/api/version').catch(() => null),
      ]);
      setPayload(settings);
      if (identity) setVersion(identity);
    } catch (error) {
      toastFailed(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active || loaded.current) return;
    loaded.current = true;
    void load();
  }, [active, load]);

  const save = useCallback(async (key, value) => {
    setSaving(true);
    try {
      const body = value === null ? { reset: [key] } : { values: { [key]: value } };
      const result = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
      setPayload(result);
      const pending = restartPending(result);
      if (pending.length) setRestart((current) => [...new Set([...current, ...pending])]);
      if ((result.pinned || []).includes(key)) {
        // Saved, but something on this machine still wins. Saying "Saved" alone
        // would be a lie the row underneath then contradicts.
        toast(zh() ? '已保存，但被环境变量覆盖。' : 'Saved — but an environment variable on this machine still overrides it.');
      } else if (!pending.length) {
        toast.success(zh() ? '已保存' : 'Saved');
      }
    } catch (error) {
      toastFailed(error);
      // Put the row back to what the server actually holds.
      void load();
    } finally {
      setSaving(false);
    }
  }, [load]);

  const saveKey = async (event) => {
    event?.preventDefault?.();
    const key = apiKey.trim();
    if (!key) {
      if (browserMuapiKey()) {
        forgetBrowserMuapiKey();
        toast.success(zh() ? '已移除 API 密钥' : 'API key removed');
        return;
      }
      toast.error(t('settings.invalidKey'));
      return;
    }
    try {
      const { where } = await storeMuapiKey(key);
      toast.success(where === 'machine'
        ? (zh() ? '密钥已保存到本机的共享凭据库' : 'Key saved to this machine’s shared store')
        : (zh() ? '已保存 API 密钥' : 'API key saved'));
    } catch (error) {
      toast.error(error?.detail?.message || error?.message || t('settings.invalidKey'));
    }
  };

  const doExport = () => {
    try {
      const blob = new Blob([JSON.stringify(exportPrefs(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = settingsFilename();
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      toast.success(zh() ? '已导出设置' : 'Settings exported');
    } catch {
      toast.error(zh() ? '无法导出设置。' : 'The studio could not write that file. Check that downloads are allowed for this page.');
    }
  };

  const doImport = async (file) => {
    if (!file) return;
    try {
      const restored = importPrefs(JSON.parse(await file.text()));
      setStudioEpoch((n) => n + 1);
      toast.success(restored.studios.length
        ? `${zh() ? '已导入设置和' : 'Imported settings and '}${restored.studios.length}${zh() ? ' 个工作室' : ' studio defaults'}`
        : (zh() ? '已导入设置' : 'Imported settings'));
    } catch (error) {
      toast.error(error?.message || (zh() ? '那个文件不是设置导出。' : 'That file is not a studio settings export.'));
    }
  };

  const rowsFor = (pageSection) => sectionRows(payload, pageSection);
  const hasLocalAI = isLocalAIAvailable() && !isHostedLocalAI();
  const onMachine = muapiKeyIsOnServer();
  const chime = pref('completionPing');
  const studios = useMemo(
    () => Object.keys(STUDIO_PREFERENCE_KEYS).map((studio) => ({ studio, summary: studioDefaults(studio) })),
    // studioEpoch changes when a reset or an import rewrites the blobs.
    [studioEpoch, prefsEpoch],
  );
  const current = SETTINGS_SECTIONS.find((entry) => entry.id === section) || SETTINGS_SECTIONS[0];

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar
        kicker={zh() ? '这台机器' : 'This machine'}
        title={zh() ? '设置' : 'Settings'}
        subtitle={payload?.path || ''}
        right={(
          <Button variant="ghost" size="sm" icon="refresh" onClick={() => void load()} disabled={loading}>
            {zh() ? '刷新' : 'Refresh'}
          </Button>
        )}
      />

      {restart.length ? (
        // A restart-required key must never pretend it took effect. The fix is
        // in the same component as the problem: the command, ready to copy.
        <div className="flex flex-wrap items-center gap-3 border-b border-honey/50 bg-honey-tint/50 px-4 py-2.5 md:px-5">
          <Icon name="refresh" size={16} className="text-honey" />
          <span className="text-[13px] text-ink1">
            {zh()
              ? '已保存。重启工作室后生效。'
              : `Saved. ${restart.length === 1 ? 'That setting takes' : 'Those settings take'} effect after the studio restarts.`}
          </span>
          <code className="rounded-sm bg-bg0/80 px-2 py-1 font-mono text-[11px] text-ink2">{STUDIO_RESTART_COMMAND}</code>
          <Button
            variant="neutral"
            size="sm"
            icon="copy"
            onClick={async () => {
              try {
                if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
                await navigator.clipboard.writeText(STUDIO_RESTART_COMMAND);
                toast.success(zh() ? '已复制' : 'Copied');
              } catch {
                toast.error(zh() ? '无法复制，请手动选择该命令。' : 'Copying is not available here — select the command and copy it.');
              }
            }}
          >
            {zh() ? '复制命令' : 'Copy command'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRestart([])}>{zh() ? '知道了' : 'Dismiss'}</Button>
        </div>
      ) : null}

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <div className="hive-edge-fade flex gap-1 overflow-x-auto">
            {SETTINGS_SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSection(entry.id)}
                aria-current={entry.id === section ? 'true' : undefined}
                className={cx(
                  'shrink-0 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
                  entry.id === section ? 'bg-bg3 text-ink1' : 'text-ink3 hover:text-ink1',
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {loading && !payload ? (
            <div className="grid flex-1 place-items-center py-16"><Spinner size={22} className="text-ink2" /></div>
          ) : null}

          {payload?.readable === false ? (
            <Card className="border-warn/50 p-4">
              <SectionLabel>{zh() ? '设置文件无法读取' : 'The settings file could not be read'}</SectionLabel>
              <p className="mt-1 text-xs leading-relaxed text-ink3">
                {zh()
                  ? '工作室已使用默认值启动。在下方保存任意一项设置即可用一个可读的文件覆盖它。'
                  : 'The studio started on its defaults. Saving any setting below replaces the file with a readable one.'}
              </p>
            </Card>
          ) : null}

          {section === 'general' ? (
            <>
              <Group title={zh() ? '通用' : 'General'} hint={current.hint}>
                <div className="flex flex-col gap-3 pt-1">
                  <Field label={zh() ? '语言' : 'Language'} hint={zh() ? '此版本只提供英文界面。' : 'This build ships English only; a stored choice is kept for when the rest is translated.'}>
                    <NativeSelect value="en" disabled onChange={() => {}}>
                      <option value="en">English</option>
                    </NativeSelect>
                  </Field>
                  <label className="flex items-center justify-between gap-3 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
                    <span>
                      <b className="block text-[13px] font-medium text-ink1">{zh() ? '完成提示音' : 'Completion chime'}</b>
                      <small className="text-xs text-ink3">
                        {zh() ? '生成完成时播放提示音。每个工作室里也有同一个开关。' : 'A two-note chime when a generation lands. The same switch is in every studio.'}
                      </small>
                    </span>
                    <Toggle
                      checked={chime}
                      onChange={(next) => setPrefs({ completionPing: next })}
                      label={zh() ? '完成提示音' : 'Completion chime'}
                    />
                  </label>
                </div>
              </Group>

              <Group title={t('settings.apiKey')} hint={zh() ? 'MUAPI：云端生成使用的密钥。' : 'The MUAPI key the hosted lanes generate with.'}>
                {onMachine ? (
                  <div className="flex items-start justify-between gap-3 rounded-md border border-line1 bg-bg2 px-3.5 py-3">
                    <div>
                      <b className="block text-[13px] font-medium text-ink1">{t('settings.keyOnMachine')}</b>
                      <small className="text-xs leading-relaxed text-ink3">{t('settings.keyOnMachineNote')}</small>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'passbook' } }))}
                    >
                      {t('settings.manageKeys')}
                    </Button>
                  </div>
                ) : (
                  <form className="flex items-end gap-2 pt-1" onSubmit={saveKey}>
                    <Field
                      className="flex-1"
                      label={t('settings.muapiKeyLabel')}
                      hint={browserMuapiKey() ? `${t('settings.keyNote')} ${zh() ? '清空后保存即可移除。' : 'Clear the field and save to remove it.'}` : t('settings.keyNote')}
                    >
                      <TextInput
                        type="password"
                        placeholder={t('settings.keyPlaceholder')}
                        value={apiKey}
                        autoComplete="off"
                        onChange={(event) => setApiKey(event.target.value)}
                      />
                    </Field>
                    <Button variant="primary" type="submit">{t('common.save')}</Button>
                  </form>
                )}
              </Group>
            </>
          ) : null}

          {section === 'generation' ? (
            <Group title={zh() ? '生成默认值' : 'Generation defaults'} hint={current.hint}>
              <div className="flex flex-col">
                {studios.map(({ studio, summary }) => (
                  <div key={studio} className="flex items-center justify-between gap-3 border-b border-line1 py-3 last:border-b-0">
                    <div className="min-w-0">
                      <b className="block text-[13px] font-medium text-ink1">{STUDIO_LABELS[studio] || studio}</b>
                      <small className="block truncate font-mono text-[11px] text-ink3">
                        {summary || (zh() ? '仍是默认值' : 'still on the defaults')}
                      </small>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!summary}
                      onClick={() => setConfirm({
                        title: `${zh() ? '恢复默认：' : 'Reset '}${STUDIO_LABELS[studio] || studio}`,
                        body: zh()
                          ? '该工作室保存的模型、比例和调节将被清除，下次打开时回到默认值。你的作品不受影响。'
                          : 'The saved model, aspect and tuning for this studio go back to the defaults the next time it opens. Nothing you have made is touched.',
                        confirmLabel: zh() ? '恢复默认' : 'Reset',
                        run: () => {
                          resetStudioPreferences(studio);
                          setStudioEpoch((n) => n + 1);
                          toast.success(zh() ? '已恢复默认' : 'Back to the defaults');
                        },
                      })}
                    >
                      {zh() ? '恢复默认' : 'Reset'}
                    </Button>
                  </div>
                ))}
              </div>
            </Group>
          ) : null}

          {section === 'storage' ? (
            <>
              <Group title={zh() ? '文件夹' : 'Folders'} hint={current.hint}>
                <div className="flex flex-col">
                  {rowsFor(current).filter((row) => row.section === 'paths').map((row) => (
                    <SettingRow key={row.key} row={row} busy={saving} onChange={save} />
                  ))}
                </div>
              </Group>
              <Group title={zh() ? '本机引擎' : 'Local engines'} hint={zh() ? '关闭并不会让工作室出错，只是少一条本地车道。' : 'Off is a working studio with one fewer local lane, never an error.'}>
                <div className="flex flex-col">
                  {rowsFor(current).filter((row) => row.section === 'lanes').map((row) => (
                    <SettingRow key={row.key} row={row} busy={saving} onChange={save} />
                  ))}
                </div>
              </Group>
              {hasLocalAI ? (
                <Group title={t('settings.localModels')} hint={zh() ? '模型页是它们的主场；这里是同一个管理器。' : 'The Models page is their home; this is the same manager.'}>
                  <LocalModelManager />
                </Group>
              ) : null}
            </>
          ) : null}

          {section === 'workspace' ? (
            <Group title={zh() ? '工作区' : 'Workspace'} hint={current.hint}>
              <div className="flex flex-col gap-3 pt-1">
                <p className="text-xs leading-relaxed text-ink3">
                  {zh()
                    ? '每个工作区都有自己的保险库和媒体目录；删除工作区会连同其中的内容一起删除。切换或新建工作区在登录页。'
                    : 'Each workspace has its own vault and its own media folders, and deleting one deletes what is inside it. Switching or adding a workspace happens on the sign-in screen.'}
                </p>
                <div className="rounded-md border border-line1 bg-bg2 px-3.5 py-3">
                  <SectionLabel>{zh() ? '状态目录' : 'Studio state folder'}</SectionLabel>
                  <p className="mt-1 break-all font-mono text-[11px] text-ink2">
                    {payload?.settings?.find((row) => row.key === 'paths.data_dir')?.value || '—'}
                  </p>
                </div>
                <div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await api('/api/accounts/sign-out', { method: 'POST' });
                        window.location.reload();
                      } catch (error) { toastFailed(error); }
                    }}
                  >
                    {zh() ? '切换工作区' : 'Switch workspace'}
                  </Button>
                </div>
              </div>
            </Group>
          ) : null}

          {section === 'privacy' ? (
            <Group title={zh() ? '隐私与保险库' : 'Privacy & vault'} hint={current.hint}>
              <div className="flex flex-col">
                {rowsFor(current).map((row) => (
                  <SettingRow key={row.key} row={row} busy={saving} onChange={save} />
                ))}
              </div>
            </Group>
          ) : null}

          {section === 'advanced' ? (
            <>
              <Group title={zh() ? '网络' : 'Network'} hint={zh() ? '工作室各部分互相通信的地址。' : 'Where the studio’s own parts answer each other.'}>
                <div className="flex flex-col">
                  {rowsFor(current).filter((row) => row.section === 'network').map((row) => (
                    <SettingRow key={row.key} row={row} busy={saving} onChange={save} />
                  ))}
                </div>
              </Group>
              <Group title={zh() ? '租用的 GPU' : 'Rented GPUs'} hint={zh() ? '这是钱，不是清理工作。' : 'This one is money, not housekeeping: a box that failed to provision still bills.'}>
                <div className="flex flex-col">
                  {rowsFor(current).filter((row) => row.section === 'reaper').map((row) => (
                    <SettingRow key={row.key} row={row} busy={saving} onChange={save} />
                  ))}
                </div>
              </Group>
              <Group
                title={zh() ? '备份与重置' : 'Backup & reset'}
                hint={zh() ? '导出不含任何密钥、提示词或搜索文字。' : 'An export carries no keys, no prompts and no search text — only what this browser remembers about how you like things.'}
              >
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button variant="neutral" size="sm" icon="download" onClick={doExport}>
                    {zh() ? '导出设置' : 'Export settings'}
                  </Button>
                  <Button variant="neutral" size="sm" icon="upload" onClick={() => fileRef.current?.click()}>
                    {zh() ? '导入设置' : 'Import settings'}
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      void doImport(file);
                    }}
                  />
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirm({
                      title: zh() ? '重置所有偏好设置' : 'Reset every preference',
                      body: zh()
                        ? '语言、提示音、筛选器、面板状态和每个工作室保存的默认值都会回到初始状态。作品、凭据和这台机器的设置都不受影响。'
                        : 'Language, the chime, filters, panel state and every studio’s saved defaults go back to how they started. Your work, your credentials and this machine’s settings above are not touched.',
                      confirmLabel: zh() ? '全部重置' : 'Reset everything',
                      run: () => {
                        resetPrefs();
                        Object.keys(STUDIO_PREFERENCE_KEYS).forEach(resetStudioPreferences);
                        setStudioEpoch((n) => n + 1);
                        toast.success(zh() ? '已重置' : 'Preferences reset');
                      },
                    })}
                  >
                    {zh() ? '重置所有偏好设置' : 'Reset every preference'}
                  </Button>
                </div>
                {prefsWereUnreadable() ? (
                  <p className="mt-2 text-xs leading-relaxed text-warn">
                    {zh()
                      ? '保存的偏好设置无法读取，已恢复默认值。'
                      : 'Your saved preferences could not be read and have been reset to the defaults.'}
                  </p>
                ) : null}
              </Group>
            </>
          ) : null}

          {section === 'about' ? (
            <Group title={zh() ? '关于' : 'About'} hint="">
              <dl className="flex flex-col gap-2 pt-1 text-[13px]">
                {[
                  [zh() ? '产品' : 'Product', version?.product],
                  [zh() ? '版本' : 'Version', version?.version],
                  [zh() ? '提交' : 'Commit', version?.commit],
                  [zh() ? '构建日期' : 'Build date', version?.build_date],
                  [zh() ? '许可证' : 'Licence', version?.license],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="text-ink3">{label}</dt>
                    <dd className="truncate font-mono text-[12px] text-ink2">{value || '—'}</dd>
                  </div>
                ))}
              </dl>
              {version?.source_url ? (
                <p className="mt-3 text-xs leading-relaxed text-ink3">
                  {zh() ? '源代码：' : 'Source: '}
                  <a className="text-honey hover:underline" href={version.source_url} target="_blank" rel="noreferrer">
                    {version.source_url}
                  </a>
                </p>
              ) : null}
              <p className="mt-2 text-xs leading-relaxed text-ink3">
                {zh() ? '设置文件：' : 'Settings file: '}
                <code className="font-mono text-[11px] text-ink2">{payload?.path || '—'}</code>
              </p>
            </Group>
          ) : null}
        </div>
      </div>

      <ConfirmModal
        open={Boolean(confirm)}
        title={confirm?.title || ''}
        body={confirm?.body || ''}
        confirmLabel={confirm?.confirmLabel || (zh() ? '重置' : 'Reset')}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          confirm?.run?.();
          setConfirm(null);
        }}
      />
    </div>
  );
}
