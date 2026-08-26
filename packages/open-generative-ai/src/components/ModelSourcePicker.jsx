// The model picker, for every place in the studio that runs a text model.
//
// There are two: the Story studio's producer and the prompt helper's dialog.
// They were separate, and the second one only ever offered models on this
// machine — so an owner with a ChatGPT plan could have the producer use it and
// then be told, one dialog over, that they had no models at all.
//
// The tabs, the account strip, the key field and every readiness state live
// here so the two cannot drift. What a caller supplies is the catalog and the
// handlers (`useModelSources` builds both); what it gets back is one control.
import { useState } from 'react';

import {
  ACCOUNTS, accountConnected, accountsLine, accountsOf, creditsHome, creditsLine,
  HIVEMINDOS, hiddenVariants, LOCAL, localHeadroom, modelsForAccount, modelsForTab,
  recommendedId, remedyFor, sourceIdForTab, sourceState, statusLine,
  TABS, tabCounts,
} from '../lib/textModels.js';
import { Button, Pill, TextInput, cx } from '../ui/kit.jsx';

// Enough rows to browse without turning the picker into a page of its own.
const VISIBLE_MODELS = 40;

/**
 * Point the studio at the owner's HivemindOS account.
 *
 * Shown when there is no HivemindOS app on the machine to hold the key for us.
 * It is the SAME balance either way — a HivemindOS balance is an account, and
 * this is the key to it — so the copy promises exactly that and nothing more.
 * "Add credits" is underneath for someone who has never had a HivemindOS
 * account at all, because telling them to connect one they do not have would be
 * the same dead end as telling them to install an app they do not want.
 */
