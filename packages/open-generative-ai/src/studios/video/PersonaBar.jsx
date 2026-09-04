// Hive Persona ID — the character strip at the top of the References panel.
//
// A persona is not a new kind of reference; it is a NAME for the set of
// references already attached. So this bar never edits media itself: the rows
// below it stay the one place a picture, clip or voice is added or removed, and
// the bar only says which character those rows currently are, whether they have
// drifted from what was saved, and offers to save or replace them.
//
// That is what makes "editable" work without a second editor: load Cheryl,
// change a picture in the row, press Save. The persona follows the rows.
//
// The library is sealed to the owner vault (savedLibraryStore), so the server
// holds one opaque blob and learns neither the character's name nor which
// references it is made of.
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useSavedLibrary } from '../../hooks/hooks.js';
import {
  PERSONA_GENDER_OPTIONS,
  PERSONA_LOOK_MAX,
  applyPersonaToReferences,
  normalizePersonaGender,
  normalizePersonaLook,
  personaCounts,
  personaFromReferences,
  personaIdentity,
  personaIsEmpty,
  personaPrimaryImage,
  personaSummary,
  samePersonaReferences,
} from '../../lib/personaId.js';
import { LIBRARIES, deleteLibraryEntry, saveLibraryEntry } from '../../lib/savedLibraryStore.js';
import { buildPersonaTransfer, downloadPersonaTransfer, importPersonaTransfer } from '../../lib/personaTransfer.js';
import { Icon } from '../../ui/icons.jsx';
import { ConfirmModal } from '../../ui/Modal.jsx';
import { LibraryDeleteButton, LibraryStateNote, SaveNameModal } from '../../ui/SavedLibrary.jsx';
import { SectionLabel, Spinner, cx } from '../../ui/kit.jsx';
import { ReferenceThumb } from './ReferenceThumb.jsx';
import { zh } from './videoLogic.js';
import { toastFailure } from '../../ui/failureToast.jsx';

const BAR_BUTTON = 'rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

// The persona's gender, as a row of chips. It is the one thing about a
// character that its pictures cannot tell a prompt — "the woman"/"her" or "the
// man"/"his" — so it is set here beside the name, and every template, cast
// definition, UGC deal and helper request reads it from the saved persona.
export function GenderChips({ value, onChange, disabled = false, compact = false }) {
  return (
    <div role="group" aria-label={zh() ? '性别' : 'Gender'} className="flex flex-wrap items-center gap-1">
      {PERSONA_GENDER_OPTIONS.map((option) => (
        <button
          key={option.value || 'unset'}
          type="button"
          disabled={disabled}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            'rounded font-medium transition-colors disabled:opacity-50',
            compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]',
            value === option.value ? 'bg-honey-tint text-honey' : 'text-ink3 hover:bg-bg3 hover:text-ink2',
          )}
        >
          {zh() ? option.zh : option.label}
        </button>
      ))}
    </div>
  );
}

function PersonaFace({ data, posters, onPosterCaptured }) {
  const url = personaPrimaryImage(data);
  return (
    <span className="h-8 w-8 shrink-0 overflow-hidden rounded-full border border-line1 bg-bg3">
      {url ? (
        <ReferenceThumb
          url={url}
          posterUrl={posters[url] || null}
          kind="image"
          onPosterCaptured={onPosterCaptured}
        />
      ) : (
        // A voice-and-motion persona has no face to show.
        <span className="grid h-full w-full place-items-center text-ink3"><Icon name="persona" size={14} /></span>
      )}
    </span>
  );
}

/**
 * @param {object}   props
 * @param {string[]} props.images                 the attached <Picture N> rows
 * @param {object[]} props.videos                 the attached <Video N> rows
 * @param {object[]} props.audios                 the attached <Audio N> rows
 * @param {object}   props.persona                { id, name, gender } of the loaded persona, or null
 * @param {Function} props.onPersonaChange        (next|null) => void
 * @param {Function} props.onLoad                 ({ images, videos, audios }) => void
 * @param {object}   props.limits                 the running workflow's slot counts
 * @param {object}   props.posters                reference url -> sealed poster url
 * @param {Set|null} props.known                  reference urls that still exist, or null if unknown
 * @param {Function} props.uploadFn               the panel's own reference upload, for importing a
 *                                                persona file. The bar owns no media path of its own:
 *                                                imported media goes up exactly the way a dragged file
 *                                                does, honouring whatever upload the studio configured.
 */
