// Rental build — what a rented machine is provisioned WITH, per tier.
//
// One card per rental machine config (Image · Krea2 + WAI Anima, Video · H3
// Eros (NSFW), …), each holding the two decisions this page exists to make:
//
//   * its LoRAs — picked in the same picture-card picker the Image and Video
//     studios draw in their left pane, because it IS that component;
//   * its base checkpoint — swapped for another installed one, which lands on
//     the box under the default's filename so every graph keeps resolving.
//
// Both are written to packages/gpu-rentals/rental-build.json and committed. A
// machine already running keeps the serving set it provisioned with; this is
// about the NEXT rental, and the cards say so rather than implying otherwise.
//
// The page only exists where there is a checkout to write that file into (the
// control API answers `editable`), which is what makes it a development
// surface without a ?dev=1 URL a packaged window has no address bar to type.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRentalBuild, useRentalLoras } from '../../hooks/hooks.js';
import { localAI } from '../../lib/localInferenceClient.js';
import {
  fetchInstalledCheckpoints,
  refreshRentalBuild,
  saveRentalBuildCheckpoint,
  saveRentalBuildLoras,
  tierHasLoraPins,
  tierLoraPins,
} from '../../lib/rentalBuild.js';
import { rentalLoraUploadPercent } from '../../lib/rentalLoras.js';
import { LoraCard } from '../../studios/image/LoraCard.jsx';
import { Icon } from '../../ui/icons.jsx';
import { Modal } from '../../ui/Modal.jsx';
import { describeFailure } from '../../lib/describeFailure.js';
import { toastFailure } from '../../ui/failureToast.jsx';
import {
  Button, Card, EmptyState, FailureCallout, LoadingState, NativeSelect, Pill, SectionLabel,
  Spinner, StudioRestartAction, TextInput, cx,
} from '../../ui/kit.jsx';
import { HubToolbar } from '../components/HubToolbar.jsx';

