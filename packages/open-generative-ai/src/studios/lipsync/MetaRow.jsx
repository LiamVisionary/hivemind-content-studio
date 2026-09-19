// One label/value row for a result viewer's metadata block — shared by the
// Cinema and Lip sync viewers (each used to carry its own copy).
export function MetaRow({ label, value, mono = true }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-20 shrink-0 text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">{label}</span>
      <span className={`min-w-0 break-words text-xs leading-relaxed text-ink1 ${mono ? 'font-mono' : ''}`}>{String(value)}</span>
    </div>
  );
}