export function PersonaBar({
  images = [], videos = [], audios = [], persona = null, onPersonaChange,
  onLoad, limits, posters = {}, known = null, onPosterCaptured, uploadFn,
  // What the cast strip knows about the person in these rows when no persona
  // names them yet — gender and look set on the chip — so "Save as persona"
  // starts from what was already written rather than from blanks.
  seed = null,
}) {
  const { entries, loading, locked, retry } = useSavedLibrary(LIBRARIES.personas);
  const [listOpen, setListOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveAsNew, setSaveAsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  // Which transfer is in flight: a persona id while exporting it, 'import'
  // while reading one in. Both are slow — every reference is decrypted or
  // re-uploaded one at a time — so neither may look instant.
  const [busyTransfer, setBusyTransfer] = useState('');
  // The gender chosen in the save dialog. Seeded from the loaded persona when
  // the dialog opens, so "Save as new" starts from the character on screen.
  const [saveGender, setSaveGender] = useState('');
  // The look typed in the save dialog — hair, face, build, wardrobe. Seeded
  // from the loaded persona (or the cast strip's draft) when the dialog opens.
  const [saveLook, setSaveLook] = useState('');
  const importInputRef = useRef(null);

  const gender = normalizePersonaGender(persona?.gender ?? seed?.gender);
  const look = normalizePersonaLook(persona?.look ?? seed?.look);
  const current = personaFromReferences({ images, videos, audios, gender, look });
  const empty = personaIsEmpty(current);
  const activeEntry = persona?.id ? entries.find((entry) => entry.id === persona.id) : null;
  // Only meaningful once the library has actually been read: before that, an
  // unfound entry means "not loaded yet", not "deleted".
  const edited = activeEntry ? !samePersonaReferences(activeEntry.data, current) : false;

  // Emptying every row is not an edit of the character — it is putting it down.
  useEffect(() => {
    if (persona?.id && empty) onPersonaChange?.(null);
  }, [persona?.id, empty, onPersonaChange]);

  const save = async (name) => {
    setSaving(true);
    try {
      const data = personaFromReferences({
        ...current, gender: normalizePersonaGender(saveGender), look: saveLook,
      });
      const entry = await saveLibraryEntry(LIBRARIES.personas, { name, data });
      // A same-name save is an upsert, so an existing id means it replaced one.
      const replaced = entries.some((item) => item.id === entry.id);
      onPersonaChange?.(personaIdentity({ id: entry.id, name: entry.name, gender: data.gender, look: data.look }));
      setSaveOpen(false);
      toast.success(replaced
        ? (zh() ? `已更新“${name}”。` : `Updated “${name}”.`)
        : (zh() ? `已保存角色“${name}”。` : `Saved “${name}”.`));
    } catch (error) {
      toastFailure(error, { operation: 'That persona' });
    } finally {
      setSaving(false);
    }
  };

  // Overwrite the loaded persona in place — the "I changed a picture, keep the
  // character" path, which is the whole reason a persona is editable.
  const saveOverActive = async () => {
    if (!activeEntry) return;
    setSaving(true);
    try {
      await saveLibraryEntry(LIBRARIES.personas, { name: activeEntry.name, data: current });
      toast.success(zh() ? `已更新“${activeEntry.name}”。` : `Updated “${activeEntry.name}”.`);
    } catch (error) {
      toastFailure(error, { operation: 'That persona' });
    } finally {
      setSaving(false);
    }
  };

  // Out of the vault: every reference decrypted here in the browser (the only
  // place it can be) and written into one file, media and all.
  const exportPersona = async (entry) => {
    setBusyTransfer(entry.id);
    try {
      const { document, dropped, filename } = await buildPersonaTransfer(entry.name, entry.data);
      downloadPersonaTransfer(document, filename);
      if (dropped.length) {
        // A character that arrives smaller than it was saved has to say so
        // here, not silently at generation time on someone else's machine.
        toast(zh()
          ? `已导出“${entry.name}”，但 ${dropped.length} 个参考无法读取：${dropped.join('、')}`
          : `Exported “${entry.name}” — ${dropped.length} reference(s) could not be read and were left out: ${dropped.join(', ')}`,
        { duration: 9000 });
      } else {
        toast.success(zh() ? `已导出“${entry.name}”。` : `Exported “${entry.name}”.`);
      }
    } catch (error) {
      toastFailure(error, { operation: 'That persona' });
    } finally {
      setBusyTransfer('');
    }
  };

  // In: the file is data, never instructions. Its media is re-uploaded so this
  // vault seals its own copies — nothing points back at where it came from.
  const importPersona = async (file) => {
    setBusyTransfer('import');
    const progress = toast.loading(zh() ? '正在导入角色…' : 'Importing persona…');
    try {
      const text = await file.text();
      const { name, data } = await importPersonaTransfer(text, {
        uploadFn,
        onProgress: (done, total) => {
          toast.loading(zh()
            ? `正在导入角色…（${done}/${total}）`
            : `Importing persona… (${done}/${total} references)`, { id: progress });
        },
      });
      const entry = await saveLibraryEntry(LIBRARIES.personas, { name, data });
      toast.success(zh() ? `已导入“${entry.name}”。` : `Imported “${entry.name}”.`, { id: progress });
    } catch (error) {
      toast.error(error.message, { id: progress });
    } finally {
      setBusyTransfer('');
    }
  };

  const load = (entry) => {
    const { images: nextImages, videos: nextVideos, audios: nextAudios, gender: nextGender, missing, trimmed } =
      applyPersonaToReferences(entry.data, { limits, known });
    onLoad?.({ images: nextImages, videos: nextVideos, audios: nextAudios });
    onPersonaChange?.(personaIdentity({ id: entry.id, name: entry.name, gender: nextGender }));
    // Never let a character come back quietly smaller than it was saved.
    if (missing.length) {
      toast(zh()
        ? `已载入“${entry.name}”——${missing.length} 个参考已不存在：${missing.join('、')}`
        : `Loaded “${entry.name}” — ${missing.length} of its references no longer exist: ${missing.join(', ')}`,
      { duration: 9000 });
    } else if (trimmed.length) {
      const dropped = trimmed.reduce((total, item) => total + item.dropped, 0);
      toast(zh()
        ? `已载入“${entry.name}”——当前工作流的插槽不足，已省略 ${dropped} 个参考。`
        : `Loaded “${entry.name}” — ${dropped} reference${dropped === 1 ? '' : 's'} left out; this workflow has fewer slots than the persona was saved with.`,
      { duration: 9000 });
    } else {
      toast.success(zh() ? `已载入“${entry.name}”。` : `Loaded “${entry.name}”.`);
    }
  };

  const remove = async () => {
    const entry = confirmDelete;
    setConfirmDelete(null);
    try {
      await deleteLibraryEntry(LIBRARIES.personas, entry.id);
      // Deleting the loaded persona leaves the references attached — only the
      // NAME is gone. Silently clearing the rows would throw away media the
      // user never asked to remove.
      if (persona?.id === entry.id) onPersonaChange?.(null);
      toast(zh() ? `已删除“${entry.name}”。` : `Deleted “${entry.name}”.`);
    } catch (error) {
      toastFailure(error, { operation: 'That persona' });
    }
  };

  const openSave = (asNew) => {
    setSaveAsNew(asNew);
    setSaveGender(gender);
    setSaveLook(look);
    setSaveOpen(true);
  };

  // Changing the gender of the loaded character is an edit like swapping a
  // picture: the bar shows it, Save writes it.
  const setLoadedGender = (value) => {
    if (!persona?.name) return;
    onPersonaChange?.(personaIdentity({ ...persona, gender: value }));
  };

  const counts = personaCounts(current);

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line1 bg-bg2 p-2">
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel>{zh() ? 'Hive 角色 ID' : 'Hive Persona ID'}</SectionLabel>
        <button
          type="button"
          aria-expanded={listOpen}
          onClick={() => {
            // The studio can mount before the owner unlocks; opening the list is
            // the moment to re-check rather than showing the locked note forever.
            if (locked) retry();
            setListOpen((open) => !open);
          }}
          className="flex items-center gap-1 rounded px-1 text-[10px] font-semibold text-ink3 transition-colors hover:text-ink1"
        >
          <Icon name="chevronDown" size={11} className={cx('transition-transform duration-150', listOpen && 'rotate-180')} />
          {zh() ? '已保存' : 'Saved'}
          {entries.length ? <span className="tabular-nums">{entries.length}</span> : null}
        </button>
      </div>

      {persona?.name ? (
        <>
          <div className="flex items-center gap-2">
            <PersonaFace data={current} posters={posters} onPosterCaptured={onPosterCaptured} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-semibold text-ink1">{persona.name}</span>
              <span className={cx('block truncate text-[10px]', edited ? 'text-honey' : 'text-ink3')}>
                {edited
                  ? (zh() ? `已修改 · ${personaSummary(current)}` : `Edited · ${personaSummary(current)}`)
                  : personaSummary(current)}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink3">
              {zh() ? '性别' : 'Gender'}
            </span>
            <GenderChips compact value={gender} onChange={setLoadedGender} disabled={saving} />
          </div>
        </>
      ) : (
        <p className="text-[10px] leading-snug text-ink3">
          {zh()
            ? '把当前这组参考保存为一个角色：图片、动作、声音一起存，下次一键载入。'
            : 'Save this whole set of references as one character — its pictures, how it moves, how it sounds — and load it back in one click.'}
        </p>
      )}

      <div className="flex items-center gap-1">
        {activeEntry ? (
          <button
            type="button"
            disabled={!edited || saving}
            onClick={() => void saveOverActive()}
            title={edited
              ? (zh() ? `用当前参考覆盖“${activeEntry.name}”` : `Replace “${activeEntry.name}” with the references attached now`)
              : (zh() ? '与已保存的内容一致' : 'Nothing has changed since it was saved')}
            className={cx(BAR_BUTTON, edited
              ? 'border-honey/50 bg-honey-tint text-honey hover:border-honey'
              : 'border-line1 bg-bg1 text-ink3')}
          >
            {zh() ? '保存' : 'Save'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={empty || saving}
          onClick={() => openSave(Boolean(activeEntry))}
          title={empty
            ? (zh() ? '先附加一些参考' : 'Attach some references first')
            : (zh() ? '把这组参考另存为一个角色' : 'Save these references under a name')}
          className={cx(BAR_BUTTON, activeEntry
            ? 'border-line1 bg-bg1 text-ink1 hover:border-honey/50 hover:text-honey'
            : 'border-honey/50 bg-honey-tint text-honey hover:border-honey')}
        >
          {activeEntry ? (zh() ? '另存为新角色…' : 'Save as new…') : (zh() ? '保存为角色…' : 'Save as persona…')}
        </button>
        {!empty ? (
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink3">{counts.total}</span>
        ) : null}
      </div>

      {listOpen ? (
        <div className="border-t border-line1 pt-1.5">
          <LibraryStateNote
            loading={loading}
            locked={locked}
            empty={!entries.length}
            emptyHint={zh()
              ? '还没有保存的角色。附加好参考后点“保存为角色”。'
              : 'No characters yet. Attach the references that describe one, then use Save as persona.'}
          />
          <div className="max-h-56 overflow-y-auto">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className={cx(
                  'flex items-center gap-1 rounded-md px-1 transition-colors hover:bg-bg3',
                  entry.id === persona?.id && 'bg-honey-tint/40',
                )}
              >
                <button
                  type="button"
                  onClick={() => { load(entry); setListOpen(false); }}
                  title={zh() ? `载入 ${entry.name}` : `Load ${entry.name}`}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
                >
                  <PersonaFace data={entry.data} posters={posters} onPosterCaptured={onPosterCaptured} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-ink1">{entry.name}</span>
                    <span className="block truncate text-[10px] text-ink3">{personaSummary(entry.data)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  disabled={busyTransfer === entry.id}
                  onClick={() => void exportPersona(entry)}
                  aria-label={zh() ? `导出 ${entry.name}` : `Export ${entry.name}`}
                  title={zh()
                    ? '导出为一个文件：包含参考媒体本身，可备份或分享'
                    : 'Export as a file — the reference media travels inside it, so it can be backed up or sent to someone'}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-50"
                >
                  {busyTransfer === entry.id ? <Spinner size={11} /> : <Icon name="download" size={12} />}
                </button>
                <LibraryDeleteButton
                  label={zh() ? `删除 ${entry.name}` : `Delete ${entry.name}`}
                  onClick={() => setConfirmDelete(entry)}
                />
              </div>
            ))}
          </div>
          <div className="border-t border-line1 pt-1.5">
            <button
              type="button"
              disabled={busyTransfer === 'import'}
              onClick={() => importInputRef.current?.click()}
              title={zh()
                ? '从文件导入角色：其媒体会重新上传并在本机加密保存'
                : "Import a persona file — its media is re-uploaded and sealed into this machine's vault"}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-line2 py-1.5 text-[11px] font-medium text-ink2 transition-colors hover:border-honey/60 hover:bg-honey-tint hover:text-honey disabled:opacity-50"
            >
              {busyTransfer === 'import' ? <Spinner size={11} /> : <Icon name="plus" size={12} />}
              {zh() ? '导入角色文件…' : 'Import a persona file…'}
            </button>
          </div>
        </div>
      ) : null}
      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importPersona(file);
        }}
      />

      <SaveNameModal
        open={saveOpen}
        busy={saving}
        title={saveAsNew ? 'Save as a new persona' : 'Save Hive Persona ID'}
        label="Character name"
        placeholder="e.g. Cheryl"
        hint={personaSummary({ ...current, gender: saveGender })}
        // Saving as new starts from a blank field so it cannot overwrite by
        // accident; the plain save pre-fills whatever is loaded.
        initialName={saveAsNew ? '' : (persona?.name || '')}
        existingLabel={zh() ? '或覆盖已保存的角色' : 'Or replace one you saved'}
        existing={entries.map((entry) => ({ id: entry.id, name: entry.name, hint: personaSummary(entry.data) }))}
        confirmLabel="Save persona"
        onClose={() => setSaveOpen(false)}
        onSave={save}
      >
        <div className="mt-3">
          <SectionLabel>{zh() ? '性别' : 'Gender'}</SectionLabel>
          <div className="mt-1.5">
            <GenderChips value={saveGender} onChange={setSaveGender} disabled={saving} />
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink3">
            {zh()
              ? '模板、演员表和 UGC 预设会据此写“她/他/他们”。'
              : 'Starters, the Cast control, UGC deals and the prompt helper write “her”, “his” or “their” from this.'}
          </p>
        </div>
        <div className="mt-3">
          <SectionLabel>{zh() ? '外貌' : 'Look'}</SectionLabel>
          <textarea
            rows={2}
            maxLength={PERSONA_LOOK_MAX}
            value={saveLook}
            disabled={saving}
            onChange={(event) => setSaveLook(event.target.value)}
            placeholder={zh()
              ? '发型、面部、体型、穿着——写出来。'
              : 'Hair, face, build, wardrobe — write it out.'}
            className="mt-1.5 w-full resize-none rounded-md border border-line1 bg-bg2 px-2.5 py-2 text-[12px] leading-snug text-ink1 outline-none placeholder:text-ink3 focus:border-honey"
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink3">
            {zh()
              ? '演员表会把它写进这个人的定义，代替占位空白。在镜头里的成员卡片上可以让助手看图生成。'
              : "Written into this person's definition by the cast instead of a blank. The member chip above the prompt can draft it from the pictures."}
          </p>
        </div>
      </SaveNameModal>

      <ConfirmModal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={remove}
        title={`Delete “${confirmDelete?.name}”?`}
        body="This removes the saved character. The reference pictures, clips and voice files themselves stay in your library."
        confirmLabel="Delete persona"
      />
    </div>
  );
}
