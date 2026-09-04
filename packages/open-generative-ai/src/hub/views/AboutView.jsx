// About — the licence surface.
//
// This app is AGPL-3.0-or-later and, until this page existed, said so nowhere in
// its own interface. GPLv3/AGPLv3 §5(d) asks an interactive program to display
// Appropriate Legal Notices — copyright, no warranty, the licence, and how to
// read it — and §6 plus AGPL §13 ask a distributed or network-served copy to
// offer its Corresponding Source. This page is that offer: version and commit,
// the licence, a link to the tagged source, the no-warranty line, and the
// generated third-party notices.
//
// One fetch of /api/about on first open, which is unauthenticated on purpose:
// the licence has to be readable before anyone signs in.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { APP_VERSION, shortCommit, versionLabel } from '../../lib/appVersion.js';
import { describeFailure } from '../../lib/describeFailure.js';
import { Button, Card, FailureCallout, Pill, SectionLabel, Spinner } from '../../ui/kit.jsx';
import { HubToolbar } from '../components/HubToolbar.jsx';

// Only the licences worth a group of their own; everything else is counted under
// "other" rather than producing a page of one-package headings.
const GROUP_MINIMUM = 2;

function normalizeLicense(value) {
  const text = String(value || '').trim();
  if (!text) return 'Unstated';
  // "MIT License" and "MIT" are the same terms written by two packaging tools.
  return text.replace(/\s+License$/i, '').replace(/\s+/g, ' ');
}

// [{ license, packages: [...] }], biggest group first, "Unstated" last so a
// missing licence is the thing left on screen rather than buried mid-list.
export function groupByLicense(packages) {
  const groups = new Map();
  for (const item of packages || []) {
    const key = normalizeLicense(item?.license);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const rows = [...groups.entries()].map(([license, items]) => ({ license, packages: items }));
  const small = rows.filter((row) => row.packages.length < GROUP_MINIMUM && row.license !== 'Unstated');
  const kept = rows.filter((row) => !small.includes(row));
  if (small.length) {
    kept.push({ license: 'Other', packages: small.flatMap((row) => row.packages) });
  }
  return kept.sort((a, b) => {
    if (a.license === 'Unstated') return 1;
    if (b.license === 'Unstated') return -1;
    return b.packages.length - a.packages.length;
  });
}

export function allNoticePackages(notices) {
  const python = notices?.python?.packages || [];
  const npm = Object.values(notices?.npm || {}).flat();
  return [...python, ...npm];
}

function Row({ label, children }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line1 py-2 last:border-b-0">
      <span className="w-28 shrink-0 text-[11px] uppercase tracking-[0.06em] text-ink3">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[13px] text-ink1">{children}</span>
    </div>
  );
}

function LicenseGroup({ group }) {
  const [open, setOpen] = useState(false);
  const shown = open ? group.packages : group.packages.slice(0, 8);
  return (
    <div className="rounded-lg border border-line1 bg-bg2 p-3">
      <div className="flex items-center justify-between gap-3">
        <b className="text-[13px] font-semibold text-ink1">{group.license}</b>
        <Pill tone={group.license === 'Unstated' ? 'warn' : 'neutral'}>{group.packages.length}</Pill>
      </div>
      <p className="mt-1.5 break-words font-mono text-[11px] leading-relaxed text-ink3 [overflow-wrap:anywhere]">
        {shown.map((item) => `${item.name}@${item.version}`).join(', ')}
      </p>
      {group.packages.length > shown.length || open ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="mt-1.5 text-[11px] font-medium text-honey hover:underline"
        >
          {open
            ? 'Show fewer'
            : `Show ${group.packages.length - shown.length} more`}
        </button>
      ) : null}
    </div>
  );
}

