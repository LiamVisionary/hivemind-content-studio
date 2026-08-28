// Stage 2 — cast and place: the references every later generation is measured
// against.
//
// One sheet per character and one EMPTY plate for the place. Empty on purpose:
// the sheets own the characters, so a figure standing in the plate argues with
// them in every render and the model splits the difference. Both are promoted
// to persistent references the moment they are drawn, which is why there is no
// export step between here and the Video studio.
import { Icon } from '../../ui/icons.jsx';
import { Button, NativeSelect, cx } from '../../ui/kit.jsx';
import { ModelFitPicker } from '../ModelFitPicker.jsx';
import { IDENTITY_LOCKS, SHEET_AUDIT, SHEET_BACKGROUNDS, SILHOUETTE_TEST, neverChangeLine } from './characterSheet.js';
import { LOCATION_ASPECTS, MOTION_SOURCES, locationGaps, motionElements } from './location.js';
import { producerIsRunning } from './state.js';
import { Disclosure, DraftButton, FieldGrid, Notes, PlateSlot, Rule, StageHead, WriteField } from './parts.jsx';

const SLOT = 'w-[76px] aspect-[76/108] rounded-[10px]';

function Pill({ tone, children }) {
  return (
    <span
      className={cx(
        'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[10px] font-semibold',
        tone === 'ok' ? 'bg-ok-tint text-ok' : tone === 'warn' ? 'bg-warn/10 text-warn' : 'bg-bg3 text-ink3',
      )}
    >
      {children}
    </span>
  );
}

/** A name or a role, editable in place — a box only when you are in it. */
function InlineInput({ className = '', ...rest }) {
  return (
    <input
      className={cx(
        'box-border h-[30px] rounded-lg border border-transparent bg-transparent px-1.5 text-ink1 transition-colors',
        'hover:border-line1 hover:bg-bg1 focus:border-honey/60 focus:bg-bg1 focus:outline-none placeholder:text-ink3',
        className,
      )}
      {...rest}
    />
  );
}

