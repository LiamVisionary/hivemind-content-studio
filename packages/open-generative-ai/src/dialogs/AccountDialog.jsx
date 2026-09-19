// Your account: who you are here, and whether these credits can survive this machine.
//
// The honest framing, which this sheet is built around: the credits are NOT
// stored on this computer. They are a balance HivemindOS holds, and this
// install holds the only key to it. So the question is never "how do we sync
// credits" — it is "does anything but this machine know the key".
//
// Two answers, and only one of them is recoverable: an email (a six-digit code
// brings the account back on any device — nothing to lose), or the account key
// itself, written down by them. Lost is lost, and that is said on the button
// rather than in a footnote.
//
// WHAT THIS SHEET IS NOT, after the first attempt was exactly this: a stack of
// five bordered cards, each with an icon bubble, a shouted heading and two
// lines of explanation, all on screen at once. It read as a terms-of-service
// page. The rewrite holds three rules:
//
//   1. One thing is asked at a time, and the STATE decides which — four of
//      them, not two. We have not asked yet; we asked and could not be told;
//      there is no account; there is an account. The first version drew a
//      signed-out studio as a confident "No account yet" beside a name of three
//      dots, under a warning about losing credits nobody had, above three
//      buttons that every one of them errored on press.
//   2. Everything that is not that one thing is a row: closed, one line tall.
//   3. A sentence earns its place or it goes. The old warning said the same
//      thing twice in two paragraphs.
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import {
  formatCredits, linkEmailStart, linkEmailVerify, renameAccount, revealRecoveryKey,
  signInStart, signInVerify,
} from '../lib/account.js';
import { connectHivemindosAccount } from '../lib/localProducer.js';
import { t, tf } from '../lib/i18n.js';
import { Avatar, announceAccountChanged, useAccountOverview } from '../app/AccountRow.jsx';
import { Icon } from '../ui/icons.jsx';
import { Button, Skeleton, TextInput } from '../ui/kit.jsx';
import { Modal } from '../ui/Modal.jsx';

/* ---------------- pieces ---------------- */

/** A closed row is one line. Opening one closes the others: this sheet is a
 *  list of alternatives, not a form with five sections. */
function Row({ id, icon, label, open, onToggle, children }) {
  return (
    <div className="border-t border-line1">
      <button
        type="button"
        onClick={() => onToggle(open ? '' : id)}
        aria-expanded={open}
        // Each row is one of the sheet's alternatives and the only way into it,
        // so under a thumb the line grows to a full target rather than staying
        // the 35px a 13px label and 2.5 of padding come to.
        className="flex w-full touch:min-h-[44px] items-center gap-2.5 py-2.5 text-left text-ink2 transition-colors hover:text-ink1"
      >
        <Icon name={icon} size={14} className="shrink-0 text-ink3" />
        <span className="flex-1 truncate text-[13px]">{label}</span>
        <Icon name={open ? 'chevronUp' : 'chevronRight'} size={13} className="shrink-0 text-ink3" />
      </button>
      {open ? <div className="pb-3.5 pl-[26px]">{children}</div> : null}
    </div>
  );
}

/**
 * Ask for an address, then for the code that comes back. Used twice — attaching
 * an address to this account, and signing in to one that already exists — so
 * the two cannot drift apart.
 */
