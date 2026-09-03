// Past restorations, and the one thing this list is really for: getting back
// into a render that stopped.
//
// A chunked render is the kind of job a laptop lid closes on. Every project
// here keeps its finished chunks, so the row's action is "resume" rather than
// "start again" — and the row says how far it got, because "6 of 14 chunks"
// is the difference between resuming and giving up.
import { Button, Card, EmptyState, Pill, SectionLabel, cx } from '../../ui/kit.jsx';
import { Icon } from '../../ui/icons.jsx';

const TONE = {
  complete: 'ok',
  running: 'honey',
  stopped: 'neutral',
  error: 'danger',
  awaiting_assembly: 'warn',
  queued: 'neutral',
};

const WORDS = {
  complete: 'Finished',
  running: 'Running',
  stopped: 'Stopped',
  error: 'Failed',
  awaiting_assembly: 'Needs joining',
  queued: 'Queued',
};

function when(value) {
  if (!value) return '';
  try { return new Date(value).toLocaleString(); } catch { return ''; }
}

export function RestoreProjects({ projects, activeId, onOpen, onResume, onDelete, busy }) {
  if (!projects.length) {
    return (
      <EmptyState
        icon="film"
        title="No restorations yet"
        hint="Load a clip, render a short preview, and decide whether the model helps this footage before committing to the whole thing."
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Projects</SectionLabel>
      {projects.map((project) => {
        const done = project.progress?.chunks_done ?? 0;
        const total = project.progress?.chunks_total ?? 0;
        const unfinished = project.status !== 'complete' && done < total;
        return (
          <Card
            key={project.id}
            className={cx('flex flex-col gap-2 p-3', project.id === activeId && 'border-honey')}
          >
            <div className="flex items-center gap-2">
              <Icon name={project.preview ? 'eye' : 'film'} size={14} />
              <span className="text-sm font-medium text-ink1">
                {project.width}x{project.height}
                {project.preview ? ' preview' : ''}
              </span>
              <Pill tone={TONE[project.status] || 'neutral'} className="ml-auto">
                {WORDS[project.status] || project.status}
              </Pill>
            </div>
            <div className="text-[11px] text-ink3">
              {total ? `${done} of ${total} chunks` : 'no chunks yet'}
              {project.sink === 'clip' ? ' — rendered on a rented machine' : ''}
              {when(project.updated_at) ? ` · ${when(project.updated_at)}` : ''}
            </div>
            {project.error ? (
              <div className="rounded bg-danger-tint px-2 py-1 text-[11px] leading-snug text-danger">{project.error}</div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon="eye" onClick={() => onOpen(project)}>Open</Button>
              {unfinished ? (
                <Button
                  size="sm"
                  icon="play"
                  disabled={busy || !project.has_source}
                  onClick={() => onResume(project)}
                  title={project.has_source
                    ? 'Continues from the first chunk with no file, under this project\'s original settings'
                    : 'The source clip for this project is gone — load it again to resume'}
                >
                  Resume
                </Button>
              ) : null}
              <Button size="sm" icon="trash" variant="ghost" disabled={busy} onClick={() => onDelete(project)}>
                Delete
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
