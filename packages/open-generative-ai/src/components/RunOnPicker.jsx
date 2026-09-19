// "Runs on: This Mac · Z-Image Turbo — free, stays here"
//
// One control for a question every studio was asking differently. It replaces
// the Image and Video studios' Local / API / Rented segmented control, and it
// speaks the text producer's vocabulary, because that one was already right:
// a section is a BILL, and there are three of them.
//
//   This Mac            free, private, as fast as the hardware
//   HivemindOS credits  one balance, the same one the HivemindOS app spends
//   Your accounts       billed to an account you already pay for
//
// A rented GPU is not a fourth BILL. It is what This Mac's work is landing on
// right now, so it appears as the place NAME on the readout ("Runs on: RTX 5090
// · $0.42/hr") with the per-tab pin behind the readout as the override — the
// same pin the gateway honours, unchanged. There is no rented MODE to be in
// with nothing rented, which is what the old segment offered.
//
// It IS the fourth TAB, because those are different questions. Three bills is
// what the studio charges to; four tabs is what a person is choosing between,
// and "free on silicon you own" and "$0.42 every hour it stays attached" are
// not one choice however they are billed. The strip opens on Local when this
// machine can run something and on Hivemind when it cannot, so the free answer
// is the one already on screen wherever there is one.
//
// The default is Automatic (runTargets.pickRunTarget) and it says WHY in one
// line. One click overrides it, and the override is this tab's.
import { useState } from 'react';

import { RATING_LABELS, RATING_TONE } from '../lib/capabilityMatrix.js';
import {
  PLACE_HIVEMINDOS, PLACE_THIS_MAC, STARTS_FROM_EITHER, STARTS_FROM_IMAGE, STARTS_FROM_TEXT, STARTS_FROM_VIDEO,
  TAB_RENTAL, defaultRunTab, groupRunTargets, readoutText, runOnReadout,
  runTabsFor, runTypesFor, tabOfTarget, accountSectionsOf,
} from '../lib/runTargets.js';
import { creditsForUsd, formatCredits, routeForAttached } from '../lib/hostedQuote.js';
import { RentedSourceStatus } from '../studios/RentedSourceStatus.jsx';
import { t, tf } from '../lib/i18n.js';
import { Icon } from '../ui/icons.jsx';
import { Button, Pill, SectionLabel, cx } from '../ui/kit.jsx';
import { ChipButton, Menu, MenuHeading, MenuItem } from '../ui/Menu.jsx';

/**
 * What one row starts from, as the badge beside its name.
 *
 * Short on purpose: these sit next to the model's name and must lose to it on
 * width — "Image to image" twice as wide as the name it qualifies is a worse
 * row than no badge. The chips above the list carry the full words; this is
 * the same fact said in the space a row has.
 *
 * There used to be one badge per ENDPOINT, and only the hosted rail declares
 * those: `flux-3` wore "Text" and "Edit" side by side while the 107 MUAPI rows
 * under it wore nothing at all, so "no badge" meant both "starts from a
 * prompt" and "nobody said". Now the type is one badge, on every row that has
 * one, and a row with none is a row whose inventory declared nothing.
 */
function typeBadgeFor(target) {
  const label = {
    [STARTS_FROM_TEXT]: t('runOn.badgeText'),
    [STARTS_FROM_IMAGE]: t('runOn.badgeNeedsPicture'),
    [STARTS_FROM_EITHER]: t('runOn.typeHybrid'),
    [STARTS_FROM_VIDEO]: t('runOn.badgeNeedsClip'),
  }[target?.startsFrom || ''] || '';
  if (!label) return null;
  // A requirement is not a feature. "Edit" beside a model name reads as "this
  // one can also edit", which is how a prompt came to be typed into AI Ghibli
  // Style — a model whose entire upstream schema is one required picture and
  // no prompt field at all. The rows that cannot start from words are the ones
  // that have to be read, so only they are tinted.
  const needs = target.startsFrom === STARTS_FROM_IMAGE || target.startsFrom === STARTS_FROM_VIDEO;
  return { label, tone: needs ? 'info' : 'neutral' };
}

