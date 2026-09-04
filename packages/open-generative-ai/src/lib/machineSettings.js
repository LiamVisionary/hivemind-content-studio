// The Settings page's shape logic, kept out of the JSX so node:test can run it.
//
// The control API answers a flat list of rows — key, section, value, default,
// source, restart_required — and the page groups them into the sections a
// person recognises. That grouping, the label for a key, and the reading of
// "where did this value come from" are the parts worth testing; the rendering
// is not.

/** The page's own sections, in order, and which machine sections each shows.
 *  A section with no `machine` list is built from something other than the
 *  settings document (preferences, the version payload). */
export const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', hint: 'Language, sounds and the key this browser uses.' },
  { id: 'generation', label: 'Generation defaults', hint: 'What each studio starts from.' },
  { id: 'storage', label: 'Models & storage', machine: ['paths', 'lanes'], hint: 'Where weights and finished work live on this Mac.' },
  { id: 'workspace', label: 'Workspace', hint: 'This studio and the folder it keeps its own state in.' },
  { id: 'privacy', label: 'Privacy & vault', machine: ['privacy'], hint: 'Encryption at rest, and who can read what.' },
  { id: 'advanced', label: 'Advanced', machine: ['network', 'reaper'], hint: 'Addresses, ports and the rental reaper.' },
  { id: 'about', label: 'About', hint: '' },
];

// Field names read better as sentences than as identifiers, and a few of them
// are not obvious at all (`ltx`, `mcp_url`), so they are named here rather than
// title-cased from the key.
const LABELS = {
  'paths.data_dir': 'Studio state folder',
  'paths.runs_dir': 'Productions folder',
  'paths.models_root': 'Models folder',
  'paths.output_root': 'Output folder',
  'paths.model_cache_dir': 'Model download cache',
  'lanes.ltx': 'LTX video lane',
  'lanes.flux2_server': 'Flux 2 image server',
  'lanes.apple_silicon_optimizations': 'Apple Silicon tuning',
  'network.control_host': 'Studio address',
  'network.control_port': 'Studio port',
  'network.gateway_url': 'Media gateway',
  'network.upload_base': 'Reference uploads',
  'network.bridge_url': 'Local inference bridge',
  'network.mcp_url': 'Agent tools',
  'network.comfy_url': 'ComfyUI',
  'privacy.output_encryption': 'Encrypt finished media',
  'privacy.agent_dual_seal': 'Seal agent outputs to the agent',
  'reaper.autoreap': 'Destroy boxes that failed to provision',
  'reaper.grace_seconds': 'Grace period (seconds)',
  'reaper.bad_machine_hours': 'Cooldown for a bad host (hours)',
};

export function settingLabel(row) {
  if (!row?.key) return '';
  return LABELS[row.key] || String(row.field || row.key).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Rows for one page section, in schema order. */
export function sectionRows(payload, section) {
  const wanted = section?.machine || [];
  if (!wanted.length) return [];
  const rows = Array.isArray(payload?.settings) ? payload.settings : [];
  return rows.filter((row) => wanted.includes(row.section));
}

/** Where this value came from, as a sentence a person can act on.
 *
 *  `env` is the only one that matters: the person changed something in the app,
 *  the app saved it, and a variable on this machine is still winning. Saying
 *  "saved" there would be a lie, so the badge names the variable and the file
 *  it is most likely set in.
 */
export function sourceNote(row, zh = false) {
  if (!row) return null;
  if (row.source === 'env') {
    return {
      tone: 'warn',
      label: zh ? '被环境变量覆盖' : 'Overridden',
      detail: zh
        ? `这台机器的 ${row.env_override} 环境变量优先于此设置。`
        : `${row.env_override} is set on this machine and wins over this setting. Remove it from stack-local.env (or the shell that started the studio) for your choice to take effect.`,
    };
  }
  if (row.source === 'file') return { tone: 'honey', label: zh ? '已更改' : 'Changed', detail: '' };
  return null;
}

/** The value as the control should show it. Paths and URLs are strings already;
 *  a number stays a number so an input can be type="number". */
export function displayValue(row) {
  if (!row) return '';
  if (row.kind === 'bool') return Boolean(row.value);
  if (row.kind === 'int') return Number(row.value);
  return String(row.value ?? '');
}

/** True when this row is back at what the schema says it should be. */
export function isDefault(row) {
  return row ? String(row.value) === String(row.default) : true;
}

/** Which of the keys just saved will not take effect until a restart. */
export function restartPending(response) {
  const keys = Array.isArray(response?.restart_required) ? response.restart_required : [];
  return keys.filter(Boolean);
}

/** The filename an export gets. Dated, because the point of an export is to
 *  have more than one. */
export function settingsFilename(now = new Date()) {
  const stamp = now.toISOString().slice(0, 10);
  return `hivemind-studio-settings-${stamp}.json`;
}