export function AboutView({ active }) {
  const [about, setAbout] = useState(null);
  const [failure, setFailure] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const response = await fetch('/api/about', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setAbout(await response.json());
      setLoaded(true);
    } catch (error) {
      setFailure(describeFailure(error, { operation: 'reading the version' }));
    } finally {
      setLoading(false);
    }
  }, []);

  // First open only. Nothing here changes while the app runs.
  useEffect(() => {
    if (active && !loaded && !loading) void load();
  }, [active, loaded, loading, load]);

  const groups = useMemo(() => groupByLicense(allNoticePackages(about?.notices)), [about]);
  const total = useMemo(() => allNoticePackages(about?.notices).length, [about]);

  // The chip's build-time version is shown immediately; the server's answer
  // replaces it. A disagreement means this page came from a different build than
  // the one answering, which is worth saying rather than hiding.
  const shownVersion = about?.version || APP_VERSION;
  const mismatch = Boolean(about?.version && APP_VERSION && about.version !== APP_VERSION);
  const sourceUrl = about?.source_url || 'https://github.com/LiamVisionary/hivemind-content-studio';
  const taggedSource = about?.version ? `${sourceUrl}/releases/tag/studio-v${about.version}` : sourceUrl;

  return (
    // Hub pages stay mounted and are display-toggled; the shell topbar already
    // names the page, so the toolbar carries the kicker and this body scrolls
    // inside itself (DESIGN.md §2).
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar
        kicker="About"
        title={about?.product || 'Hivemind Content Studio'}
        subtitle="The build running on this machine, the licence it is under, and everything it is made of."
        right={<Pill tone="neutral">{about?.license || 'AGPL-3.0-or-later'}</Pill>}
      />
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-6">
        {failure ? (
          <FailureCallout
            title={failure.title}
            detail={failure.detail}
            onRetry={load}
            retryDisabled={loading}
            retryLabel="Try again"
          />
        ) : null}

        <Card className="p-4">
          <Row label="Version">
            <span className="font-mono">{versionLabel({ version: shownVersion, commit: about?.commit }) || (loading ? '…' : '—')}</span>
            {mismatch ? (
              <span className="ml-2 text-[11px] text-warn">
                {`this page was built from ${APP_VERSION} — reload to catch up`}
              </span>
            ) : null}
          </Row>
          <Row label="Built">
            <span className="font-mono">{about?.build_date ? String(about.build_date).slice(0, 10) : '—'}</span>
          </Row>
          <Row label="Licence">
            {about?.license || 'AGPL-3.0-or-later'}
          </Row>
          <Row label="Source">
            <a
              href={taggedSource}
              target="_blank"
              rel="noreferrer"
              className="text-honey hover:underline"
            >
              View source
            </a>
            <span className="ml-2 text-[11px] text-ink3">
              {about?.commit
                ? `this build is commit ${shortCommit(about.commit)}`
                : 'the complete corresponding source'}
            </span>
          </Row>
          <Row label="Security">
            <a
              href={`${sourceUrl}/security/advisories/new`}
              target="_blank"
              rel="noreferrer"
              className="text-honey hover:underline"
            >
              Report a vulnerability privately
            </a>
            <span className="ml-2 text-[11px] text-ink3">
              what listens where, and what authenticates it, is in .github/SECURITY.md
            </span>
          </Row>
        </Card>

        <section className="flex flex-col gap-2">
          <SectionLabel>Warranty</SectionLabel>
          <Card className="p-4 text-[13px] leading-relaxed text-ink2">
            <p>
              This program comes with ABSOLUTELY NO WARRANTY, to the extent permitted by applicable law — not even the implied warranty of merchantability or fitness for a particular purpose.
            </p>
            <p className="mt-2">
              This is free software, and you are welcome to redistribute and modify it under the terms of the GNU Affero General Public License, version 3 or later.
            </p>
            <p className="mt-2 text-ink3">
              The full licence text ships with the app (LICENSE); the donor and component provenance is in THIRD_PARTY_NOTICES.md.
            </p>
          </Card>
        </section>

        <section className="flex flex-col gap-2">
          <SectionLabel>What's new</SectionLabel>
          {about?.whats_new?.length ? (
            <Card className="p-4">
              <ul className="flex flex-col gap-2">
                {about.whats_new.map((entry) => (
                  <li key={`${entry.date}-${entry.title}`} className="flex flex-col gap-0.5">
                    <span className="font-mono text-[11px] text-ink3">{entry.date}</span>
                    <span className="text-[13px] text-ink1">{entry.title}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : (
            <Card className="p-4 text-[13px] text-ink3">
              This build did not ship a changelog. The full history is in CHANGELOG.md in the source above.
            </Card>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <SectionLabel>
            Third-party notices
            {total ? <span className="ml-2 font-normal text-ink3">{total}</span> : null}
          </SectionLabel>
          {loading && !about ? (
            <div className="grid place-items-center py-10"><Spinner size={20} className="text-ink2" /></div>
          ) : about?.notices?.available === false ? (
            // A build that shipped without running the notices generator. The
            // page still carries the licence and the source; this says exactly
            // what is missing and how it comes back.
            <Card className="flex flex-col items-start gap-2 p-4">
              <p className="text-[13px] text-ink2">
                This build shipped without the generated dependency licence list.
              </p>
              <p className="font-mono text-[11px] text-ink3">python3 scripts/generate_notices.py</p>
              <Button size="sm" variant="neutral" icon="refresh" onClick={load} disabled={loading}>
                Try again
              </Button>
            </Card>
          ) : groups.length ? (
            <>
              <p className="text-[12px] text-ink3">
                Grouped by licence, generated at build time from the installed Python distributions and the three npm lockfiles.
                {about?.notices?.generated_at ? ` · ${about.notices.generated_at}` : ''}
              </p>
              <div className="grid gap-2 md:grid-cols-2">
                {groups.map((group) => <LicenseGroup key={group.license} group={group} />)}
              </div>
            </>
          ) : null}
        </section>
      </div>
      </div>
    </div>
  );
}