const gb = (value) => (Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)} GB` : '—');

// The picker asks the bridge for LoRAs by BASE-MODEL FAMILY rather than by
// workflow: a rental tier is not a workflow, and the bridge already resolves a
// catalog from declared families (that path is what keeps MCP-only video
// workflows working). The id is only an echo, so it names the tier.
//
// A HYPHEN, never a colon. The request does not reach the bridge directly — it
// goes through the control API, whose /local-ai/* allowlist accepts a dynamic
// loras/<id> segment only when the id is alphanumeric once -, _ and % are
// removed (api/bridge.py). `rental:minimaxeros` keeps its colon through that
// strip, so every picker request was answered 404 by the proxy and the catalog
// never loaded. Pinned by test_the_rental_build_lora_id_survives_the_bridge_allowlist.
function loraCatalogFor(tier) {
  return localAI.listLoras(`rental-${tier.tier}`, tier.lora_base_models);
}

/* ---------------------------------------------------------------- LoRAs -- */

function LoraPicker({ tier, open, onClose, onSave }) {
  const [state, setState] = useState({ status: 'loading', loras: [], message: '' });
  // Bumped by Try again; the effect below keys off it, so a retry re-asks
  // rather than needing the modal closed and reopened.
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState(() => tierLoraPins(tier));
  const [saving, setSaving] = useState(false);
  const registry = useRentalLoras(open);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setPicked(tierLoraPins(tier));
    setState({ status: 'loading', loras: [], message: '' });
    loraCatalogFor(tier)
      .then((data) => {
        if (!alive) return;
        const loras = Array.isArray(data?.loras) ? data.loras : [];
        setState({
          status: 'ready',
          loras,
          message: loras.length
            ? ''
            : `No installed LoRA declares a base model this tier serves (${tier.lora_base_models.join(', ') || 'none'}).`,
        });
      })
      .catch((error) => {
        if (!alive) return;
        // A dead end is not a failure state. The local engine is something a
        // person can start, so the callout carries the same two doors the
        // studios use for it — start the engine, or ask again.
        setState({
          status: 'error',
          loras: [],
          message: '',
          failure: describeFailure(error, { operation: 'Reading your installed LoRAs', transport: 'local' }),
        });
      });
    return () => { alive = false; };
  }, [open, tier, attempt]);

  const toggle = (lora) => {
    setPicked((current) => (current.includes(lora.id)
      ? current.filter((id) => id !== lora.id)
      : [...current, lora.id]));
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave(picked);
      onClose();
    } catch (error) {
      toastFailure(error, { operation: 'Saving the rental build' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      size="xl"
      title={`LoRAs on ${tier.label}`}
      titleAside={<Pill tone="neutral">{`${picked.length} selected`}</Pill>}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={saving} icon={saving ? '' : 'check'}>
            {saving ? <Spinner size={13} /> : null}
            {saving ? 'Saving' : 'Save to the project'}
          </Button>
        </>
      )}
    >
      <p className="mb-3 text-xs leading-relaxed text-ink3">
        Each machine rented for this tier afterwards downloads what you pick — from
        Civitai where the LoRA came from there, and otherwise from the private
        bucket, which it is uploaded to once. Machines already running keep what
        they provisioned with. Pick none and the tier falls back to every registered
        LoRA whose base model it serves.
      </p>
      {state.status === 'loading' ? <LoadingState label="Reading your installed LoRAs" /> : null}
      {/* The engine is startable and the read is repeatable, so the failure
          carries both: the shell's own Start/Restart control, and a retry that
          re-runs the fetch in place. */}
      {state.status === 'error' && state.failure ? (
        <FailureCallout
          title={state.failure.title}
          detail={state.failure.detail}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : null}
      {state.status === 'error' ? <StudioRestartAction /> : null}
      {state.status === 'ready' && state.message ? (
        <div className="rounded-md border border-line1 bg-bg2 px-3 py-2.5 text-xs text-ink3">
          {state.message}
        </div>
      ) : null}
      {/* Two nested scrollers in one sheet: a drag that starts on a card moves
          the inner list and a drag two pixels away moves the sheet. Below sm
          the cap is dropped and the modal's own scroller is the only one. */}
      <div className="grid grid-cols-2 gap-2 sm:max-h-[52dvh] sm:overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
        {state.loras.map((lora) => {
          const entry = registry.entries?.[lora.id];
          const uploading = entry?.status === 'uploading';
          // A pin whose upload FAILED is the one state that must never be
          // quiet: the card looks chosen, the tier counts it, and the machine
          // gets nothing. It says so, and re-picking it retries the upload.
          const failed = entry?.status === 'error';
          // Nothing was uploaded for this one and nothing needs to be — the box
          // fetches it from Civitai, like a swapped-in checkpoint.
          const fromCivitai = entry?.source === 'civitai';
          return (
            <LoraCard
              key={lora.id}
              lora={lora}
              selected={picked.includes(lora.id)}
              onToggle={() => toggle(lora)}
              title={picked.includes(lora.id)
                ? `Take ${lora.displayName || lora.name} off ${tier.label}`
                : `Put ${lora.displayName || lora.name} on ${tier.label}`}
              meta={(
                <span
                  className={cx(
                    'inline-flex items-center gap-1 font-mono text-[10px]',
                    uploading ? 'text-honey' : failed ? 'text-danger' : 'text-ink3',
                  )}
                  title={uploading
                    ? 'Uploading to the private bucket — a machine rented after it lands gets it'
                    : failed
                      ? `The upload failed, so no rented machine can get this one. Unpick it and pick it again to retry. ${entry?.error || ''}`.trim()
                      : fromCivitai
                        ? 'Fetched from Civitai when you rent, so nothing is uploaded and nothing is stored in the bucket'
                        : entry?.status === 'ready'
                          ? 'In the bucket: a machine rented for this tier downloads it while it sets up'
                          : 'Not uploaded yet — saving this selection uploads it'}
                >
                  {uploading ? <Spinner size={10} /> : null}
                  {failed ? <Icon name="warning" size={10} /> : null}
                  {uploading
                    ? `${rentalLoraUploadPercent(entry)}%`
                    : failed
                      ? 'Upload failed'
                      : fromCivitai
                        ? 'Civitai'
                        : entry?.status === 'ready' ? 'In bucket' : ''}
                </span>
              )}
            />
          );
        })}
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- checkpoints -- */

// A machine can only fetch what it can fetch, and two sources qualify: a public
// Hugging Face file URL, used verbatim, and a Civitai version, whose signed
// download URL is resolved once per rental on this machine — so the token stays
// here and the box is handed the same kind of presigned URL our own bucket
// gives it. A file with neither is the only one that needs a pasted mirror.
function CheckpointSwap({ tier, weight, checkpoints, onSave, disabled }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(weight.swap?.id || '');
  const [url, setUrl] = useState(weight.swap?.url || '');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState('');
  const selected = checkpoints.find((item) => item.id === choice) || null;

  useEffect(() => {
    if (!open) return;
    setChoice(weight.swap?.id || '');
    setUrl(weight.swap?.url || '');
    setRefused('');
  }, [open, weight.swap?.id, weight.swap?.url]);

  // A checkpoint whose sidecar names a source needs no typing at all; only one
  // with neither Civitai nor Hugging Face metadata asks for a mirror.
  const resolved = selected?.source === 'huggingface' ? selected.url : '';
  const needsMirror = Boolean(selected) && !selected.source;
  const commit = async (nextId, nextUrl) => {
    setBusy(true);
    setRefused('');
    try {
      await onSave(weight.dest, nextId, nextUrl);
      setOpen(false);
    } catch (error) {
      // A refusal about THIS field belongs beside the field, where the eye
      // already is and where there is room for the sentence that names the
      // fix — a toast caps it and would drop exactly that half.
      const read = describeFailure(error, { operation: 'Swapping the checkpoint' });
      setRefused(read.detail || read.title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-line1 bg-bg2 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-[11px] text-ink1" title={weight.dest}>
            {weight.swap ? weight.swap.filename : weight.filename}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-ink3">
            <span>{weight.subdir}</span>
            <span>·</span>
            <span>{gb(weight.swap ? weight.swap.size_gb : weight.size_gb)}</span>
            {weight.swap ? (
              <>
                <Pill tone="honey">Swapped in</Pill>
                <span>{weight.swap.source === 'civitai' ? 'from Civitai' : 'from Hugging Face'}</span>
              </>
            ) : (
              <span>{weight.origin === 'bucket' ? 'from the private bucket' : 'from upstream'}</span>
            )}
          </div>
          {weight.swap ? (
            <p className="mt-1 text-[10px] leading-relaxed text-ink3">
              Lands as <span className="font-mono">{weight.filename}</span>, so every graph
              naming that weight keeps working.
            </p>
          ) : null}
        </div>
        <Button size="sm" onClick={() => setOpen((value) => !value)} disabled={disabled}>
          {weight.swap ? 'Change' : 'Swap'}
        </Button>
      </div>

      {open ? (
        <div className="mt-2.5 flex flex-col gap-2 border-t border-line1 pt-2.5">
          <NativeSelect
            value={choice}
            onChange={(e) => { setChoice(e.target.value); setUrl(''); }}
            aria-label={`Checkpoint to use instead of ${weight.filename}`}
          >
            <option value="">Use the default ({weight.filename})</option>
            {checkpoints.map((item) => (
              <option key={item.id} value={item.id}>
                {`${item.id} · ${gb(item.size_gb)}${item.source ? '' : ' · needs a mirror URL'}`}
              </option>
            ))}
          </NativeSelect>

          {selected && selected.source === 'civitai' ? (
            <p className="text-[10px] leading-relaxed text-ink3">
              Fetched from Civitai. The signed download URL is resolved on this machine
              each time you rent, so the box gets a link and never your token.
              {selected.modelUrl ? (
                <>
                  {' '}
                  <a
                    href={selected.modelUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-honey underline-offset-2 hover:underline"
                  >
                    Open its model page
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          {selected && resolved ? (
            <p className="text-[10px] leading-relaxed text-ink3">
              Fetched straight from Hugging Face — public, so nothing is resolved per rental.
            </p>
          ) : null}
          {needsMirror ? (
            <div className="flex flex-col gap-1.5">
              <TextInput
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://huggingface.co/<owner>/<repo>/resolve/main/<file>.safetensors"
                aria-label="Hugging Face download URL for this file"
              />
              <p className="text-[10px] leading-relaxed text-ink3">
                This file has no Civitai or Hugging Face metadata, so a rented box has
                nowhere to fetch it from. Paste the Hugging Face URL that serves it.
              </p>
            </div>
          ) : null}

          {refused ? (
            <p role="alert" className="rounded-md border border-danger/40 bg-danger-tint px-2 py-1.5 text-[11px] leading-relaxed text-danger">
              {refused}
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => commit(choice, choice ? (resolved || url.trim()) : '')}
            >
              {busy ? <Spinner size={12} /> : null}
              {choice ? 'Use this checkpoint' : 'Restore the default'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- page -- */

function TierCard({ tier, checkpoints, editable, onOpenLoras, onSaveCheckpoint }) {
  const pins = tierLoraPins(tier);
  // The registry is machine state and the pins are the committed decision; a
  // pin the registry cannot vouch for is the gap between the two. `entries`
  // is null until the registry answers — unknown is not "missing".
  const registry = useRentalLoras(true);
  const stuckPins = registry.entries
    ? pins.filter((id) => (registry.entries[id]?.status || 'absent') !== 'ready'
        && registry.entries[id]?.status !== 'uploading')
    : [];
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-ink1">{tier.label}</h3>
          <Pill tone="neutral">{tier.tier}</Pill>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-ink3">{tier.family_detail}</p>
        <p className="mt-1 text-[10px] text-ink3">
          {`${gb(tier.download_gb)} downloaded onto a ${tier.disk_gb} GB volume`}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>LoRAs</SectionLabel>
        <p className="text-xs leading-relaxed text-ink3">
          {tierHasLoraPins(tier)
            ? pins.length
              ? `${pins.length} pinned for this machine.`
              : 'Pinned to none — this machine is rented without add-on LoRAs.'
            : `Not pinned: every registered LoRA for ${tier.lora_base_models.join(', ') || 'this tier'} rides along.`}
        </p>
        {pins.length ? (
          <ul className="flex flex-col gap-1">
            {pins.map((id) => {
              // A pin is intent; the bytes have to be in the bucket too. A pin
              // whose upload failed would otherwise be counted above and
              // simply not arrive on the machine.
              const entry = registry.entries?.[id];
              // Source-blind on purpose: a Civitai-sourced pin is reachable
              // with nothing in the bucket, so "ready" is the only question.
              const stuck = entry?.status === 'error' || (registry.entries && !entry);
              return (
                <li
                  key={id}
                  className={cx(
                    'flex items-center gap-1 truncate rounded-sm px-2 py-1 font-mono text-[10px]',
                    stuck ? 'bg-danger-tint text-danger' : 'bg-bg2 text-ink2',
                  )}
                  title={stuck
                    ? 'Pinned, but a rented machine has no way to get it. Open Choose LoRAs and pick it again to retry.'
                    : id}
                >
                  {stuck ? <Icon name="warning" size={10} className="shrink-0" /> : null}
                  <span className="truncate">{id}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {stuckPins.length ? (
          <p className="text-[10px] leading-relaxed text-danger">
            {`${stuckPins.length} of these ${stuckPins.length === 1 ? 'is' : 'are'} not reachable, so a machine rented now would not get ${stuckPins.length === 1 ? 'it' : 'them'}. Open Choose LoRAs and pick ${stuckPins.length === 1 ? 'it' : 'them'} again to retry.`}
          </p>
        ) : null}
        <div>
          <Button size="sm" icon="layers" onClick={onOpenLoras} disabled={!editable}>
            Choose LoRAs
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>Base weights</SectionLabel>
        {tier.weights.length ? (
          <div className="flex flex-col gap-2">
            {tier.weights.map((weight) => (
              <CheckpointSwap
                key={weight.dest}
                tier={tier}
                weight={weight}
                checkpoints={checkpoints}
                onSave={onSaveCheckpoint}
                disabled={!editable}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink3">This machine serves no swappable base weight.</p>
        )}
      </div>
    </Card>
  );
}

export function RentalBuildView({ active }) {
  const build = useRentalBuild(active);
  const [checkpoints, setCheckpoints] = useState([]);
  const [pickerTier, setPickerTier] = useState('');

  useEffect(() => {
    if (!active || !build.editable) return;
    fetchInstalledCheckpoints().then(setCheckpoints).catch(() => setCheckpoints([]));
  }, [active, build.editable]);

  const saveLoras = useCallback((tier) => (ids) => saveRentalBuildLoras(tier, ids), []);
  const saveCheckpoint = useCallback(
    (tier) => (dest, id, url) => saveRentalBuildCheckpoint(tier, dest, id, url),
    [],
  );
  const open = useMemo(
    () => build.tiers.find((row) => row.tier === pickerTier) || null,
    [build.tiers, pickerTier],
  );

  // The hub layer keeps every view mounted and toggles display, so an inactive
  // view is ONE hidden root — never null, and never anything that paints.
  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar
        title="Rental build"
        subtitle="What each rented machine is provisioned with. Saved into the project and committed with git."
        refresh={() => refreshRentalBuild()}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {build.status === 'idle' ? <LoadingState label="Reading the rental build" /> : null}
        {build.status === 'unsupported' || (build.status === 'ready' && !build.editable) ? (
          <EmptyState
            icon="layers"
            title="No project checkout to write into"
            hint="This page edits packages/gpu-rentals/rental-build.json so the choice travels in a commit. Run the studio from the repository checkout to use it."
          />
        ) : null}
        {build.status === 'ready' && build.editable ? (
          <>
            <p className="mb-3 flex items-center gap-1.5 font-mono text-[10px] text-ink3">
              <Icon name="folder" size={12} />
              {build.path}
            </p>
            <div className="grid gap-3 lg:grid-cols-2">
              {build.tiers.map((tier) => (
                <TierCard
                  key={tier.tier}
                  tier={tier}
                  checkpoints={checkpoints}
                  editable={build.editable}
                  onOpenLoras={() => setPickerTier(tier.tier)}
                  onSaveCheckpoint={saveCheckpoint(tier.tier)}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>
      {active && open ? (
        <LoraPicker
          key={open.tier}
          tier={open}
          open
          onClose={() => setPickerTier('')}
          onSave={saveLoras(open.tier)}
        />
      ) : null}
    </div>
  );
}
