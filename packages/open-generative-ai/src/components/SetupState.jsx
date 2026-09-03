// The first screen of a machine that cannot make anything yet.
//
// It used to be the Image studio's empty state — "Describe the image below and
// press Generate" over a Generate button that had nothing to run, and a MUAPI
// key modal waiting behind the press. Three separate wrongs: the invitation is
// false, the wall arrives after the click instead of before it, and the wall
// belongs to a third party rather than to this product.
//
// So: three doors, in the order the owner would want them chosen, each of which
// can be finished HERE. Credits first because it is the one that needs nothing
// installed and nothing pasted; the owner's own accounts second, repaired in
// place rather than by sending anyone to a settings page; this Mac third,
// because it is the one that takes a download.
//
// There is no dismiss. The state is derived (lib/setupReadiness.js) and
// vanishes the moment any source answers — a "seen" flag would only let someone
// hide a screen that is still telling the truth.
import { useState } from 'react';

import { getLang } from '../lib/i18n.js';
import { saveProviderKey } from '../lib/localProducer.js';
import { openPassBookForKey } from '../lib/passbookLink.js';
import { startOAuthLogin } from '../lib/providerReadiness.js';
import { refreshSetupReadiness, useSetupReadiness } from '../lib/setupReadiness.js';
import { useModelSources } from '../lib/useModelSources.js';
import { Button, Card, SectionLabel, TextInput, cx } from '../ui/kit.jsx';

const zh = () => getLang() === 'zh-CN';

const goToModels = () => window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'models' } }));

/**
 * One account that is not ready, and the single control that readies it.
 *
 * The key never touches this browser: it is posted to /api/passbook, which is
 * the machine's shared store, and is only ever asked about by name afterwards.
 */
function AccountRepair({ repair, onDone }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const kind = repair.action?.kind;
  const keyName = String(repair.action?.key || '');

  const saveKey = async (event) => {
    event.preventDefault();
    const secret = value.trim();
    if (!secret || !keyName) return;
    setBusy(true);
    try {
      await saveProviderKey(keyName, secret);
      setValue('');
      setNote(zh() ? '已保存到这台机器的共享凭据库。' : 'Saved to this machine’s shared store.');
      await onDone();
    } catch {
      setNote(zh() ? '这个密钥没能保存，请再试一次。' : 'That key could not be saved — try it again.');
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    setBusy(true);
    try {
      window.open(await startOAuthLogin(String(repair.action?.provider || '')), '_blank', 'noopener,noreferrer');
      setNote(zh()
        ? '在新标签页里完成登录，然后回到这里。'
        : 'Finish the sign-in in the tab that opened, then come back here.');
    } catch {
      setNote(zh() ? '无法开始登录。' : 'That sign-in could not be started.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line1 bg-bg2 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink1">{repair.label}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink3">{repair.detail}</span>
        {kind === 'oauth' ? (
          <Button size="sm" icon="external" loading={busy} onClick={signIn}>
            {repair.action.label || (zh() ? '登录' : 'Sign in')}
          </Button>
        ) : null}
      </div>
      {kind === 'key' || kind === 'muapi-key' ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={saveKey}>
          <span className="font-mono text-[11px] font-semibold text-ink2">{keyName || 'MUAPI_API_KEY'}</span>
          <TextInput
            type="password"
            autoComplete="off"
            className="min-w-[12rem] flex-1"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={zh() ? '粘贴密钥' : 'Paste the key'}
          />
          <Button size="sm" type="submit" variant="primary" disabled={busy || !value.trim()}>
            {busy ? (zh() ? '保存中…' : 'Saving…') : (zh() ? '保存' : 'Save')}
          </Button>
          <button
            type="button"
            className="text-[11px] text-ink3 underline-offset-2 hover:text-ink2 hover:underline"
            onClick={() => openPassBookForKey(keyName || 'MUAPI_API_KEY')}
          >
            {zh() ? '在 PassBook 中打开' : 'Open it in PassBook'}
          </button>
        </form>
      ) : null}
      {note ? <p className="text-[11px] leading-snug text-ink2">{note}</p> : null}
    </div>
  );
}

/**
 * The three doors on their own, so the topbar pill and the studio canvas offer
 * exactly the same set rather than drifting into two answers.
 */
export function SetupDoors({ compact = false }) {
  const readiness = useSetupReadiness();
  const { pickerProps } = useModelSources({ enabled: true });
  const [open, setOpen] = useState('');
  const repairs = readiness.repairs || [];
  const recheck = () => refreshSetupReadiness({ force: true });

  return (
    <div className="flex flex-col gap-2.5">
      <div className={cx('flex flex-wrap gap-2', compact && 'flex-col')}>
        <Button
          variant="primary"
          icon="logo"
          loading={pickerProps.linking}
          onClick={() => { setOpen(''); void Promise.resolve(pickerProps.onLink()).then(recheck); }}
        >
          {pickerProps.linking
            ? (zh() ? '等待 HivemindOS…' : 'Waiting for HivemindOS…')
            : (zh() ? '连接 HivemindOS' : 'Link HivemindOS')}
        </Button>
        <Button
          icon="key"
          aria-expanded={open === 'accounts'}
          onClick={() => setOpen(open === 'accounts' ? '' : 'accounts')}
        >
          {zh() ? '使用我自己的账户' : 'Use my own accounts'}
        </Button>
        <Button icon="cpu" onClick={goToModels}>
          {zh() ? '使用这台 Mac 上的模型' : 'Use models on this Mac'}
        </Button>
      </div>

      {open === 'accounts' ? (
        <div className="flex flex-col gap-2">
          {repairs.length ? (
            repairs.map((repair) => (
              <AccountRepair key={repair.provider} repair={repair} onDone={recheck} />
            ))
          ) : (
            <p className="text-[12px] leading-relaxed text-ink2">
              {zh()
                ? '这台机器还没有列出任何可连接的账户。先连接 HivemindOS，或者在 PassBook 里添加一个密钥。'
                : 'This machine is not listing any accounts to connect yet. Link HivemindOS, or add a key in PassBook.'}
              {' '}
              <button
                type="button"
                className="underline-offset-2 hover:text-ink1 hover:underline"
                onClick={() => openPassBookForKey('')}
              >
                {zh() ? '打开 PassBook' : 'Open PassBook'}
              </button>
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Setup state as a studio shows it: the sentence, the three doors, and
 * nothing that pretends a source exists.
 */
export default function SetupState() {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <SectionLabel>{zh() ? '先选一个来源' : 'Pick a source first'}</SectionLabel>
        <p className="text-[13px] leading-relaxed text-ink2">
          {zh()
            ? '这台机器还没有可以生成的来源。三条路都能在这里走完 —— 选一条，工作室就会自己变成正常的样子。'
            : 'Nothing on this machine can generate yet. Any one of these three finishes here, and the studio turns back into itself the moment one answers.'}
        </p>
      </div>
      <SetupDoors />
    </Card>
  );
}
