// The model picker, for every place in the studio that runs a text model.
//
// There are two: the Story studio's producer and the prompt helper's dialog.
// They were separate, and the second one only ever offered models on this
// machine — so an owner with a ChatGPT plan could have the producer use it and
// then be told, one dialog over, that they had no models at all.
//
// One list, three sections, one price column. A section is a BILL — this
// machine's RAM, HivemindOS credits, the owner's own provider accounts — and
// every row says what one press costs in that bill's own terms, right-aligned,
// so the whole thing reads like a menu rather than four tabs of settings. The
// filter chips narrow to one section; search reaches every model in all of
// them, including the hundreds HivemindOS routes that the unfiltered list only
// summarises.
//
// The account strip, the key field and every readiness state live here so the
// two callers cannot drift. What a caller supplies is the catalog and the
// handlers (`useModelSources` builds both); what it gets back is one control.
import { useState } from 'react';

import {
  ACCOUNTS, ALL, accountConnected, accountsOf, costLine, creditsHome, detailLine,
  DRAFT_USAGE, featuredRows, HIVEMINDOS, hiddenVariants, isFreeCloudModel,
  isPaidCloudModel, modelsForAccount, modelsForTab, rateLine, recommendedId,
  rememberModelUse, remedyFor, rowFor, SECTIONS, sectionLine, sourceState, tabCounts,
} from '../lib/textModels.js';
import { Button, Pill, TextInput, cx } from '../ui/kit.jsx';