function CharacterCard({ character, index, specs, busy, drawing, onFill, onPatch, onRemove, onDraw }) {
  const ticked = SHEET_AUDIT.filter((check) => character.audit?.[check.id]).length;
  const left = SHEET_AUDIT.length - ticked;
  const drawn = Boolean(character.sheetUrl);
  const never = neverChangeLine(character);
  const busyDraw = drawing === `sheet:${index}`;
  return (
    <div className="flex gap-3.5 rounded-xl border border-line1 bg-bg2 p-3.5">
      <PlateSlot
        url={character.sheetUrl}
        alt={`${character.name || 'Character'} reference sheet`}
        lines={['sheet', 'not', 'drawn']}
        box={SLOT}
        className="shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <InlineInput
            value={character.name || ''}
            onChange={(event) => onPatch(index, { name: event.target.value })}
            placeholder="Name"
            aria-label="Character name"
            className="min-w-[110px] flex-[0_1_140px] text-[15px] font-semibold"
          />
          <InlineInput
            value={character.role || ''}
            onChange={(event) => onPatch(index, { role: event.target.value })}
            placeholder="what they do, and roughly how old"
            aria-label="Character role"
            className="min-w-[160px] flex-[1_1_200px] !text-ink2 text-[12px]"
          />
          {drawn
            ? <Pill tone={left ? 'warn' : 'ok'}>{left ? `${left} check${left === 1 ? '' : 's'} left` : 'audited'}</Pill>
            : <Pill tone="warn">not drawn</Pill>}
          <button
            type="button"
            onClick={() => onRemove(index)}
            title="Remove this character"
            aria-label="Remove this character"
            className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-sm text-ink3 transition-colors hover:bg-danger-tint hover:text-danger"
          >
            <Icon name="x" size={13} />
          </button>
        </div>

        <p className="m-0 text-[12px] leading-relaxed text-ink3">
          <b className="font-semibold text-ink2">Never changes</b>
          {' — '}
          {never || <span className="text-warn">nothing locked yet, so every generation is free to reinvent them</span>}
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm" icon="image"
            onClick={() => onDraw(index)}
            loading={busyDraw}
            disabled={Boolean(drawing)}
          >
            {busyDraw ? 'Drawing…' : drawn ? 'Redraw the sheet' : 'Draw the sheet'}
          </Button>
        </div>

        <Disclosure label={`${IDENTITY_LOCKS.length} identity locks`}>
          <FieldGrid columns={1}>
            <WriteField
              id={`characters[${index}].species`}
              spec={specs.get(`characters[${index}].species`)}
              label="Species" hint=""
              busy={busy} onFill={onFill}
              value={character.species || ''}
              onChange={(event) => onPatch(index, { species: event.target.value })}
              placeholder="human, or which animal"
            />
            {IDENTITY_LOCKS.map((lock) => (
              <WriteField
                key={lock.id}
                id={`characters[${index}].${lock.id}`}
                spec={specs.get(`characters[${index}].${lock.id}`)}
                label={lock.label}
                hint={lock.hint}
                multiline
                busy={busy} onFill={onFill}
                value={character[lock.id] || ''}
                onChange={(event) => onPatch(index, { [lock.id]: event.target.value })}
              />
            ))}
            <WriteField
              id={`characters[${index}].never`}
              spec={specs.get(`characters[${index}].never`)}
              label="Never changes"
              hint="Quoted verbatim by the board and by every repair. Left empty, the locks above are used instead."
              multiline
              busy={busy} onFill={onFill}
              value={character.never || ''}
              onChange={(event) => onPatch(index, { never: event.target.value })}
              placeholder={never}
            />
          </FieldGrid>
        </Disclosure>

        {drawn ? (
          <Disclosure
            label="Audit before this becomes a reference"
            hint={`· ${ticked} of ${SHEET_AUDIT.length}`}
          >
            <p className="m-0 text-[11px] leading-snug text-ink3">{SILHOUETTE_TEST}</p>
            <div className="grid gap-1 sm:grid-cols-2">
              {SHEET_AUDIT.map((check) => (
                <label key={check.id} className="flex items-start gap-2 text-[11.5px] leading-snug text-ink2">
                  <input
                    type="checkbox"
                    checked={Boolean(character.audit?.[check.id])}
                    onChange={(event) => onPatch(index, {
                      audit: { ...character.audit, [check.id]: event.target.checked },
                    })}
                    className="mt-0.5 accent-honey"
                  />
                  {check.label}
                </label>
              ))}
            </div>
            {left ? (
              <Notes
                tone="ink"
                items={['Unticked items are not failures — they are unchecked. A drifting sheet costs every generation built on it.']}
              />
            ) : null}
          </Disclosure>
        ) : null}
      </div>
    </div>
  );
}