function ConnectAccount({ busy, linking, onConnect, onLink, onTopUp }) {
  const [key, setKey] = useState('');
  const [manual, setManual] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line1 bg-bg2 p-2">
      {/* The offered path first: the app on this machine hands its balance over
          after you approve it there. Pasting a key stays available underneath,
          because the app is not always the answer — and because a deep link that
          nothing handles fails silently, so there has to be somewhere to land. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] leading-snug text-ink2">
          Use the balance from HivemindOS on this machine.
        </span>
        <Button size="sm" className="ml-auto" icon="link" loading={linking} onClick={onLink}>
          {linking ? 'Waiting for HivemindOS…' : 'Connect HivemindOS'}
        </Button>
      </div>
      {!manual ? (
        <button
          type="button"
          className="self-start text-[10px] text-ink3 underline hover:text-ink2"
          onClick={() => setManual(true)}
        >
          Paste an account key instead
        </button>
      ) : null}
      {manual ? (
      <>
      <p className="text-[11px] leading-snug text-ink2">
        Paste your HivemindOS account key to spend the credits you already have. It is stored on
        this machine, not in this browser.
      </p>
      <div className="flex items-center gap-1.5">
        <TextInput
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="hmos_credit_…"
          className="font-mono !text-[11px]"
        />
        <Button size="sm" disabled={!key.trim() || busy} onClick={() => onConnect(key.trim())}>
          {busy ? 'Checking…' : 'Connect'}
        </Button>
      </div>
      </>
      ) : null}
      <p className="text-[10px] leading-snug text-ink3">
        No HivemindOS account yet?{' '}
        <button type="button" className="underline hover:text-ink2" onClick={onTopUp}>
          Add credits here
        </button>{' '}
        — that opens one, and a passkey on it lets every HivemindOS app spend the same balance.
      </p>
    </div>
  );
}

/**
 * The owner's provider accounts, as the first choice on their tab.
 *
 * Six connected accounts is several hundred models, and "search 657 models" is
 * not a decision anyone can make. So the account comes first — it is the thing
 * that differs (a different bill, a different privacy answer, a different
 * plan) — and the model list follows from it.
 *
 * Accounts that are NOT connected are shown too, quieter, each with the one
 * action that connects it. That is the whole discovery path for "the ChatGPT
 * plan I already pay for can write these scenes".
 */
function AccountStrip({ catalog, selected, onSelect, onRemedy, busy }) {
  const accounts = accountsOf(catalog);
  const connected = accounts.filter((account) => account.connected);
  const missing = accounts.filter((account) => !account.connected);
  if (!accounts.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {connected.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onSelect('')}
            className={cx(
              'rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors',
              selected ? 'border-line1 bg-bg2 text-ink3 hover:border-line2' : 'border-honey/60 bg-honey-tint text-ink1',
            )}
          >
            All
          </button>
          {connected.map((account) => (
            <button
              key={account.id}
              type="button"
              onClick={() => onSelect(account.id)}
              className={cx(
                'rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors',
                selected === account.id
                  ? 'border-honey/60 bg-honey-tint text-ink1'
                  : 'border-line1 bg-bg2 text-ink3 hover:border-line2',
              )}
            >
              {account.label}
              <span className="ml-1 text-[10px] font-normal text-ink3/80">{account.count}</span>
              {/* A connected account that could not be asked is not the same as
                  one that was never connected, and it does not get the same
                  button. Saying so here keeps the count honest. */}
              {account.connected && !account.count ? <span className="ml-1 text-warn">!</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {missing.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-ink3">Also available:</span>
          {missing.map((account) => {
            const remedy = remedyFor(account.remedy);
            return (
              <button
                key={account.id}
                type="button"
                disabled={busy || !remedy}
                onClick={() => remedy && onRemedy(remedy)}
                className="rounded-md border border-dashed border-line2 bg-transparent px-2 py-1 text-[11px] text-ink3 transition-colors hover:border-honey/50 hover:text-ink2 disabled:opacity-50"
              >
                {account.label}
                <span className="ml-1 text-[10px] text-ink3/70">{remedy?.label || 'not connected'}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One provider key, taken and stored on the machine.
 *
 * It goes to the shared credential store — the same `~/.hivemindos/.env` the
 * HivemindOS app reads — so a key added here is a key added for every Hive app
 * on this machine, and never a second copy in this browser. The field is a
 * password field and the value is never read back.
 */
function KeyField({ name, busy, onSave, onCancel }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-md border border-line1 bg-bg2 p-2"
      onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSave(name, value.trim()); }}
    >
      <span className="text-[11px] font-semibold text-ink2">{name}</span>
      <TextInput
        type="password"
        autoComplete="off"
        className="min-w-[14rem] flex-1"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Paste the key"
      />
      <Button size="sm" type="submit" disabled={busy || !value.trim()}>{busy ? 'Saving…' : 'Save'}</Button>
      <Button size="sm" type="button" onClick={onCancel}>Cancel</Button>
      <span className="w-full text-[10px] leading-snug text-ink3">
        Stored on this machine in the shared credential store, alongside HivemindOS’s own keys.
        It is never sent to HivemindOS and never kept in this browser.
      </span>
    </form>
  );
}

export function ModelSourcePicker({
  catalog, selectedId, tab, onTab, query, onQuery, onPick, onRemedy, onConnect, connecting,
  onLink, linking, account, onAccount, keyField, onKeySave, onKeyCancel, savingKey,
  // An optional control the caller renders INSIDE each row — the prompt
  // helper puts Unload there for a model that is holding RAM.
  rowAction = null,
}) {
  const counts = tabCounts(catalog);
  const state = sourceState(catalog, sourceIdForTab(tab));
  // On the accounts tab the account chosen above narrows the list; with none
  // chosen every connected account's models are offered at once.
  const rows = tab === ACCOUNTS && account
    ? modelsForAccount(catalog, account, query)
    : modelsForTab(catalog, tab, query);
  const remedy = state.available ? null : remedyFor(state.remedy);
  const meta = TABS.find((entry) => entry.id === tab) || TABS[0];
  const recommended = recommendedId(catalog);
  const line = tab === LOCAL ? localHeadroom(catalog)
    : tab === ACCOUNTS ? accountsLine(catalog)
    : creditsLine(catalog);
  // Connected but empty-handed. Narrowed to the chosen account when there is
  // one, so choosing OpenRouter does not explain Venice.
  const brokenAccounts = tab === ACCOUNTS
    ? accountsOf(catalog).filter((entry) => entry.connected && !entry.count
        && (!account || entry.id === account))
    : [];
  // A long list is searched, not scrolled: the cloud tab carries hundreds of
  // models and nobody finds one of those by dragging a scrollbar.
  const searchable = counts[tab] > 12;
  const shown = rows.slice(0, VISIBLE_MODELS);
  const pinned = hiddenVariants(catalog, tab, tab === ACCOUNTS ? account : '');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onTab(entry.id)}
            className={cx(
              'rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors',
              tab === entry.id ? 'border-honey/60 bg-honey-tint text-ink1' : 'border-line1 bg-bg2 text-ink3 hover:border-line2',
            )}
          >
            {entry.label}
            <span className="ml-1 text-[10px] font-normal text-ink3/80">{counts[entry.id]}</span>
          </button>
        ))}
        {line ? <span className="ml-auto text-[11px] text-ink3">{line}</span> : null}
      </div>

      <p className="text-[11px] leading-snug text-ink3">
        {meta.blurb}
        {tab === LOCAL || tab === ACCOUNTS
          ? null
          : <span className="text-ink3/70"> {creditsHome(catalog)}</span>}
      </p>

      {!state.available ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn-tint p-2 text-[11px] text-ink2">
          <span>{state.detail || 'This source is not available right now.'}</span>
          {remedy ? (
            <Button size="sm" className="ml-auto" onClick={() => onRemedy(remedy)}>{remedy.label}</Button>
          ) : null}
        </div>
      ) : null}

      {tab === ACCOUNTS ? (
        <AccountStrip
          catalog={catalog}
          selected={account}
          onSelect={onAccount}
          onRemedy={onRemedy}
          busy={savingKey}
        />
      ) : null}

      {tab === ACCOUNTS && keyField ? (
        <KeyField name={keyField} busy={savingKey} onSave={onKeySave} onCancel={onKeyCancel} />
      ) : null}

      {/* A connected account that came back with nothing has a reason and a
          repair, and both belong here rather than in an empty list. Without
          this the tab shows "OpenRouter 0" and says nothing at all — which
          reads as a key that was silently rejected. */}
      {tab === ACCOUNTS && brokenAccounts.length ? (
        <div className="flex flex-col gap-1.5">
          {brokenAccounts.map((entry) => {
            const fix = remedyFor(entry.remedy);
            return (
              <div
                key={entry.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn-tint p-2 text-[11px] text-ink2"
              >
                <span><b>{entry.label}</b> — {entry.detail || 'listed no models just now.'}</span>
                {fix ? (
                  <Button size="sm" className="ml-auto" onClick={() => onRemedy(fix)}>{fix.label}</Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Offered before a press, not after a refusal: every paid row on these
          tabs needs an account, so the way to connect one belongs here. */}
      {state.available && tab !== LOCAL && tab !== ACCOUNTS && !accountConnected(catalog) ? (
        <ConnectAccount
          busy={connecting}
          linking={linking}
          onConnect={onConnect}
          onLink={onLink}
          onTopUp={() => onRemedy('top-up')}
        />
      ) : null}

      {searchable ? (
        <TextInput
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder={`Search ${counts[tab]} models`}
        />
      ) : null}

      <div role="radiogroup" aria-label="Model" className={cx('grid gap-1.5 sm:grid-cols-2', shown.length > 8 && 'max-h-72 overflow-y-auto pr-1')}>
        {shown.map((model) => {
          const action = rowAction ? rowAction(model) : null;
          const pick = () => { rememberModelUse(model.id); onPick(model.id); };
          // A div with role=radio rather than a <button>: a caller may put its
          // own control INSIDE the row (the prompt helper's Unload sits there),
          // and a button in a button is invalid HTML that a screen reader reads
          // as one control.
          return (
            <div
              key={`${tab}:${model.id}`}
              role="radio"
              tabIndex={0}
              aria-checked={selectedId === model.id}
              onClick={pick}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); }
              }}
              className={cx(
                'flex cursor-pointer flex-col rounded-md border p-2 text-left text-[12px] transition-colors',
                selectedId === model.id ? 'border-honey/60 bg-honey-tint' : 'border-line1 bg-bg2 hover:border-line2',
              )}
            >
              <span className="flex items-center gap-1.5">
                <span className="truncate font-semibold text-ink1">{model.name || model.id}</span>
                {model.id === recommended ? <Pill tone="honey">Default</Pill> : null}
                {model.tier === 'free' && model.source === HIVEMINDOS ? <Pill tone="ok">Free</Pill> : null}
                {/* Which account pays, when several are listed together. */}
                {model.source === ACCOUNTS && !account ? <Pill>{model.group}</Pill> : null}
                {action ? <span className="ml-auto shrink-0">{action}</span> : null}
              </span>
              <span className="truncate text-[10px] text-ink3/80">{statusLine(model)}</span>
            </div>
          );
        })}
      </div>

      {/* Never a silent cap — neither the display limit nor the folded pins. */}
      {rows.length > shown.length ? (
        <p className="text-[11px] text-ink3">
          Showing {shown.length} of {rows.length} matches. Type more of the name to narrow it.
        </p>
      ) : null}
      {!query && pinned ? (
        <p className="text-[11px] text-ink3">
          {pinned} dated and routing variant{pinned === 1 ? '' : 's'} of these models
          {' '}({'\u201C'}…-2025-08-07{'\u201D'}, {'\u201C'}:free{'\u201D'}) are folded away. Search for one to pick it.
        </p>
      ) : null}
      {state.available && !rows.length ? (
        <p className="text-[12px] text-ink3">
          {query ? 'Nothing here matches that.' : 'Nothing to offer on this tab yet.'}
        </p>
      ) : null}
    </div>
  );
}
