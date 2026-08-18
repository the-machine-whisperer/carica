import { useEffect, useState } from 'react';
import { api, type StageInfo, type SystemStatus, type SeedSource } from '../lib/api';
import { CODEX_COPY, STAGE_META } from '../lib/copy';
import { Badge, Button, Disclosure, Explain, Field, Modal, inputClass } from './ui';
import { SourcesModal } from './SourcesModal';
import { useToast } from './Toast';

/**
 * Starting a NEW run — the thing that used to be a terminal command.
 *
 * This dialog only ever starts something that did not exist before. Continuing a run that
 * already exists is ResumePanel's job, reached from the Carry-on button, and the two are
 * deliberately not the same screen: a resume keeps the run id and the record stays one
 * continuous story, where everything here makes a new run directory. The server enforces
 * that distinction too — `resumeRunId` and `seedFrom` are mutually exclusive in its own
 * validation — and a dialog that could do both taught the editor they were interchangeable.
 *
 * Three decisions are load-bearing here:
 *
 * 1. **Practice is offered first and costs nothing.** A run against live news spends real
 *    money — through the account the Codex command line is signed in to, since that is
 *    the only thing this project ever bills — and takes real time. Somebody meeting this
 *    app for the first time should be able to see all eleven steps work before they are
 *    asked to pay for anything.
 *
 * 2. **A blocked live run explains itself where the button is.** "Start" that silently
 *    does nothing, or fails deep in step 1, teaches people to distrust the app. If the
 *    machine cannot do a live run, the reason *and the remedy* are on this screen — and
 *    the remedy is usually a terminal command (`codex login`), not a field to fill in
 *    here, because there is no key to enter anywhere in this app.
 *
 * 3. **A new run can still start partway through** — `seedFrom`, in StartAtRow below. That
 *    is not a resume: it copies another run's earlier results into a fresh directory, which
 *    is what you want when you are trying a different rubric against this morning's news and
 *    do not want to pay to read it twice.
 */
