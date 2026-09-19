// The Settings page's shape logic — the parts that decide what a person is told.
//
// The one that matters is `sourceNote`: when an environment variable on this
// machine holds a different value than the settings document, the page has to
// say so and name the variable. "Saved" there would be a lie the row underneath
// immediately contradicts, and the person would have no way to find out why
// their change did nothing.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/lib/machineSettings.js');

const row = (over = {}) => ({
  key: 'network.gateway_url',
  section: 'network',
  field: 'gateway_url',
  kind: 'url',
  value: 'http://127.0.0.1:8787',
  default: 'http://127.0.0.1:8787',
  source: 'default',
  restart_required: false,
  env: ['CONTENT_STUDIO_GATEWAY_URL', 'ZIMG_GATEWAY_URL'],
  env_override: '',
  summary: 'Where the media gateway answers.',
  ...over,
});

test('the page has the sections the release plan names, in order', async () => {
  const { SETTINGS_SECTIONS } = await load();
  assert.deepEqual(
    SETTINGS_SECTIONS.map((section) => section.id),
    ['general', 'generation', 'storage', 'workspace', 'privacy', 'advanced', 'about'],
  );
  // Every machine section in the schema is rendered somewhere; a section with
  // no home would be a knob nobody can reach.
  const covered = SETTINGS_SECTIONS.flatMap((section) => section.machine || []);
  assert.deepEqual([...covered].sort(), ['lanes', 'network', 'paths', 'privacy', 'reaper']);
});

test('a value an environment variable is pinning is named, with the fix', async () => {
  const { sourceNote } = await load();

  assert.equal(sourceNote(row()), null, 'a default needs no badge');
  assert.equal(sourceNote(row({ source: 'file', value: 'http://gateway:8787' })).label, 'Changed');

  const pinned = sourceNote(row({ source: 'env', env_override: 'ZIMG_GATEWAY_URL', value: 'http://elsewhere:8787' }));
  assert.equal(pinned.tone, 'warn');
  assert.match(pinned.detail, /ZIMG_GATEWAY_URL/);
  // Never present a problem without its fix.
  assert.match(pinned.detail, /stack-local\.env/);
});

test('rows land in the section that renders them', async () => {
  const { SETTINGS_SECTIONS, sectionRows } = await load();
  const payload = {
    settings: [
      row({ key: 'paths.models_root', section: 'paths' }),
      row({ key: 'lanes.ltx', section: 'lanes' }),
      row(),
      row({ key: 'reaper.autoreap', section: 'reaper' }),
      row({ key: 'privacy.output_encryption', section: 'privacy' }),
    ],
  };
  const find = (id) => SETTINGS_SECTIONS.find((section) => section.id === id);
  assert.deepEqual(sectionRows(payload, find('storage')).map((r) => r.key), ['paths.models_root', 'lanes.ltx']);
  assert.deepEqual(sectionRows(payload, find('advanced')).map((r) => r.key), ['network.gateway_url', 'reaper.autoreap']);
  assert.deepEqual(sectionRows(payload, find('privacy')).map((r) => r.key), ['privacy.output_encryption']);
  // A section built from something other than the settings document asks for
  // nothing rather than for everything.
  assert.deepEqual(sectionRows(payload, find('about')), []);
  assert.deepEqual(sectionRows(null, find('storage')), []);
});

test('a key reads as a label, a value reads as its type', async () => {
  const { settingLabel, displayValue, isDefault } = await load();
  assert.equal(settingLabel(row({ key: 'paths.models_root', field: 'models_root' })), 'Models folder');
  // A key with no hand-written label still reads as words, never as an identifier.
  assert.equal(settingLabel({ key: 'paths.new_thing', field: 'new_thing' }), 'New thing');

  assert.equal(displayValue(row({ kind: 'bool', value: true })), true);
  assert.equal(displayValue(row({ kind: 'int', value: '8765' })), 8765);
  assert.equal(displayValue(row({ value: 'http://x:1' })), 'http://x:1');

  assert.equal(isDefault(row()), true);
  assert.equal(isDefault(row({ value: 'http://elsewhere:8787' })), false);
});

test('only the keys that need a restart raise the restart affordance', async () => {
  const { restartPending } = await load();
  assert.deepEqual(restartPending({ restart_required: ['paths.models_root'] }), ['paths.models_root']);
  assert.deepEqual(restartPending({ restart_required: [] }), []);
  assert.deepEqual(restartPending({}), []);
});

test('an export is named for the day it was taken', async () => {
  const { settingsFilename } = await load();
  assert.equal(settingsFilename(new Date('2026-09-04T10:00:00Z')), 'hivemind-studio-settings-2026-09-04.json');
});