// The doors the type does not cover. A hosted row that also takes a clip or a
// soundtrack in is saying something "Hybrid" does not, and those two are the
// only capabilities the four types leave unsaid.
const EXTRA_CAPABILITY_LABELS = {
  'video-to-video': t('runOn.badgeFromVideo'),
  'audio-to-video': t('runOn.badgeFromAudio'),
};

/** One row: the model, where it runs, and — when it cannot — why not, on the
 *  row rather than at the press. */
function TargetRow({
  target, selected, onSelect, readiness = null, onFixReadiness = null, busyAction = '',
  priceContext = null,
  // The account above already named itself, said what is wrong and offered
  // the repair. A row under it that repeated all three is what made "Your
  // accounts" unreadable.
  accountSaid = false,
  // The machine card under this list already names the box and its hourly
  // rate. True when every row here is on that one box.
  machineSaid = false,
}) {
  // What one press on this row would cost, where a row can know.
  //
  // Only the hosted rail can, and its prices arrive WITH the catalogue: the
  // studio warms all 146 endpoints at boot and keeps them (see
  // hivemindos_hosted_media.warm_hosted_media_prices), so a row has its
  // figure the moment it is drawn. It used to ask per row as each scrolled
  // into view, and the numbers popped in one at a time down the list.
  //
  // The PRICE replaces the place on those rows rather than joining it —
  // "HivemindOS credits" beside a number in credits is the same word twice,
  // and the money is the thing being compared.
  const priced = Boolean(priceContext) && target.place === PLACE_HIVEMINDOS && target.ready;
  const route = priced ? routeForAttached(target.hostedRoutes, priceContext.kind, priceContext.attached) : null;
  const credits = route?.usd > 0 ? creditsForUsd(route.usd) : 0;
  // The place, never the provider id: "This Mac", "RTX 5090 · $0.42/hr",
  // "Your OpenAI account", "HivemindOS credits".
  const placeMetaLabel = target.machine
    ? (machineSaid ? '' : `${target.placeLabel} · $${(Number(target.machine.usd_per_hour) || 0).toFixed(2)}/hr`)
    // A row that IS its own place says it once, not twice. An account reachable
    // two ways names the door, or the two rows are one row printed twice.
    : [target.placeLabel === target.label ? '' : target.placeLabel, target.credentialLabel || '']
      .filter(Boolean).join(' · ');
  // On the one boot where the warm has not finished yet, a hosted row shows
  // nothing rather than the label the price is about to replace — the place
  // is already the tab's name, and printing it only to swap it a moment later
  // is the flicker this replaced.
  const meta = priced
    ? formatCredits(credits, { exact: route?.exact !== false })
    // The account is the line above; printing it again on all 125 of its rows
    // is the noise, not the information.
    : (accountSaid ? '' : placeMetaLabel);
  // Why the row is rated the way it is, or why it cannot run at all. It used to
  // live only on the fit picker's cards, and dropping it here would have made
  // this control worse than the two it replaces in Story and Sprite.
  const blocked = Boolean(readiness) && readiness.state !== 'ready' && !accountSaid;
  // The row's OWN reason always wins: a sprite that can only be animated on
  // this machine and a missing API key are two different refusals, and the
  // credential sentence used to replace the constraint that actually applied.
  // …and the row's own reason goes with it when the account gave it: "Needs a
  // MUAPI key." under every model is the same sentence as the account's.
  const note = target.ready ? (target.ratingReason || '') : (accountSaid ? '' : (target.reason || ''));
  // Said once. The readiness block adds its sentence only where it is not the
  // one already printed above it — the server's "Needs an OpenAI API key."
  // reaches the row both ways.
  const detail = blocked && readiness.detail && readiness.detail !== note ? readiness.detail : '';
  // A row nobody can press says why, always. The readiness block below carries
  // the state and the button; this is the tooltip for the row itself, so a
  // greyed line is never an unexplained one even when its reason is only the
  // readiness label.
  // The tooltip still carries the whole truth even where the row is bare:
  // a greyed line is never an unexplained one, whoever said why.
  const why = note
    || (readiness && readiness.state !== 'ready'
      ? [readiness.label, readiness.detail].filter(Boolean).join(' — ')
      : '');
  const actionKey = readiness?.action ? `${readiness.action.kind}:${readiness.action.provider || target.key}` : '';
  const typeBadge = typeBadgeFor(target);
  // Said once: a row whose type already IS "needs a clip" must not also wear
  // "From video".
  const extraCapabilities = target.startsFrom === STARTS_FROM_VIDEO
    ? []
    : (target.capabilities || []).filter((capability) => EXTRA_CAPABILITY_LABELS[capability]);
  return (
    <div className="flex flex-col">
      <MenuItem
        selected={selected}
        disabled={!target.ready}
        meta={meta}
        title={why}
        aria-label={why ? `${target.label} — ${why}` : target.label}
        onClick={() => { if (target.ready) onSelect(target); }}
      >
        <span className="flex min-w-0 flex-col">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="truncate">{target.label}</span>
            {target.badge ? (
              <Pill tone={target.badge.tone || 'neutral'} className="h-4 shrink-0 px-1.5 text-[9px]">
                {target.badge.label}
              </Pill>
            ) : null}
            {target.rating ? (
              <Pill tone={RATING_TONE[target.rating] || 'neutral'} className="h-4 shrink-0 px-1.5 text-[9px]">
                {RATING_LABELS[target.rating] || target.rating}
              </Pill>
            ) : null}
            {/* What this row starts from. The hosted rail lists `flux-3` four
                times upstream — text to image, image editing, text to video,
                image to video — which is four prices and one model; collapsed
                to one row, this is the only thing left that says it can start
                from a picture. The two studio catalogs derive the same fact
                from the bucket a model is listed in, so every row with an
                inventory behind it now carries it. */}
            {typeBadge ? (
              <Pill tone={typeBadge.tone} className="h-4 shrink-0 px-1.5 text-[9px]">
                {typeBadge.label}
              </Pill>
            ) : null}
            {extraCapabilities.map((capability) => (
              <Pill key={capability} tone="neutral" className="h-4 shrink-0 px-1.5 text-[9px]">
                {EXTRA_CAPABILITY_LABELS[capability]}
              </Pill>
            ))}
          </span>
          {note ? <span className="line-clamp-2 text-[11px] leading-snug text-ink3">{note}</span> : null}
        </span>
      </MenuItem>
      {/* The state of the account, and the button that repairs it, under the row
          that offers the model — never nested INSIDE it, because a button inside
          a disabled button never receives a click. */}
      {blocked ? (
        <div className={cx('flex flex-wrap items-center gap-1.5 px-2.5 pb-1.5 text-[10px] leading-snug',
          readiness.blocks ? 'text-warn' : 'text-ink3')}
        >
          <b>{readiness.label}</b>
          {detail ? <span className="opacity-90">{detail}</span> : null}
          {readiness.action && onFixReadiness ? (
            <Button
              size="sm"
              icon={readiness.state === 'reconnect' ? 'refresh' : 'key'}
              loading={busyAction === actionKey}
              onClick={() => onFixReadiness(readiness.action, target)}
            >
              {readiness.action.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The strip: four doors, the active one already open, each with what it holds.
 *  A count is printed only where there is something to count — "Rental 0" over
 *  a panel whose whole job is to offer renting one reads as a fault. */
/**
 * One account's state, above the models it holds.
 *
 * The account is named, because the rows below no longer repeat it; the
 * sentence and the repair are printed once. This is the whole difference
 * between a readable "Your accounts" and 125 identical paragraphs.
 */
function AccountNotice({ run, readiness, onFixReadiness, busyAction }) {
  const actionKey = readiness.action ? `${readiness.action.kind}:${readiness.action.provider || run.key}` : '';
  const name = [run.label, run.credentialLabel].filter(Boolean).join(' · ');
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-2.5 pb-1.5 pt-1">
      <span className="text-[11px] font-semibold text-ink2">{name}</span>
      <span className="text-[10px] font-semibold text-warn">{readiness.label}</span>
      {readiness.action && onFixReadiness ? (
        <Button
          size="sm"
          icon={readiness.state === 'reconnect' ? 'refresh' : 'key'}
          loading={busyAction === actionKey}
          onClick={() => onFixReadiness(readiness.action, run.targets[0])}
        >
          {readiness.action.label}
        </Button>
      ) : null}
      {readiness.detail ? (
        <p className="w-full text-[10px] leading-snug text-ink3">{readiness.detail}</p>
      ) : null}
    </div>
  );
}

/**
 * One account: what is true of it, and the models it serves.
 *
 * An account that CANNOT run anything keeps its models folded away. On this
 * machine MUAPI holds no key and serves 125 of the 137 models in "Your
 * accounts", so expanded it pushed every other account's Add key button off
 * the bottom of the panel — 125 greyed names nobody can press, between the
 * reader and the four doors that would fix it. Folded, every account's state
 * and repair fit on one screen, and the names are one click away for anyone
 * who wants to see what the key would buy.
 *
 * A usable account is never folded: its rows are the point of the list.
 */
function AccountSection({ run, expanded, renderRow, onFixReadiness, busyAction }) {
  const [open, setOpen] = useState(false);
  const folded = Boolean(run.blocked) && !open && !expanded;
  const count = run.targets.length;
  return (
    <div>
      {run.shared ? (
        <AccountNotice
          run={run}
          readiness={run.shared}
          onFixReadiness={onFixReadiness}
          busyAction={busyAction}
        />
      ) : null}
      {folded ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          // The only door to a folded account's 125 models, so it carries a full
          // thumb target even though it draws as a line of small grey text.
          className="flex w-full touch:min-h-[44px] items-center gap-1 px-2.5 pb-2 touch:py-2 text-left text-[11px] text-ink3 hover:text-ink1"
        >
          <Icon name="chevronRight" size={12} className="shrink-0" />
          {tf('runOn.accountModels', count)}
        </button>
      ) : run.targets.map(renderRow)}
    </div>
  );
}

/**
 * The type filter: what the rows in front of you start from.
 *
 * A second strip rather than four more tabs, and shaped differently on
 * purpose — the tabs above are one choice with one answer (which bill), this
 * is a narrowing you can drop. Only the types actually present are offered,
 * each with its count, so a chip is never a promise of rows that are not
 * there; "All" is how you come back.
 *
 * It is scoped to what is on screen: the open tab, or every match while a
 * query spans them all. A chip counting models on a tab you are not looking at
 * would be a number nobody can check.
 */
function TypeStrip({ types, active, onSelect }) {
  const chip = (id, label, count) => (
    <button
      key={id || 'all'}
      type="button"
      aria-pressed={active === id}
      onClick={() => onSelect(id)}
      className={cx(
        // Same ladder as the tabs above, one rung lower: these narrow a list
        // rather than switch it, so they stay the smaller chip — but 17.5px is
        // not a chip under a thumb, it is a miss.
        'inline-flex h-5 touch:h-ctl-xs shrink-0 items-center gap-1 rounded-full border px-2 touch:px-2.5 text-[10px] touch:text-[11px] font-semibold transition-colors',
        active === id
          ? 'border-honey/50 bg-honey-tint text-ink1'
          : 'border-line1 bg-bg2 text-ink2 hover:border-line2 hover:text-ink1',
      )}
    >
      <span>{label}</span>
      {count ? <span className="font-normal text-ink3">{count}</span> : null}
    </button>
  );
  return (
    <div role="group" aria-label={t('runOn.typesLabel')} className="flex flex-wrap items-center gap-1">
      {/* `runs.filterAll` is the app's one word for "no filter" — the runs
          list, the history list and the Models page all draw it. */}
      {chip('', t('runs.filterAll'), 0)}
      {types.map((type) => chip(type.id, type.label, type.targets.length))}
    </div>
  );
}

function TabStrip({ tabs, active, onSelect }) {
  return (
    <div
      role="tablist"
      aria-label={t('runOn.tabsLabel')}
      // A hair more inset under a thumb, so the tabs inside it can grow to the
      // coarse ladder without their press areas touching the strip's border.
      className="flex items-center gap-1 rounded-md border border-line1 bg-bg0 p-0.5 touch:p-1"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onSelect(tab.id)}
          className={cx(
            // `flex-auto`, never `flex-1`: equal quarters truncated "My accounts"
            // to "My accoun…" the moment its count reached three digits, and a
            // tab label that has stopped naming its tab is not a tab. Content
            // width first, the slack shared out after.
            //
            // 21px is a mouse target. Under a thumb the strip joins the control
            // ladder (`--ctl-sm` is 34px on a coarse pointer), which is what the
            // four doors to every machine the studio can reach deserve; the
            // widths keep sharing the row, so nothing new truncates.
            'flex h-6 touch:h-ctl-sm flex-auto items-center justify-center gap-1 truncate rounded-[7px] px-1.5 text-[11px] font-semibold transition-colors',
            active === tab.id ? 'bg-bg3 text-ink1 shadow-card' : 'text-ink2 hover:text-ink1',
          )}
        >
          <span className="truncate">{tab.label}</span>
          {tab.targets.length ? (
            <span className="shrink-0 font-normal text-ink3">{tab.targets.length}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/**
 * The list behind the readout: four tabs, one bill each.
 *
 * The tabs are RUN_TABS, not RUN_PLACES — the rented box gets a door of its own
 * here while staying a property of This Mac everywhere that routes. Stacked as
 * one scroll, a Mac that can run forty models put the rent CTA forty rows down,
 * and the only thing separating a free local row from one costing $0.42/hr was
 * the machine name printed on its right edge.
 *
 * `automatic` sits above the strip as a real row, so choosing it again is
 * possible after an override — the alternative (a default you can leave but not
 * return to) is how per-tab pins became permanent by accident. It answers for
 * every tab, so it belongs to none of them.
 */
export function RunOnList({
  targets, value, onChange, automatic = null, onAutomatic = null, isAutomatic = false, close = () => {},
  engine = null, page = '', pinned = '', onPin = null,
  // A handful of rows is not a list to search. Restore has three lanes and the
  // Send-to menu has two places; a search box over either is furniture — and so
  // are four tabs, so the same flag stands both down and those callers keep the
  // single grouped list they always had.
  searchable = true,
  readinessFor = null, onFixReadiness = null, busyAction = '',
  // What the composer currently holds, so a row can price the press it would
  // actually make: {kind, attached, aspectRatio, durationSeconds}. Only the
  // hosted rail reads it; null leaves every row on its place label.
  priceContext = null,
}) {
  const [filter, setFilter] = useState('');
  // '' is "nobody has pressed a tab yet", which is NOT the same as the local
  // tab: every studio's targets arrive after the first render, so a tab fixed at
  // mount would be a default chosen against an empty catalog. Deriving it each
  // render lets the default follow the models in, and it stops the moment a
  // person picks one.
  const [chosen, setChosen] = useState('');
  // Which type the list is narrowed to, or '' for all of them. Held the same
  // way and for the same reason: a type that the tab you just opened has none
  // of falls back to all rather than showing an empty list (see `narrowed`).
  const [chosenType, setChosenType] = useState('');
  const query = searchable ? filter.trim().toLowerCase() : '';
  const matches = (target) => !query || target.label.toLowerCase().includes(query)
    || target.placeLabel.toLowerCase().includes(query);
  const found = (targets || []).filter(matches);
  const showMachines = Boolean(engine && page);

  // The rental tab is the one that earns its place empty: with nothing rented it
  // is where "Rent a machine" lives, and hiding it is how that door went missing
  // for exactly the people who had not found it yet.
  const tabs = runTabsFor(targets)
    .filter((tab) => tab.targets.length || (tab.id === TAB_RENTAL && showMachines));
  const tabbed = searchable && tabs.length > 1;
  const active = tabs.some((tab) => tab.id === chosen) ? chosen : defaultRunTab(targets, value);
  // What the type chips are about: the rows on screen right now — the open tab,
  // or every match while a query spans them all. The kind comes off the rows
  // themselves, because the studio that built them already said it and a second
  // declaration is a second thing to keep in step.
  const inScope = tabbed && !query ? (tabs.find((tab) => tab.id === active)?.targets || []) : found;
  const types = searchable ? runTypesFor(inScope, targets?.[0]?.kind || 'image') : [];
  // One type is a fact about the list, not a filter: a strip offering "All" and
  // the only thing there is narrows nothing and costs a row of the panel.
  const typed = types.length > 1;
  const narrowed = typed && types.some((type) => type.id === chosenType) ? chosenType : '';
  const shown = narrowed ? found.filter((target) => target.startsFrom === narrowed) : found;
  // While a query is typed the list spans every tab, because a model you can
  // name is a model you want found wherever it runs — the same rule the text
  // producer's picker applies, and the reason pressing a tab clears the box.
  const groups = tabbed
    ? (query
      ? runTabsFor(shown).filter((tab) => tab.targets.length)
      : runTabsFor(shown).filter((tab) => tab.id === active))
    : groupRunTargets(shown);
  // The Automatic pick is ONE target in ONE place, so it belongs on that
  // place's tab and nowhere else. Shown above every tab it read as a member
  // of each: a This Mac model sat at the top of the Hivemind list, under the
  // Hivemind caption, which is exactly how it was read. While a query is
  // typed the list spans every tab, so it comes back.
  const automaticOnThisTab = Boolean(automatic?.target && onAutomatic)
    && (!tabbed || Boolean(query) || tabOfTarget(automatic.target) === active);
  // A heading earns its line only where there is more than one group to tell
  // apart. On a single tab the strip above it already said the name.
  const headed = !tabbed || Boolean(query);
  // …and with no heading, the group's caption has nothing to attach to, so it
  // moves up to the strip and is not printed twice.
  const tabCaption = headed ? '' : String(groups[0]?.blurb || '');
  // Which group carries the machine panel. Untabbed it is still This Mac's,
  // because that is the only place a rental has in a three-group list.
  const machineHost = tabbed ? TAB_RENTAL : PLACE_THIS_MAC;

  return (
    <>
      {searchable ? (
        // `-top-1.5` matches the `-mt-1.5`: a sticky box is clamped by its MARGIN
        // box, so `top-0` cancelled the negative margin and left the panel's own
        // padding as a strip above the field for rows to scroll through.
        <div className="sticky -top-1.5 z-10 -mx-1.5 -mt-1.5 mb-1 flex flex-col gap-1.5 border-b border-line1 bg-bg1 p-1.5">
          <div className="flex items-center gap-2 rounded-md border border-line1 bg-bg2 px-2.5 focus-within:border-honey/60">
            <Icon name="search" size={13} className="shrink-0 text-ink3" />
            <input
              type="text"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('common.searchModels')}
              // The field's height is the whole box's height — the bordered row
              // around it has no height of its own — so this is the one number
              // that decides whether searching 137 models is a thumb-sized
              // action. The 16px face a coarse pointer needs (which is what
              // stops iOS zooming the panel out from under the list) comes from
              // the global rule in base.css, not from here.
              className="h-8 touch:h-ctl-md w-full border-none bg-transparent text-xs text-ink1 outline-none placeholder:text-ink3"
            />
          </div>
          {tabbed ? (
            <TabStrip
              tabs={tabs}
              active={active}
              // Also clears the search: while a query is typed the list spans
              // every tab, so a strip that only moved a highlight would be a
              // control that did nothing.
              onSelect={(id) => { setFilter(''); setChosen(id); }}
            />
          ) : null}
          {/* …and under the bills, the types. The chip a person pressed is
              KEPT when the tab changes: someone narrowing to image-to-image is
              asking about editors, not about editors on one account, and a
              tab holding none of them falls back to all on its own. */}
          {typed ? (
            <TypeStrip types={types} active={narrowed} onSelect={setChosenType} />
          ) : null}
          {/* The tab's caption belongs to the TAB, under the strip that names
              it. It used to print with the group below, where — the heading
              being suppressed on a tabbed list — it landed directly under the
              Automatic row and read as a sentence about that row's bill:
              "One balance of HivemindOS credits" under a This Mac model. */}
          {tabCaption ? (
            <p className="px-1 text-[10px] leading-snug text-ink3">{tabCaption}</p>
          ) : null}
        </div>
      ) : null}

      {automaticOnThisTab ? (
        <div>
          <MenuHeading>{t('runOn.automatic')}</MenuHeading>
          <MenuItem
            selected={isAutomatic}
            meta={automatic.target.placeLabel}
            onClick={() => { onAutomatic(); close(); }}
          >
            <span className="inline-flex min-w-0 flex-col">
              <span className="truncate">{automatic.target.label}</span>
              {automatic.reason ? <span className="truncate text-[11px] text-ink3">{automatic.reason}</span> : null}
            </span>
          </MenuItem>
        </div>
      ) : null}

      {groups.length === 0 ? (
        <div className="px-2.5 py-4 text-center text-xs text-ink3">
          {t('common.noResults')}
        </div>
      ) : null}

      {groups.map((group) => {
        // Every row on this tab is on the SAME rented box, so the card below
        // already names it and its rate. Repeating "RTX 5090 · $0.82/hr" on
        // each row made three workflows on one machine read as three machines
        // being billed ("we don't have 4 rentals rented do we?"). With two
        // boxes attached it is kept, because then it is the thing that tells
        // the rows apart. Same rule as the account line above.
        const machines = new Set(group.targets.map((t) => t.machine?.rental_id).filter(Boolean));
        const machineSaid = machines.size === 1;
        return (
        <div key={group.id}>
          {headed ? <MenuHeading>{group.label}</MenuHeading> : null}
          {/* Who pays, on the section that is the bill. A rental prints its own
              $/hr on its row and the hosted restore rail quotes per render, but
              no media provider publishes a per-press rate the studio could
              honestly print — so the section states whose money it is rather
              than a figure it would have to invent. Same policy as the text
              producer's "billed to your own account". */}
          {group.blurb && headed ? (
            <p className="px-2.5 pb-1 text-[10px] leading-snug text-ink3">{group.blurb}</p>
          ) : null}
          {accountSectionsOf(group.targets, readinessFor).map((run) => (
            <AccountSection
              key={run.key}
              run={run}
              // A query is a person naming a model, so every match is shown
              // whoever it belongs to — a collapsed account must never be the
              // reason a search comes up empty.
              expanded={Boolean(query)}
              renderRow={(target) => (
                <TargetRow
                  key={target.key}
                  target={target}
                  selected={!isAutomatic && value?.provider === target.provider && value?.id === target.id}
                  onSelect={(chosen) => { onChange(chosen); close(); }}
                  readiness={readinessFor?.(target) || null}
                  priceContext={priceContext}
                  onFixReadiness={onFixReadiness}
                  busyAction={busyAction}
                  // Said above, for the whole account: the row keeps its name
                  // and nothing else.
                  accountSaid={Boolean(run.shared)}
                  machineSaid={machineSaid}
                />
              )}
              onFixReadiness={onFixReadiness}
              busyAction={busyAction}
            />
          ))}
          {/* The compact card is the existing status panel — pin, attach,
              reconnect, and the rent CTA with its confirmation — so a creator
              whose Mac cannot run a model can rent one without ever opening the
              console. On the tabbed list it IS the rental tab's body when
              nothing is rented yet; on the short lists it stays under This Mac,
              which is the only place a rental has in a three-group list. */}
          {group.id === machineHost && showMachines ? (
            <div className={cx('px-2.5 py-2', group.targets.length ? 'border-t border-line1' : '')}>
              <RentedSourceStatus engine={engine} page={page} pinned={pinned} onPin={onPin} />
            </div>
          ) : null}
        </div>
        );
      })}
    </>
  );
}

/**
 * The compact readout, and the list behind it.
 *
 * @param {object} props
 * @param {Array} props.targets from useRunTargets
 * @param {object|null} props.value the chosen target ({id, provider} is enough)
 * @param {function} props.onChange called with the chosen target
 * @param {object|null} props.automatic {target, reason} from pickRunTarget
 * @param {function|null} props.onAutomatic go back to the Automatic pick
 * @param {boolean} props.isAutomatic this tab is following Automatic
 */
export function RunOnPicker({
  targets = [], value = null, onChange, automatic = null, onAutomatic = null, isAutomatic = false,
  engine = null, page = '', pinned = '', onPin = null, className = '',
  // The composer wants the chip alone, on one wrapping row of chips; the
  // settings panel wants the labelled block. Same control, same list.
  compact = false,
  // A studio with TWO of these on one stage has to be able to say which is
  // which ("Character sheets", "The plate"). The default is the question.
  label = '',
  searchable = true,
  readinessFor = null, onFixReadiness = null, busyAction = '',
  // What the composer currently holds, so a row can price the press it would
  // actually make: {kind, attached, aspectRatio, durationSeconds}. Only the
  // hosted rail reads it; null leaves every row on its place label.
  priceContext = null,
  // The studio frame asks the same question in two more shapes — a word inside
  // the recipe sentence, and the card at the top of Advanced — so the anchor is
  // pluggable. (open, toggle, readoutLabel) => node. Omit it and the chip the
  // panel and composer have always used is what draws.
  renderTrigger = null,
  // `contents` on the wrapper collapses it into the parent's flow, which is what
  // the compact chip wants but NOT what an inline sentence token wants.
  bare = false,
}) {
  const shown = isAutomatic ? (automatic?.target || value) : value;
  const readout = runOnReadout(shown, {
    reason: isAutomatic ? (automatic?.reason || '') : '',
    automatic: isAutomatic,
  });
  return (
    <div className={cx((compact || bare) ? 'contents' : 'flex flex-col gap-2', className)}>
      {(compact || bare) ? null : <SectionLabel>{label || t('runOn.label')}</SectionLabel>}
      <Menu
        // 320 held four tabs only by truncating "My accounts" to "My accoun…",
        // which is a tab label that has stopped naming its tab. The `min()` is
        // the other half, and it is a CLAMP, not a preference: Menu aligns a
        // panel to one edge of its anchor and never to the viewport, so on a
        // 375px phone — where this chip sits inset in the composer — a flat 360
        // hung 26px off the right, and the overflow flip only moved the same
        // 26px to the left. Under ~320 both edges land inside, which is the
        // geometry this panel had before the strip, so a phone keeps it and
        // pays in a truncated tab label instead. The blurb under the strip
        // still names the bill in full.
        width="w-[min(360px,calc(100vw-3.5rem))]"
        // `dvh`, not `vh`: iOS reports the LARGE viewport for `vh`, so 70vh on a
        // phone is measured against a screen the URL bar is covering part of —
        // the last rows of the list end up under the browser chrome.
        panelClassName="max-h-[min(480px,70dvh)]"
        trigger={(open, toggle) => (renderTrigger ? renderTrigger(open, toggle, readoutText(readout), readout) : (
          <ChipButton
            icon={shown?.place === PLACE_THIS_MAC ? 'cpu' : 'cloud'}
            value={readoutText(readout)}
            active={open}
            onClick={toggle}
            title={readoutText(readout)}
            label={compact ? t('runOn.label') : ''}
            className={compact ? '' : 'w-full max-w-full justify-between'}
          />
        ))}
      >
        {(close) => (
          <RunOnList
            targets={targets}
            value={shown}
            onChange={onChange}
            automatic={automatic}
            onAutomatic={onAutomatic}
            isAutomatic={isAutomatic}
            close={close}
            engine={engine}
            page={page}
            pinned={pinned}
            onPin={onPin}
            searchable={searchable}
            readinessFor={readinessFor}
            priceContext={priceContext}
            onFixReadiness={onFixReadiness}
            busyAction={busyAction}
          />
        )}
      </Menu>
      {!compact && !bare && isAutomatic && readout.note ? (
        <small className="text-[11px] text-ink3">
          {t('runOn.automaticPrefix')}{readout.note}
        </small>
      ) : null}
    </div>
  );
}