export function RunDialog({
  system,
  stages,
  onClose,
  onStarted,
}: {
  system: SystemStatus | null;
  stages: StageInfo[];
  onClose: () => void;
  onStarted: (runId: string) => void;
}) {
  const toast = useToast();
  // Anything standing in the way of a live run, on exactly the terms the server uses to
  // compute `ready_for_live` — so the button can never be disabled with nothing on screen
  // to say why. A check the server marks informational (`blocks: null`) is not a blocker.
  const liveBlockers = (system?.checks ?? []).filter((c) => c.blocks === 'live' && c.state !== 'ok');
  const canLive = !!system?.ready_for_live;
  const canPractice = !!system?.ready_for_practice;

  const [mode, setMode] = useState<'live' | 'replay'>(canLive ? 'live' : 'replay');
  const [slug, setSlug] = useState(defaultSlug());
  const [fixture, setFixture] = useState(system?.fixtures?.[0]?.name ?? '');
  const [concurrency, setConcurrency] = useState(8);
  const [model, setModel] = useState('');
  /** Empty means every outlet. See SourcesModal. */
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [sources, setSources] = useState(false);
  /** Start a NEW run partway through, on another run's earlier results. '' = from the top. */
  const [startAt, setStartAt] = useState('');
  const [seedFrom, setSeedFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = mode === 'live' ? !canLive : !canPractice;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.startRun({
        mode,
        slug: slug || undefined,
        fixture: mode === 'replay' ? fixture || undefined : undefined,
        from: startAt || undefined,
        seedFrom: startAt ? seedFrom : undefined,
        concurrency,
        model: model || undefined,
        allowlist: allowlist.length ? allowlist : undefined,
      });
      toast(mode === 'live' ? 'Live run started.' : 'Practice run started.', 'ok');
      onStarted(res.run_id);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Start a run"
      description="Eleven steps, from reading this morning’s news to a brief the graphics desk can draw from."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={start} busy={busy} disabled={blocked}>
            {mode === 'live' ? 'Start live run' : 'Start practice run'}
          </Button>
        </>
      }
    >
      <fieldset className="mb-5">
        <legend className="sr-only">What kind of run</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <ModeCard
            selected={mode === 'replay'}
            onSelect={() => setMode('replay')}
            disabled={!canPractice}
            title="Practice run"
            cost="Free"
            tone="ok"
            body="Replays a saved snapshot of a previous news day through all eleven steps. No internet, no models, no bill."
            term="practice"
          />
          <ModeCard
            selected={mode === 'live'}
            onSelect={() => setMode('live')}
            disabled={!canLive}
            title="Live run"
            cost="Spends real money"
            tone="warn"
            body="Reads today’s Israeli political coverage and produces real drafts. Everything it spends is billed to the account the Codex command line is signed in to. Expect 20–40 minutes."
            term="live"
            disabledReason={
              liveBlockers.length
                ? `Not available yet: ${liveBlockers.map((b) => b.label).join(' and ')}. ${liveBlockers[0].fix ?? 'See Setup.'}`
                : undefined
            }
          />
        </div>
      </fieldset>

      {mode === 'live' && liveBlockers.length > 0 && (
        <div className="mb-5 rounded-md border border-[#e8cdcd] bg-[#f8e9e9] px-3 py-2.5">
          <p className="text-[13px] font-medium text-(--color-bad)">{CODEX_COPY.liveBlockedPrefix}.</p>
          <ul className="mt-1.5 space-y-1.5">
            {liveBlockers.map((b) => (
              <li key={b.id} className="text-[12px] text-(--color-ink-2)">
                <span className="font-medium">{b.label}:</span> {b.detail} {b.fix}
              </li>
            ))}
          </ul>
          <a href="#/setup" className="mt-2 inline-block text-[12px] text-(--color-accent-2) underline underline-offset-2">
            Setup shows what to do →
          </a>
        </div>
      )}

      <Field
        label="Name this run"
        hint="Anything you will recognise later — “tuesday-column”, “budget-vote”. It becomes the folder name."
      >
        {(p) => (
          <input
            {...p}
            className={inputClass}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="tuesday-column"
          />
        )}
      </Field>

      {mode === 'replay' && (system?.fixtures?.length ?? 0) > 1 && (
        <Field label="Which snapshot" hint="Saved days of data you can rehearse against.">
          {(p) => (
            <select {...p} className={inputClass} value={fixture} onChange={(e) => setFixture(e.target.value)}>
              {system!.fixtures.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name} · {f.stages} steps
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      <div className="mt-4 border-t border-(--color-rule) pt-3">
        <SourcesRow selected={allowlist} onOpen={() => setSources(true)} />
        <StartAtRow
          stages={stages}
          startAt={startAt}
          setStartAt={setStartAt}
          seedFrom={seedFrom}
          setSeedFrom={setSeedFrom}
        />
      </div>

      <div className="mt-4 border-t border-(--color-rule) pt-3">
        <Disclosure summary="Advanced">
          <Field
            label={<Explain term="parallel">How many jobs at once</Explain>}
            hint="Steps that read many outlets split into parallel jobs. Lower this if you hit rate limits."
          >
            {(p) => (
              <input
                {...p}
                type="number"
                min={1}
                max={18}
                className={`${inputClass} w-24`}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
              />
            )}
          </Field>
          <Field label="Model" hint="Leave blank to use the one configured in Setup.">
            {(p) => (
              <input {...p} className={inputClass} value={model} onChange={(e) => setModel(e.target.value)} placeholder="default" />
            )}
          </Field>
        </Disclosure>
      </div>

      {sources && (
        <SourcesModal
          selected={allowlist}
          onClose={() => setSources(false)}
          onApply={(ids) => {
            setAllowlist(ids);
            setSources(false);
          }}
        />
      )}

      {error && (
        <div className="mt-4 rounded-md border border-[#e8cdcd] bg-[#f8e9e9] px-3 py-2 text-[13px] text-(--color-bad)">{error}</div>
      )}
    </Modal>
  );
}

/** A summary of the source selection, and the way in to change it. */
function SourcesRow({ selected, onOpen }: { selected: string[]; onOpen: () => void }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="text-[13px] text-(--color-ink)">Sources to read</span>
      <span className="text-[12.5px] text-(--color-ink-3)">
        {selected.length === 0
          ? 'Every outlet in the registry'
          : `${selected.length} chosen — ${selected.slice(0, 4).join(', ')}${selected.length > 4 ? `, +${selected.length - 4}` : ''}`}
      </span>
      <button
        type="button"
        onClick={onOpen}
        className="ms-auto text-[12.5px] text-(--color-accent-2) underline underline-offset-2 hover:text-(--color-ink)"
      >
        Choose sources…
      </button>
    </div>
  );
}

/**
 * Start a NEW run partway through, on an earlier run's results.
 *
 * Steps 1 and 2 are the expensive half: the only ones that fan out to an agent per outlet
 * and the only ones that go to the open web. Re-reading this morning's news to try a
 * different rubric is waste, so this offers the results already on disk instead.
 *
 * Distinct from Continue, which carries on inside a run directory that already has them.
 */
function StartAtRow({
  stages,
  startAt,
  setStartAt,
  seedFrom,
  setSeedFrom,
}: {
  stages: StageInfo[];
  startAt: string;
  setStartAt: (v: string) => void;
  seedFrom: string;
  setSeedFrom: (v: string) => void;
}) {
  const [sources, setSources] = useState<SeedSource[] | null>(null);

  useEffect(() => {
    let live = true;
    api
      .seedSources()
      .then((s) => live && setSources(s))
      .catch(() => live && setSources([]));
    return () => {
      live = false;
    };
  }, []);

  // Only steps a chosen source can actually reach: a source holding results through step 4
  // can start you at 2, 3, 4 or 5, and no further.
  const chosen = sources?.find((s) => s.id === seedFrom) ?? null;
  const reachable = stages.filter((_s, i) => {
    if (i === 0) return false; // starting at step 1 means running it — nothing to carry over
    if (!chosen) return true;
    const idx = chosen.stages.indexOf(stages[i - 1].id);
    return idx !== -1;
  });

  const usable = sources?.filter((s) => s.stages.length > 0) ?? [];
  if (sources && !usable.length) return null; // nothing on disk to carry over yet

  return (
    <div className="mt-3 border-t border-(--color-rule) pt-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-[13px] text-(--color-ink)">Start at</span>
        <span className="text-[12.5px] text-(--color-ink-3)">
          {startAt ? 'Earlier results are carried over, not re-run' : 'The beginning — reads the news itself'}
        </span>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <select
          className={inputClass}
          value={startAt}
          onChange={(e) => {
            setStartAt(e.target.value);
            if (e.target.value && !seedFrom && usable.length) setSeedFrom(usable[0].id);
          }}
          aria-label="Which step to start at"
        >
          <option value="">Step 1 — run everything</option>
          {stages.slice(1).map((s) => (
            <option key={s.id} value={s.id} disabled={!!chosen && !reachable.some((r) => r.id === s.id)}>
              Step {String(STAGE_META[s.id]?.n ?? s.n).padStart(2, '0')} — {STAGE_META[s.id]?.title ?? s.title}
            </option>
          ))}
        </select>

        {startAt && (
          <select
            className={inputClass}
            value={seedFrom}
            onChange={(e) => setSeedFrom(e.target.value)}
            aria-label="Which run to take earlier results from"
          >
            <option value="">Take earlier results from…</option>
            {usable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.kind === 'fixture' ? 'Snapshot' : s.slug || 'run'} · {s.id} · through{' '}
                {STAGE_META[s.through ?? '']?.title ?? s.through}
              </option>
            ))}
          </select>
        )}
      </div>

      {startAt && (
        <p className="mt-2 text-[11.5px] text-(--color-ink-3)">
          Steps before {STAGE_META[startAt]?.title ?? startAt} are copied from that run and re-checked against their
          contracts before this one starts. Nothing is re-fetched, and the copied results are marked as carried over
          rather than as work this run did.
        </p>
      )}
      {startAt && !seedFrom && (
        <p className="mt-1 text-[11.5px] text-(--color-warn)">Pick where the earlier results should come from.</p>
      )}
    </div>
  );
}

function ModeCard({
  selected,
  onSelect,
  disabled,
  title,
  cost,
  tone,
  body,
  term,
  disabledReason,
}: {
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  title: string;
  cost: string;
  tone: 'ok' | 'warn';
  body: string;
  term: string;
  disabledReason?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`rounded-md border p-3 text-start transition-colors disabled:opacity-45 ${
        selected ? 'border-(--color-accent) bg-white ring-1 ring-(--color-accent)' : 'border-(--color-rule) bg-white/60 hover:bg-white'
      }`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-serif text-[15px] text-(--color-ink)">
          <Explain term={term}>{title}</Explain>
        </span>
        <Badge tone={tone}>{cost}</Badge>
      </span>
      <span className="mt-1 block text-[12px] leading-relaxed text-(--color-ink-2)">{body}</span>
      {disabled && disabledReason && (
        <span className="mt-1.5 block text-[11.5px] font-medium text-(--color-bad)">{disabledReason}</span>
      )}
    </button>
  );
}

function defaultSlug() {
  const d = new Date();
  const day = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d.getDay()];
  return `${day}-column`;
}
