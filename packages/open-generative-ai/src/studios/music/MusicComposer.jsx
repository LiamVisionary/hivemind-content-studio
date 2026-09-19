// The Music composer — describe the song, optionally write the words, press it.
//
// TWO TEXT FIELDS, ONE ON SCREEN. The prompt box is the STYLE line: the tag
// list ACE-Step actually conditions on ("warm lofi piano, brushed drums, vinyl
// crackle"). Lyrics are a second, larger box that opens over it from a door in
// the action row, because an instrumental is lyrics left empty and a permanently
// open eight-line textarea would say the opposite. The door lights up and counts
// its lines once there is something in it, so a closed box is never a hidden one.
//
// ONLY WHAT THE ROW ACCEPTS. Every token in the sentence is gated on the model's
// own `accepts` list and bounded by its `limits` — a model that takes no BPM
// renders no BPM token rather than one that silently does nothing.
import { ComposerMeta, ComposerPanel, ComposerPrimary, ComposerPrompt, ComposerTool } from '../frame/ComposerPanel.jsx';
import { RecipeLine } from '../frame/RecipeLine.jsx';
import { DrawerChoice } from '../frame/AdvancedDrawer.jsx';
import {
  SECTION_PLAN_MODES, accepts, formatTrackLength, secondsRange, sectionPlanLyrics, sectionTags, usesSectionPlan,
} from '../../lib/musicLane.js';
import { recipeDoorLabel, recipesApplyTo } from '../../lib/musicRecipes.js';
import { MusicRecipeCard } from './MusicRecipeCard.jsx';
import { Icon } from '../../ui/icons.jsx';
import { Menu, MenuHeading, MenuItem } from '../../ui/Menu.jsx';
import { Slider, cx } from '../../ui/kit.jsx';

// The keys ACE-Step's own conditioning understands. A free-text box would let
// somebody type a key the graph then ignores without a word.
const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MODES = ['major', 'minor'];
const TIME_SIGNATURES = [
  { value: '4', label: '4/4' },
  { value: '3', label: '3/4' },
  { value: '6', label: '6/8' },
  { value: '5', label: '5/4' },
];
// What the model is told to sing IN. The row carries a two-letter default and
// nothing else, so this is the short list the studio offers; anything outside it
// still belongs in the style line, where the model reads free text.
const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Mandarin' },
];

const languageName = (code) => LANGUAGES.find((row) => row.value === code)?.label || String(code || '').toUpperCase();
const timeSignatureName = (value) => TIME_SIGNATURES.find((row) => row.value === String(value))?.label || `${value}/4`;

/** The lyrics box, opened over the prompt that describes the sound around it. */
function LyricsCard({ value, onChange, onClose, disabled }) {
  return (
    <div className="rounded-xl border border-line2 bg-white/[0.03] px-3 pb-2.5 pt-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-wide text-inkSoft">Lyrics</span>
        <span className="text-[11px] text-ink3">Leave it empty for an instrumental</span>
        <button
          type="button"
          onClick={onClose}
          title="Hide the lyrics"
          aria-label="Hide the lyrics"
          className="ml-auto grid h-6 w-6 place-items-center rounded-full text-ink3 transition-colors hover:bg-white/10 hover:text-ink1 touch:h-10 touch:w-10"
        >
          <Icon name="chevronUp" size={13} />
        </button>
      </div>
      <textarea
        rows={5}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={'[verse]\nwrite the words here\n\n[chorus]\nand the ones that repeat'}
        className={cx(
          'max-h-[240px] w-full resize-none overflow-y-auto border-none bg-transparent p-0 text-[13.5px] leading-[1.6] text-ink1 outline-none',
          'placeholder:text-ink3 disabled:cursor-not-allowed disabled:opacity-60',
        )}
      />
    </div>
  );
}

/**
 * The section plan, opened where a singing model's lyrics box would be.
 *
 * Built from choices, never typed: the lane's LoRA knows six tag names and three
 * caption shapes and nothing else, so the only free text in this card is the
 * read-only line at the bottom showing exactly what the model will be handed.
 */