function CodeFlow({ actionLabel, onStart, onVerify, onDone }) {
  const [email, setEmail] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  const start = async (event) => {
    event?.preventDefault?.();
    setBusy(true);
    setFailure('');
    try {
      const result = await onStart(email.trim());
      setChallengeId(String(result?.challengeId || ''));
      toast.success(tf('account.codeSent', email.trim()));
    } catch (error) {
      setFailure(error?.message || t('failure.signInFailed'));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event) => {
    event?.preventDefault?.();
    setBusy(true);
    setFailure('');
    try {
      const result = await onVerify(challengeId, code.trim());
      setChallengeId('');
      setCode('');
      setEmail('');
      onDone?.(result);
    } catch (error) {
      setFailure(error?.message || t('failure.signInFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (challengeId) {
    return (
      <form onSubmit={verify} className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <TextInput
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            aria-label={t('account.codeLabel')}
            placeholder={t('account.codePlaceholder')}
            value={code}
            onChange={(event_) => { setCode(event_.target.value.replace(/\D/g, '')); setFailure(''); }}
            className="h-ctl-md flex-1 font-mono tracking-[0.28em]"
          />
          <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>
            {t('account.confirmCode')}
          </Button>
        </div>
        {failure ? <p className="text-[12px] text-danger">{failure}</p> : null}
        <button
          type="button"
          onClick={() => { setChallengeId(''); setFailure(''); }}
          className="self-start text-[12px] text-ink3 underline-offset-2 hover:text-ink1 hover:underline"
        >
          {t('account.changeEmail')}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={start} className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <TextInput
          type="email"
          autoComplete="email"
          aria-label={t('account.emailLabel')}
          placeholder={t('account.emailPlaceholder')}
          value={email}
          onChange={(event_) => { setEmail(event_.target.value); setFailure(''); }}
          className="h-ctl-md flex-1"
        />
        <Button type="submit" variant="primary" loading={busy} disabled={!email.trim()}>
          {actionLabel}
        </Button>
      </div>
      {failure ? <p className="text-[12px] text-danger">{failure}</p> : null}
    </form>
  );
}

function RecoveryKey() {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const reveal = async () => {
    setBusy(true);
    try {
      setKey(String((await revealRecoveryKey())?.key || ''));
    } catch (error) {
      toast.error(error?.message || t('failure.generic'));
    } finally {
      setBusy(false);
    }
  };

  if (!key) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[12px] leading-relaxed text-ink3">{t('account.keyHint')}</p>
        <Button variant="neutral" size="sm" icon="key" loading={busy} onClick={reveal} className="self-start">
          {t('account.keyReveal')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] leading-relaxed text-warn">{t('account.keyWarning')}</p>
      <code className="block break-all rounded-md border border-line1 bg-bg2 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink1">
        {key}
      </code>
      <div className="flex items-center gap-1.5">
        <Button
          variant="neutral"
          size="sm"
          icon="copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(key);
              toast.success(t('account.keyCopied'));
            } catch {
              toast.error(t('failure.generic'));
            }
          }}
        >
          {t('account.keyCopy')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setKey('')}>{t('account.keyHide')}</Button>
      </div>
    </div>
  );
}

/** Coming back to an account, by either door. */
function ComeBack({ onDone }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  const restore = async (event) => {
    event?.preventDefault?.();
    setBusy(true);
    setFailure('');
    try {
      await connectHivemindosAccount(value.trim());
      setValue('');
      toast.success(t('account.restored'));
      onDone?.();
    } catch (error) {
      setFailure(error?.message || t('failure.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] leading-relaxed text-ink3">{t('account.signInHint')}</p>
      <CodeFlow
        actionLabel={t('account.sendCode')}
        onStart={signInStart}
        onVerify={signInVerify}
        onDone={(result) => {
          toast.success(result?.mergedPreviousBalance ? t('account.signedInMerged') : t('account.signedIn'));
          onDone?.();
        }}
      />
      <form onSubmit={restore} className="flex flex-col gap-2 border-t border-line1 pt-3">
        <p className="text-[12px] leading-relaxed text-ink3">{t('account.restoreHint')}</p>
        <div className="flex items-start gap-2">
          <TextInput
            type="password"
            aria-label={t('account.restoreTitle')}
            placeholder={t('account.keyPlaceholder')}
            value={value}
            onChange={(event_) => { setValue(event_.target.value); setFailure(''); }}
            className="h-ctl-md flex-1 font-mono"
          />
          <Button type="submit" variant="neutral" loading={busy} disabled={!value.trim()}>
            {t('account.restore')}
          </Button>
        </div>
        {failure ? <p className="text-[12px] text-danger">{failure}</p> : null}
      </form>
    </div>
  );
}

function Rename({ identity, onDone }) {
  const [value, setValue] = useState(identity?.handle || '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  // The sheet outlives one read of the account (a sign-in changes the derived
  // name under it), so the field follows the name it is editing.
  useEffect(() => { setValue(identity?.handle || ''); }, [identity?.handle]);

  const save = async (next) => {
    setBusy(true);
    setFailure('');
    try {
      await renameAccount(next);
      toast.success(t('account.renamed'));
      onDone?.();
    } catch (error) {
      setFailure(error?.message || t('failure.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => { event.preventDefault(); void save(value.trim()); }}
    >
      <div className="flex items-start gap-2">
        <TextInput
          maxLength={24}
          aria-label={t('account.renameLabel')}
          value={value}
          onChange={(event_) => { setValue(event_.target.value); setFailure(''); }}
          className="h-ctl-md flex-1"
        />
        <Button
          type="submit"
          variant="neutral"
          loading={busy}
          disabled={!value.trim() || value.trim() === identity?.handle}
        >
          {t('account.rename')}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <p className="flex-1 text-[12px] text-ink3">{failure || t('account.renameHint')}</p>
        {identity?.handleIsCustom ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save('')}
            className="shrink-0 text-[12px] text-ink3 underline-offset-2 hover:text-ink1 hover:underline"
          >
            {t('account.renameReset')}
          </button>
        ) : null}
      </div>
    </form>
  );
}

/* ---------------- the sheet ---------------- */

export function AccountDialog({ onClose, onOpenCredits }) {
  const { overview, loaded, failed, known, refresh } = useAccountOverview();
  const identity = overview?.identity;
  const credits = overview?.credits;
  const [section, setSection] = useState('');

  const changed = useCallback(() => {
    refresh();
    announceAccountChanged();
  }, [refresh]);

  // Not asked yet. A skeleton of the sheet it is about to become, rather than a
  // spinner in the middle of an empty box: the shapes say what is coming, and
  // nothing moves when the answer lands.
  if (!loaded) {
    return (
      <Modal open onClose={onClose} title={t('account.title')} size="md">
        <div className="flex flex-col" aria-busy="true" aria-label={t('account.title')}>
          <div className="flex items-center gap-3 pb-4">
            <Skeleton rounded="rounded-full" className="h-10 w-10 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-2.5 w-20" />
            </span>
            <Skeleton className="h-ctl-md w-28 shrink-0" />
          </div>
          <Skeleton className="h-[76px] w-full" />
          <div className="mt-3 flex flex-col">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-2.5 border-t border-line1 py-3">
                <Skeleton rounded="rounded-sm" className="h-3.5 w-3.5 shrink-0" />
                <Skeleton className="h-2.5 w-36" />
              </div>
            ))}
          </div>
        </div>
      </Modal>
    );
  }

  // Asked, and could not be told — a locked studio, a stopped one, no network.
  // Nothing below would be true, so none of it is drawn: least of all a warning
  // about credits we cannot see.
  if (failed || !known) {
    return (
      <Modal open onClose={onClose} title={t('account.title')} size="md">
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="text-[13px] leading-relaxed text-ink2">{t('account.unavailable')}</p>
          <Button variant="neutral" icon="refresh" onClick={refresh}>{t('common.tryAgain')}</Button>
        </div>
      </Modal>
    );
  }

  const connected = Boolean(identity?.connected);
  const backedUp = Boolean(identity?.emailLinked);

  return (
    <Modal open onClose={onClose} title={t('account.title')} size="md">
      <div className="flex flex-col">
        {/* Who, and what they hold. One row, no card. */}
        <div className="flex items-center gap-3 pb-4">
          <Avatar identity={connected ? identity : null} size={40} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold leading-tight text-ink1">
              {connected ? identity.handle : t('account.notConnected')}
            </p>
            <p className="mt-0.5 truncate text-[12px] leading-tight text-ink3">
              {connected ? tf('account.credits', formatCredits(credits?.credits)) : t('account.noAccountYet')}
            </p>
          </div>
          <Button variant="primary" icon="plus" onClick={onOpenCredits}>{t('failure.addCredits')}</Button>
        </div>

        {connected ? (
          <>
            {/* The one thing being asked. Amber while this key is the only copy
                in the world; a quiet confirmed line once it is not. */}
            {backedUp ? (
              <p className="flex items-center gap-2 rounded-md border border-ok/30 bg-ok-tint px-3 py-2 text-[12px] leading-relaxed text-ink2">
                <Icon name="shield" size={14} className="shrink-0 text-ok" />
                {tf('account.backedUpTo', identity.emailMasked)}
              </p>
            ) : (
              <div className="flex flex-col gap-2.5 rounded-md border border-warn/30 bg-warn/10 px-3 py-3">
                <p className="flex items-start gap-2 text-[12.5px] font-medium leading-relaxed text-ink1">
                  <Icon name="warning" size={14} className="mt-0.5 shrink-0 text-warn" />
                  {t('account.backupLocal')}
                </p>
                <p className="pl-[22px] text-[12px] leading-relaxed text-ink3">{t('account.emailHint')}</p>
                <div className="pl-[22px]">
                  <CodeFlow
                    actionLabel={t('account.sendCode')}
                    onStart={linkEmailStart}
                    onVerify={linkEmailVerify}
                    onDone={() => { toast.success(t('account.emailLinked')); changed(); }}
                  />
                </div>
              </div>
            )}

            <div className="mt-3 flex flex-col">
              <Row id="key" icon="key" label={t('account.keyTitle')} open={section === 'key'} onToggle={setSection}>
                <RecoveryKey />
              </Row>
              <Row id="signin" icon="cloud" label={t('account.signInTitle')} open={section === 'signin'} onToggle={setSection}>
                <ComeBack onDone={() => { setSection(''); changed(); }} />
              </Row>
              <Row id="name" icon="persona" label={t('account.rename')} open={section === 'name'} onToggle={setSection}>
                <Rename identity={identity} onDone={changed} />
              </Row>
            </div>
          </>
        ) : (
          // No account. Nothing to back up, nothing to reveal, nothing to warn
          // about — so the only door besides Add credits is the one that brings
          // an existing account here.
          <div className="flex flex-col">
            <Row id="signin" icon="cloud" label={t('account.signInTitle')} open={section === 'signin'} onToggle={setSection}>
              <ComeBack onDone={() => { setSection(''); changed(); }} />
            </Row>
          </div>
        )}

        <p className="mt-4 text-[12px] leading-relaxed text-ink3">
          {t('account.ecosystemHint')}
          {identity?.source === 'app' ? ` ${t('account.fromApp')}` : ''}
        </p>
      </div>
    </Modal>
  );
}