// Enough rows to browse without turning the picker into a page of its own.
const VISIBLE_MODELS = 40;
// What the unfiltered list shows per section before "show all" — small enough
// that all three sections are on screen at once, which is the point of a
// single list.
const FEATURED = 4;

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
 * The owner's provider accounts, as the first choice inside their section.
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
function AccountStrip({ catalog, selected, onSelect, onRemedy, busy, showConnected }) {
  const accounts = accountsOf(catalog);
  const connected = accounts.filter((account) => account.connected);
  const missing = accounts.filter((account) => !account.connected);
  if (!accounts.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {showConnected && connected.length ? (
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
          <span className="text-[11px] text-ink3">{connected.length ? 'Also available:' : 'Connect one:'}</span>
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

/** A state with its repair beside it — never a sentence with nothing to press. */
function Notice({ children, remedy, onRemedy }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn-tint p-2 text-[11px] text-ink2">
      <span>{children}</span>
      {remedy ? (
        <Button size="sm" className="ml-auto" onClick={() => onRemedy(remedy)}>{remedy.label}</Button>
      ) : null}
    </div>
  );
}

/** One model. Name and what differs on the left; what one press costs on the
 *  right. A div with role=radio rather than a <button>: a caller may put its
 *  own control INSIDE the row (the prompt helper's Unload sits there), and a
 *  button in a button is invalid HTML that a screen reader reads as one
 *  control. */
function ModelRow({ model, selected, recommended, showGroup, usage, onPick, action }) {
  const pick = () => { rememberModelUse(model.id); onPick(model.id); };
  const detail = detailLine(model);
  const rate = rateLine(model);
  return (
    <div
      role="radio"
      tabIndex={0}
      aria-checked={selected}
      onClick={pick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); }
      }}
      className={cx(
        'flex cursor-pointer items-center gap-3 rounded-md border px-2.5 py-1.5 text-left text-[12px] transition-colors',
        selected ? 'border-honey/60 bg-honey-tint' : 'border-line1 bg-bg2 hover:border-line2',
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold text-ink1">{model.name || model.id}</span>
          {model.id === recommended ? <Pill tone="honey" className="!h-5 !px-2 !text-[10px]">Default</Pill> : null}
          {isFreeCloudModel(model) ? <Pill tone="ok" className="!h-5 !px-2 !text-[10px]">Free</Pill> : null}
          {/* Which account pays, when several are listed together. */}
          {showGroup && model.source === ACCOUNTS ? <Pill className="!h-5 !px-2 !text-[10px]">{model.group}</Pill> : null}
        </span>
        {detail ? <span className="truncate text-[10px] text-ink3/80">{detail}</span> : null}
      </span>
      <span
        className={cx('shrink-0 text-right text-[11px] tabular-nums', isPaidCloudModel(model) || model.source === ACCOUNTS ? 'text-ink2' : 'text-ink3')}
        title={rate || undefined}
      >
        {costLine(model, usage)}
      </span>
      {action ? <span className="shrink-0">{action}</span> : null}
    </div>
  );
}

export function ModelSourcePicker({
  catalog, selectedId, tab = ALL, onTab, query, onQuery, onPick, onRemedy, onConnect, connecting,
  onLink, linking, account, onAccount, keyField, onKeySave, onKeyCancel, savingKey,
  // An optional control the caller renders INSIDE each row — the prompt
  // helper puts Unload there for a model that is holding RAM.
  rowAction = null,
  // The size of one press, for the estimate on every paid row.
  usage = DRAFT_USAGE,
}) {
  const [connectOpen, setConnectOpen] = useState(false);
  const counts = tabCounts(catalog);
  const total = SECTIONS.reduce((sum, section) => sum + (counts[section.id] || 0), 0);
  const filter = tab || ALL;
  const searching = Boolean(String(query || '').trim());
  const recommended = recommendedId(catalog);
  const selectedRow = rowFor(catalog, selectedId);
  const connected = accountConnected(catalog);
  const sections = filter === ALL ? SECTIONS : SECTIONS.filter((section) => section.id === filter);
  // The connect panel is offered before a paid press, not after a refusal: when
  // the owner is looking at the HivemindOS section, or has already chosen a
  // paid HivemindOS model without an account to charge it to.
  const needsConnect = !connected && sourceState(catalog, HIVEMINDOS).available
    && (connectOpen || filter === HIVEMINDOS || isPaidCloudModel(selectedRow));

  return (
    <div className="flex flex-col gap-2">
      {total > 8 ? (
        <TextInput
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder={`Search ${total.toLocaleString('en-US')} models`}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Where the model runs">
        {[{ id: ALL, label: 'All' }, ...SECTIONS].map((entry) => (
          <button
            key={entry.id || 'all'}
            type="button"
            role="tab"
            aria-selected={filter === entry.id}
            onClick={() => onTab(entry.id)}
            className={cx(
              'rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors',
              filter === entry.id ? 'border-honey/60 bg-honey-tint text-ink1' : 'border-line1 bg-bg2 text-ink3 hover:border-line2',
            )}
          >
            {entry.label}
            <span className="ml-1 text-[10px] font-normal text-ink3/80">
              {entry.id === ALL ? total : counts[entry.id]}
            </span>
          </button>
        ))}
      </div>

      <div className={cx('flex flex-col gap-3', filter === ALL && 'max-h-[26rem] overflow-y-auto pr-1')}>
        {sections.map((section) => {
          const state = sourceState(catalog, section.id);
          const remedy = state.available ? null : remedyFor(state.remedy);
          const narrowed = section.id === ACCOUNTS && filter === ACCOUNTS && account;
          const listed = narrowed
            ? modelsForAccount(catalog, account, query)
            : (filter === ALL && !searching)
              ? featuredRows(catalog, section.id, FEATURED).rows
              : modelsForTab(catalog, section.id, query);
          const shown = listed.slice(0, VISIBLE_MODELS);
          const all = counts[section.id] || 0;
          const held = filter === ALL && !searching ? all - shown.length : listed.length - shown.length;
          const pinned = hiddenVariants(catalog, section.id, narrowed ? account : '');
          const line = sectionLine(catalog, section.id);
          // Connected but empty-handed. Narrowed to the chosen account when
          // there is one, so choosing OpenRouter does not explain Venice.
          const brokenAccounts = section.id === ACCOUNTS
            ? accountsOf(catalog).filter((entry) => entry.connected && !entry.count
                && (!narrowed || entry.id === account))
            : [];
          // Nothing to say in the unfiltered list for a section that is working
          // and simply has no match for the search.
          if (searching && !shown.length && state.available) return null;

          return (
            <section key={section.id} className="flex flex-col gap-1.5" aria-label={section.label}>
              <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink2">{section.label}</span>
                {line ? <span className="text-[11px] text-ink3">{line}</span> : null}
                <span className="ml-auto flex items-center gap-2">
                  {section.id === HIVEMINDOS && state.available && !connected ? (
                    <button
                      type="button"
                      className="text-[11px] font-semibold text-honey hover:underline"
                      onClick={() => setConnectOpen((open) => !open)}
                    >
                      Connect account
                    </button>
                  ) : null}
                  {section.id === HIVEMINDOS && state.available && connected ? (
                    <button
                      type="button"
                      className="text-[11px] text-ink3 hover:text-ink2 hover:underline"
                      onClick={() => onRemedy(remedyFor('top-up'))}
                    >
                      Add credits
                    </button>
                  ) : null}
                </span>
              </header>
              {filter !== ALL ? (
                <p className="m-0 text-[11px] leading-snug text-ink3">
                  {section.blurb}
                  {section.id === HIVEMINDOS ? <span className="text-ink3/70"> {creditsHome(catalog)}</span> : null}
                </p>
              ) : null}

              {!state.available ? (
                <Notice remedy={remedy} onRemedy={onRemedy}>
                  {state.detail || 'This source is not available right now.'}
                </Notice>
              ) : null}

              {section.id === HIVEMINDOS && needsConnect ? (
                <ConnectAccount
                  busy={connecting}
                  linking={linking}
                  onConnect={onConnect}
                  onLink={onLink}
                  onTopUp={() => onRemedy(remedyFor('top-up'))}
                />
              ) : null}

              {section.id === ACCOUNTS ? (
                <AccountStrip
                  catalog={catalog}
                  selected={account}
                  onSelect={onAccount}
                  onRemedy={onRemedy}
                  busy={savingKey}
                  showConnected={filter === ACCOUNTS}
                />
              ) : null}
              {section.id === ACCOUNTS && keyField ? (
                <KeyField name={keyField} busy={savingKey} onSave={onKeySave} onCancel={onKeyCancel} />
              ) : null}
              {/* A connected account that came back with nothing has a reason
                  and a repair, and both belong here rather than in an empty
                  list. Without this the section shows "OpenRouter 0" and says
                  nothing at all — which reads as a key that was silently
                  rejected. */}
              {brokenAccounts.map((entry) => (
                <Notice key={entry.id} remedy={remedyFor(entry.remedy)} onRemedy={onRemedy}>
                  <b>{entry.label}</b> — {entry.detail || 'listed no models just now.'}
                </Notice>
              ))}

              {shown.length ? (
                <div role="radiogroup" aria-label={`${section.label} models`} className={cx('flex flex-col gap-1', filter !== ALL && shown.length > 8 && 'max-h-72 overflow-y-auto pr-1')}>
                  {shown.map((model) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      selected={selectedId === model.id}
                      recommended={recommended}
                      showGroup={!narrowed}
                      usage={usage}
                      onPick={onPick}
                      action={rowAction ? rowAction(model) : null}
                    />
                  ))}
                </div>
              ) : state.available && !brokenAccounts.length ? (
                <p className="m-0 text-[11px] text-ink3">
                  {searching ? 'Nothing here matches that.' : 'Nothing to offer here yet.'}
                </p>
              ) : null}

              {/* Never a silent cap — neither the display limit nor the folded pins. */}
              {held > 0 ? (
                <p className="m-0 text-[11px] text-ink3">
                  {filter === ALL && !searching ? (
                    <>
                      {held.toLocaleString('en-US')} more —{' '}
                      <button type="button" className="underline hover:text-ink2" onClick={() => onTab(section.id)}>
                        show all
                      </button>
                      {' '}or search above.
                    </>
                  ) : (
                    <>Showing {shown.length} of {listed.length} matches. Type more of the name to narrow it.</>
                  )}
                </p>
              ) : null}
              {filter !== ALL && !searching && pinned ? (
                <p className="m-0 text-[11px] text-ink3">
                  {pinned} dated and routing variant{pinned === 1 ? '' : 's'} of these models
                  {' '}({'“'}…-2025-08-07{'”'}, {'“'}:free{'”'}) are folded away. Search for one to pick it.
                </p>
              ) : null}
            </section>
          );
        })}
        {searching && sections.every((section) => !modelsForTab(catalog, section.id, query).length) ? (
          <p className="m-0 text-[12px] text-ink3">Nothing matches that.</p>
        ) : null}
      </div>
    </div>
  );
}