function StructureCard({ model, plan, onPlan, seconds, onClose, disabled }) {
  const tags = sectionTags(model);
  const sections = Array.isArray(plan?.sections) ? plan.sections : [];
  const mode = SECTION_PLAN_MODES.find((row) => row.id === plan?.mode) || SECTION_PLAN_MODES[0];
  const ordered = mode.id !== 'bare';
  return (
    <div className="rounded-xl border border-line2 bg-white/[0.03] px-3 pb-2.5 pt-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-wide text-inkSoft">Structure</span>
        <span className="text-[11px] text-ink3">This model plays, it does not sing</span>
        <button
          type="button"
          onClick={onClose}
          title="Hide the structure"
          aria-label="Hide the structure"
          className="ml-auto grid h-6 w-6 place-items-center rounded-full text-ink3 transition-colors hover:bg-white/10 hover:text-ink1 touch:h-10 touch:w-10"
        >
          <Icon name="chevronUp" size={13} />
        </button>
      </div>
      <DrawerChoice
        options={SECTION_PLAN_MODES.map((row) => ({ value: row.id, label: row.label }))}
        value={mode.id}
        onChange={(value) => onPlan({ ...plan, mode: value })}
        disabled={disabled}
        mono={false}
        ariaLabel="How much of the structure you set"
      />
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink3">{mode.note}</p>
      {ordered ? (
        <>
          <ol className="mt-2 flex flex-wrap items-center gap-1 touch:gap-2" aria-label="Section order">
            {sections.map((tag, index) => (
              // The index IS the identity: the same tag legitimately repeats.
              // eslint-disable-next-line react/no-array-index-key
              <li key={`${index}-${tag}`}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onPlan({ ...plan, sections: sections.filter((_, at) => at !== index) })}
                  title={`Remove this ${tag}`}
                  aria-label={`Remove section ${index + 1}, ${tag}`}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-honey/[0.13] px-2 font-mono text-[11px] text-honey transition-colors hover:bg-honey/[0.2] disabled:cursor-not-allowed disabled:opacity-60 touch:h-10 touch:px-2.5"
                >
                  {tag}
                  <Icon name="x" size={10} />
                </button>
              </li>
            ))}
            {!sections.length ? (
              <li className="text-[11px] text-ink3">No sections yet — with none, the model decides.</li>
            ) : null}
          </ol>
          <div className="mt-1.5 flex flex-wrap items-center gap-1 touch:gap-2" role="group" aria-label="Add a section">
            <span className="mr-1 text-[11px] text-ink3">Add</span>
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                // Thirty sections is already far past any song the model was
                // trained on; the cap keeps a held-down click from building a
                // plan no track length can share out in whole seconds.
                disabled={disabled || sections.length >= 30}
                onClick={() => onPlan({ ...plan, sections: [...sections, tag] })}
                className="inline-flex h-7 items-center rounded-md bg-white/[0.05] px-2 font-mono text-[11px] text-inkSoft transition-colors hover:text-ink1 disabled:cursor-not-allowed disabled:opacity-60 touch:h-10 touch:px-2.5"
              >
                {tag}
              </button>
            ))}
          </div>
        </>
      ) : null}
      <pre
        aria-label="What the model is given"
        className="mt-2 max-h-[120px] overflow-y-auto whitespace-pre-wrap rounded-md bg-black/20 px-2 py-1.5 font-mono text-[11px] leading-[1.55] text-ink2"
      >
        {sectionPlanLyrics(model, plan, seconds)}
      </pre>
      {mode.id === 'timed' ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink3">
          The times follow the track length in the sentence below. Treat them as a guide: this model leans towards three to five minute pieces whatever it is told.
        </p>
      ) : null}
    </div>
  );
}

/**
 * @param {object} model     the audio row every control is derived from
 * @param {object} setup     the current settings (musicLane.defaultMusicSetup shape)
 * @param {func}   onSetup   (patch) => void
 */