function MovesPicker({ picked, onToggle }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line1 pt-2.5">
      {MOTION_SOURCES.map((source) => (
        <div key={source.id} className="flex flex-wrap items-center gap-1.5">
          <span className="w-[104px] shrink-0 text-[11px] font-semibold text-ink2">{source.label}</span>
          {source.examples.map((example) => {
            const on = picked.includes(example);
            return (
              <button
                key={example}
                type="button"
                onClick={() => onToggle(example)}
                className={cx(
                  'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                  on ? 'border-honey/40 bg-honey-tint text-ink1' : 'border-line1 bg-bg2 text-ink3 hover:border-line2',
                )}
              >
                {example}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function CastStage({
  story, specs, busy, thinking, drawing, onFill, onUpdate, onLocation, onPatchCharacter,
  onAddCharacter, onRemoveCharacter, onDrawSheet, onDrawPlate, onChooseLocation,
  draft, onCancel, onSuggestPlaces, draftHint, draftLabel,
  sheetChoices, sheetModel, onSheetModel, plateChoices, plateModel, onPlateModel,
  readinessFor, onFixReadiness, fixing,
}) {
  const location = story.location;
  const moves = motionElements(location);
  const gaps = locationGaps(location);
  const platePill = location.plateUrl ? { tone: 'ok', label: 'drawn' } : { tone: 'warn', label: 'not drawn' };

  return (
    <div className="flex flex-col gap-5">
      <StageHead title="Cast &amp; place">
        The references the clip is measured against: one sheet per character, one empty plate for
        the place. Drawn once, reused by every later generation.
      </StageHead>

      <DraftButton
        label={draftLabel}
        running={producerIsRunning(busy, 'fill-section:cast')}
        blocked={Boolean(busy) && !producerIsRunning(busy, 'fill-section:cast')}
        hint={draftHint}
        status={thinking}
        onPress={draft}
        onCancel={onCancel}
      />

      <Disclosure label="Drawn with" hint={`· ${sheetModel?.label || 'no model picked'}`} tone="card">
        <ModelFitPicker
          label="Character sheets"
          rows={sheetChoices}
          value={sheetModel}
          onChange={onSheetModel}
          readinessFor={readinessFor}
          onFixReadiness={onFixReadiness}
          busyAction={fixing}
        />
        <ModelFitPicker
          label="The plate"
          rows={plateChoices}
          value={plateModel}
          onChange={onPlateModel}
          readinessFor={readinessFor}
          onFixReadiness={onFixReadiness}
          busyAction={fixing}
        />
        <FieldGrid>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-medium text-ink3">Sheet background</span>
            <NativeSelect
              value={story.sheetBackground}
              onChange={(event) => onUpdate({ sheetBackground: event.target.value })}
              className="[&>select]:!h-8 [&>select]:!bg-bg1 [&>select]:!text-[12px]"
            >
              {SHEET_BACKGROUNDS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </NativeSelect>
            <span className="text-[10.5px] leading-snug text-ink3/80">
              Plain and flat. A busy background makes the sheet useless as a reference.
            </span>
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-medium text-ink3">Canvas</span>
            <NativeSelect
              value={story.aspect}
              onChange={(event) => onUpdate({ aspect: event.target.value })}
              className="[&>select]:!h-8 [&>select]:!bg-bg1 [&>select]:!text-[12px]"
            >
              {LOCATION_ASPECTS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
            </NativeSelect>
            <span className="text-[10.5px] leading-snug text-ink3/80">
              The plate and the panels. A 16:9 plate reframed to 9:16 loses the foreground the motion lives in.
            </span>
          </label>
        </FieldGrid>
      </Disclosure>

      {story.characters.length ? story.characters.map((character, index) => (
        <CharacterCard
          key={character.id || index}
          character={character}
          index={index}
          specs={specs}
          busy={busy}
          drawing={drawing}
          onFill={onFill}
          onPatch={onPatchCharacter}
          onRemove={onRemoveCharacter}
          onDraw={onDrawSheet}
        />
      )) : (
        <div className="flex flex-col gap-1.5 rounded-xl border border-dashed border-line2 bg-bg1 p-5 text-center">
          <span className="text-[13px] font-medium text-ink2">No characters yet</span>
          <span className="text-[11.5px] leading-snug text-ink3">
            Lock a direction on the story stage and the draft above writes the identity locks — or add one by hand.
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={onAddCharacter}
        className="inline-flex h-7 w-fit items-center gap-1.5 rounded-md border border-dashed border-line2 px-2.5 text-[12px] text-ink2 transition-colors hover:text-ink1"
      >
        <Icon name="plus" size={13} />
        Add a character
      </button>

      {/* The place. */}
      <div className="flex gap-3.5 rounded-xl border border-line1 bg-bg2 p-3.5">
        <PlateSlot
          url={location.plateUrl}
          alt="Empty location plate"
          lines={['empty', 'plate', story.aspect]}
          box={SLOT}
          className="shrink-0"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink3">The place</span>
            <Pill tone={platePill.tone}>{platePill.label}</Pill>
            <button
              type="button"
              onClick={onSuggestPlaces}
              disabled={Boolean(busy)}
              className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] text-ink3 transition-colors hover:text-ink1 disabled:opacity-40"
            >
              <Icon
                name={producerIsRunning(busy, 'location') ? 'refresh' : 'wand'}
                size={12}
                className={producerIsRunning(busy, 'location') ? 'animate-spin text-honey' : ''}
              />
              Suggest directions
            </button>
          </div>

          {story.locationOptions.length ? (
            <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
              {story.locationOptions.map((option, index) => (
                <button
                  key={`${option.place}-${index}`}
                  type="button"
                  onClick={() => onChooseLocation(option)}
                  className={cx(
                    'flex flex-col gap-0.5 rounded-lg border p-2 text-left text-[11.5px] transition-colors',
                    location.place === option.place ? 'border-honey/50 bg-honey-tint' : 'border-line1 bg-bg1 hover:border-line2',
                  )}
                >
                  <span className="font-semibold text-ink1">{option.place}</span>
                  <span className="text-ink3">{[option.time, option.weather, option.palette].filter(Boolean).join(' · ')}</span>
                </button>
              ))}
            </div>
          ) : null}

          <WriteField
            id="location.place"
            spec={specs.get('location.place')}
            label="" hint=""
            multiline
            rows={2}
            busy={busy}
            onFill={onFill}
            value={location.place}
            onChange={(event) => onLocation({ place: event.target.value })}
            placeholder="the last stand of an estuary bus terminus, one bus, shelter and timetable case"
            inputClassName="!text-[13px] !leading-relaxed"
          />

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-ink3">Moves:</span>
            {moves.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => onLocation({ motion: location.motion.filter((row) => row !== entry) })}
                title="Remove this one"
                className="group/chip inline-flex items-center gap-1 rounded-full border border-honey/40 bg-honey-tint px-2 py-0.5 text-[11px] text-ink1"
              >
                {entry}
                <Icon name="x" size={10} className="opacity-40 transition-opacity group-hover/chip:opacity-100" />
              </button>
            ))}
            {!moves.length ? <span className="text-[11px] text-warn">nothing yet — the motion stage would have nothing to animate</span> : null}
          </div>

          <Disclosure label="What can move" hint={`· ${moves.length} chosen`}>
            <MovesPicker
              picked={location.motion}
              onToggle={(example) => onLocation({
                motion: location.motion.includes(example)
                  ? location.motion.filter((row) => row !== example)
                  : [...location.motion, example],
              })}
            />
          </Disclosure>

          <Notes items={gaps} />

          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm" icon="image"
              onClick={onDrawPlate}
              loading={drawing === 'plate'}
              disabled={Boolean(drawing) || !location.place}
            >
              {drawing === 'plate' ? 'Drawing…' : location.plateUrl ? 'Redraw the plate' : 'Draw the plate'}
            </Button>
          </div>

          <Disclosure label="Palette, light, depth, exclusions">
            <FieldGrid>
              {['time', 'weather', 'palette', 'accent', 'lights'].map((key) => (
                <WriteField
                  key={key}
                  id={`location.${key}`}
                  spec={specs.get(`location.${key}`)}
                  hint=""
                  busy={busy}
                  onFill={onFill}
                  value={location[key]}
                  onChange={(event) => onLocation({ [key]: event.target.value })}
                />
              ))}
              <WriteField
                id="location.forbid"
                spec={specs.get('location.forbid')}
                hint=""
                busy={busy}
                onFill={onFill}
                value={location.forbid}
                onChange={(event) => onLocation({ forbid: event.target.value })}
                placeholder="no people, no signage text"
              />
              <WriteField
                id="location.depth"
                spec={specs.get('location.depth')}
                label="Foreground → background"
                hint=""
                multiline
                busy={busy}
                onFill={onFill}
                value={location.depth}
                onChange={(event) => onLocation({ depth: event.target.value })}
                className="sm:col-span-2"
              />
            </FieldGrid>
          </Disclosure>
        </div>
      </div>

      {story.characters.some((row) => row.sheetUrl) || location.plateUrl ? (
        <>
          <Rule label="Drawn" hint="every one of these is already a reference in the Video studio" />
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
            {story.characters.filter((row) => row.sheetUrl).map((row) => (
              <figure key={row.id} className="m-0 flex flex-col gap-1">
                <PlateSlot url={row.sheetUrl} alt={`${row.name} reference sheet`} box="w-full aspect-video rounded-md" />
                <figcaption className="truncate text-[11px] text-ink3">{row.name || 'character'} — sheet</figcaption>
              </figure>
            ))}
            {location.plateUrl ? (
              <figure className="m-0 flex flex-col gap-1">
                <PlateSlot url={location.plateUrl} alt="Empty location plate" box="w-full aspect-video rounded-md" />
                <figcaption className="truncate text-[11px] text-ink3">{location.place || 'the place'} — plate</figcaption>
              </figure>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