export function MusicComposer({
  model,
  models = [],
  onModel = null,
  setup,
  onSetup,
  prompt,
  onPrompt,
  lyrics,
  onLyrics,
  plan = null,
  onPlan = () => {},
  lyricsOpen,
  onToggleLyrics,
  recipesOpen = false,
  onToggleRecipes = () => {},
  recipeBook = null,
  onGenerate,
  generating = false,
  blocked = false,
  generateTitle = '',
  metaLabel = '',
  metaTitle = '',
  promptRef = null,

  // This session's tracks, and the one door to them that survives a narrow
  // window: the rail is `hidden sm:flex`, so below 640px it is not on screen
  // and a track already made cannot be played again. Listed at every width for
  // the reason Restore's Projects door is — a door that only exists at one size
  // is a door nobody learns.
  tracks = [],
  activeTrackId = '',
  onOpenTrack = null,
}) {
  // Every token in the sentence is frozen while a track is rendering, for the
  // same reason the Advanced drawer is: the request was snapshotted at the press
  // and a length changed now belongs to the NEXT track, not to the bar on screen.
  const [minSeconds, maxSeconds] = secondsRange(model);
  const patch = (next) => onSetup({ ...setup, ...next });
  const lyricLines = String(lyrics || '').trim() ? String(lyrics).trim().split('\n').length : 0;
  const planned = usesSectionPlan(model);
  const plannedSections = planned && plan?.mode !== 'bare' ? (plan?.sections || []).length : 0;

  const parts = [
    { text: 'Make a' },
    accepts(model, 'seconds') && {
      key: 'seconds',
      disabled: generating,
      value: formatTrackLength(setup.seconds),
      title: `How long the track runs — ${formatTrackLength(minSeconds)} to ${formatTrackLength(maxSeconds)}`,
      menuWidth: 'w-72',
      menu: () => (
        <div className="flex flex-col gap-2 px-1 py-0.5">
          <Slider
            min={minSeconds}
            max={maxSeconds}
            step={5}
            value={setup.seconds}
            onChange={(value) => patch({ seconds: value })}
            format={formatTrackLength}
          />
          <p className="text-[11px] leading-relaxed text-ink3">
            {`Anything from ${formatTrackLength(minSeconds)} to ${formatTrackLength(maxSeconds)}. A longer track takes proportionally longer to render.`}
          </p>
        </div>
      ),
    },
    { text: 'track' },
    accepts(model, 'bpm') && {
      key: 'bpm',
      disabled: generating,
      value: `${setup.bpm} BPM`,
      title: 'The tempo the track is written at',
      menuWidth: 'w-72',
      menu: () => (
        <div className="flex flex-col gap-2 px-1 py-0.5">
          <Slider
            min={40}
            max={200}
            step={1}
            value={setup.bpm}
            onChange={(value) => patch({ bpm: value })}
            format={(value) => `${value}`}
          />
          <p className="text-[11px] leading-relaxed text-ink3">
            Beats per minute. Around 90 for a slow groove, 120 for house, 140 and up for drum and bass.
          </p>
        </div>
      ),
    },
    accepts(model, 'keyscale') && { text: 'in' },
    accepts(model, 'keyscale') && {
      key: 'keyscale',
      disabled: generating,
      value: setup.keyscale,
      title: 'The key and mode the track is written in',
      menuWidth: 'w-[19rem]',
      menu: (close) => {
        const [root = 'C', mode = 'major'] = String(setup.keyscale || 'C major').split(' ');
        return (
          <div className="flex flex-col gap-2.5 px-1 py-0.5">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Key">
              {KEYS.map((note) => (
                <button
                  key={note}
                  type="button"
                  aria-pressed={note === root}
                  onClick={() => patch({ keyscale: `${note} ${mode}` })}
                  className={cx(
                    'inline-flex h-7 w-9 items-center justify-center rounded-md font-mono text-[11px] transition-colors touch:h-10 touch:w-11',
                    note === root ? 'bg-honey/[0.15] text-honey' : 'bg-white/[0.05] text-inkSoft hover:text-ink1',
                  )}
                >
                  {note}
                </button>
              ))}
            </div>
            <DrawerChoice
              options={MODES.map((value) => ({ value, label: value }))}
              value={mode}
              onChange={(value) => { patch({ keyscale: `${root} ${value}` }); close(); }}
              mono={false}
              ariaLabel="Mode"
            />
          </div>
        );
      },
    },
    accepts(model, 'timesignature') && { text: 'in' },
    accepts(model, 'timesignature') && {
      key: 'timesignature',
      disabled: generating,
      value: timeSignatureName(setup.timesignature),
      title: 'The time signature the bars are counted in',
      menuWidth: 'w-60',
      menu: (close) => (
        <div className="px-1 py-0.5">
          <DrawerChoice
            options={TIME_SIGNATURES}
            value={String(setup.timesignature)}
            onChange={(value) => { patch({ timesignature: String(value) }); close(); }}
            ariaLabel="Time signature"
          />
        </div>
      ),
    },
    // Only when this model sings at all: the language of a track with no words
    // is not a decision anybody needs to make.
    accepts(model, 'language') && model?.supportsLyrics && { text: ', sung in' },
    accepts(model, 'language') && model?.supportsLyrics && {
      key: 'language',
      disabled: generating,
      value: languageName(setup.language),
      title: 'The language the vocals are sung in',
      menuWidth: 'w-52',
      menu: (close) => (
        <div className="flex flex-col px-0.5 py-0.5">
          {LANGUAGES.map((row) => (
            <button
              key={row.value}
              type="button"
              aria-pressed={row.value === setup.language}
              onClick={() => { patch({ language: row.value }); close(); }}
              className={cx(
                'rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                row.value === setup.language ? 'bg-honey-tint text-ink1' : 'text-ink2 hover:bg-bg2 hover:text-ink1',
              )}
            >
              {row.label}
            </button>
          ))}
        </div>
      ),
    },
    accepts(model, 'mode') && { text: 'as' },
    accepts(model, 'mode') && {
      key: 'mode',
      disabled: generating,
      value: (model?.modes || []).find((row) => row.id === setup.mode)?.label || setup.mode,
      title: 'How much of the song is written out before it is performed',
      menuWidth: 'w-[20rem]',
      menu: (close) => (
        <div className="flex flex-col gap-1 px-1 py-0.5">
          {(model?.modes || []).map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => { patch({ mode: row.id }); close?.(); }}
              className={`rounded-[8px] px-2 py-1.5 text-left text-[12px] transition-colors ${
                row.id === setup.mode ? 'bg-honey/[0.14] text-ink1' : 'text-ink2 hover:bg-ink1/[0.06]'
              }`}
            >
              {row.label}
            </button>
          ))}
        </div>
      ),
    },
    // Which model is making this. Only a token when there is a CHOICE: with one
    // row installed, naming it is noise, and the studio already says what it is
    // in the empty state. It sits at the end because it is the least-changed
    // decision in the sentence, and a model swap re-derives every token before
    // it — a row that does not accept `bpm` simply stops rendering that one.
    models.length > 1 && { text: 'with' },
    models.length > 1 && {
      key: 'model',
      disabled: generating,
      value: model?.name || 'a model',
      title: 'Which model writes and performs the track',
      menuWidth: 'w-[22rem]',
      // Menu hands its body the close callback POSITIONALLY (ui/Menu.jsx calls
      // children(() => setOpen(false))), so destructuring an object here would
      // leave the menu open after a pick without erroring.
      menu: (close) => (
        <div className="flex flex-col gap-1 px-1 py-0.5">
          {models.map((row) => {
            const nonCommercial = row?.license?.commercial === false;
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => { onModel?.(row); close?.(); }}
                className={`rounded-[8px] px-2 py-1.5 text-left transition-colors ${
                  row.id === model?.id ? 'bg-honey/[0.14] text-ink1' : 'text-ink2 hover:bg-ink1/[0.06]'
                }`}
              >
                <span className="block text-[12px] font-medium">{row.name}</span>
                <span className="block text-[11px] leading-relaxed text-ink3">
                  {[
                    row.ready ? null : 'needs its checkpoint',
                    // Said here, at the moment of choosing, rather than only
                    // after a track exists: this is where the decision is made.
                    nonCommercial ? 'non-commercial only' : null,
                  ].filter(Boolean).join(' · ') || (row.license?.commercial ? 'yours to use commercially' : '')}
                </span>
              </button>
            );
          })}
        </div>
      ),
    },
    { text: '.' },
  ];

  return (
    <ComposerPanel
      above={recipesOpen && recipesApplyTo(model) ? (
        // One card at a time over the prompt: the recipe card replaces the
        // structure or lyrics card rather than stacking on it, and a recipe's
        // result is stated in its own receipt, so nothing needs to be open
        // beside it to see what it did.
        <MusicRecipeCard
          model={model}
          setup={setup}
          plan={plan}
          prompt={prompt}
          book={recipeBook}
          onApply={(next) => { onSetup(next.setup); onPlan(next.plan); }}
          onClose={onToggleRecipes}
          disabled={generating}
        />
      ) : lyricsOpen && planned ? (
        <StructureCard
          model={model}
          plan={plan}
          onPlan={onPlan}
          seconds={setup.seconds}
          onClose={onToggleLyrics}
          disabled={generating}
        />
      ) : lyricsOpen && model?.supportsLyrics ? (
        <LyricsCard
          value={lyrics}
          onChange={onLyrics}
          onClose={onToggleLyrics}
          disabled={generating}
        />
      ) : null}
      prompt={(
        <ComposerPrompt
          inputRef={promptRef}
          value={prompt}
          onChange={(event) => onPrompt(event.target.value)}
          onClear={() => onPrompt('')}
          placeholder="Describe the sound — warm lofi piano, brushed drums, vinyl crackle, melancholy"
          // Cmd/Ctrl+Enter renders, with the same guards the button has.
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              if (!generating && !blocked) onGenerate();
            }
          }}
        />
      )}
      recipe={(
        <RecipeLine parts={parts} />
      )}
      tools={(
        <>
          {onOpenTrack && tracks.length ? (
            <Menu
              up
              width="w-[17rem]"
              trigger={(open, toggle) => (
                <ComposerTool icon="music" label="Tracks" active={open} onClick={toggle} badge={tracks.length} />
              )}
            >
              {(close) => (
                <>
                  <MenuHeading>Tracks</MenuHeading>
                  {tracks.map((track, index) => (
                    <MenuItem
                      key={track.id}
                      icon="music"
                      selected={track.id === activeTrackId}
                      meta={formatTrackLength(track.seconds)}
                      onClick={() => { onOpenTrack(track); close(); }}
                    >
                      {/* The rail's own name for a track with no title: newest
                          is the highest number, which is how the column reads. */}
                      {track.title || `Track ${tracks.length - index}`}
                    </MenuItem>
                  ))}
                </>
              )}
            </Menu>
          ) : null}
          {recipesApplyTo(model) ? (
            <ComposerTool
              icon="wand"
              label={recipesOpen ? 'Hide the recipes' : recipeDoorLabel(model)}
              active={recipesOpen}
              onClick={onToggleRecipes}
            />
          ) : null}
          {planned ? (
            <ComposerTool
              icon="layers"
              label={lyricsOpen ? 'Hide the structure' : 'Structure'}
              active={lyricsOpen || plannedSections > 0}
              badge={!lyricsOpen && plannedSections ? plannedSections : null}
              onClick={onToggleLyrics}
            />
          ) : model?.supportsLyrics ? (
            <ComposerTool
              icon="mic"
              label={lyricsOpen ? 'Hide the lyrics' : 'Write lyrics'}
              active={lyricsOpen || lyricLines > 0}
              badge={!lyricsOpen && lyricLines ? lyricLines : null}
              onClick={onToggleLyrics}
            />
          ) : null}
        </>
      )}
      meta={!generating && metaLabel ? <ComposerMeta title={metaTitle}>{metaLabel}</ComposerMeta> : null}
      primary={(
        <ComposerPrimary
          loading={generating}
          disabled={blocked}
          onClick={onGenerate}
          title={generateTitle}
        >
          {generating ? 'Rendering' : 'Make the track'}
        </ComposerPrimary>
      )}
    />
  );
}
