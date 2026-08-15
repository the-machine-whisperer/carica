import { useState } from 'react';
import { api, type StageInfo, type SystemStatus, type RunSummary } from '../lib/api';
import { CODEX_COPY, STAGE_META } from '../lib/copy';
import { Badge, Button, Disclosure, Explain, Field, Modal, inputClass } from './ui';
import { useToast } from './Toast';

/**
 * Starting a run — the thing that used to be a terminal command.
 *
 * Two decisions are load-bearing here:
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
 */
export function RunDialog({
  system,
  stages,
  onClose,
  onStarted,
  continueRun,
}: {
  system: SystemStatus | null;
  stages: StageInfo[];
  onClose: () => void;
  onStarted: (runId: string) => void;
  /** Present when continuing an existing run rather than starting a new one. */
  continueRun?: { run: RunSummary; suggestedStage: string | null };
}) {
  const toast = useToast();
  const isContinue = !!continueRun;
  // Anything standing in the way of a live run, on exactly the terms the server uses to
  // compute `ready_for_live` — so the button can never be disabled with nothing on screen
  // to say why. A check the server marks informational (`blocks: null`) is not a blocker.
  const liveBlockers = (system?.checks ?? []).filter((c) => c.blocks === 'live' && c.state !== 'ok');
  const canLive = !!system?.ready_for_live;
  const canPractice = !!system?.ready_for_practice;

  const [mode, setMode] = useState<'live' | 'replay'>(
    isContinue ? ((continueRun!.run.mode as 'live' | 'replay') ?? 'replay') : canLive ? 'live' : 'replay'
  );
  const [slug, setSlug] = useState(isContinue ? (continueRun!.run.slug ?? '') : defaultSlug());
  const [fixture, setFixture] = useState(system?.fixtures?.[0]?.name ?? '');
  const [from, setFrom] = useState(continueRun?.suggestedStage ?? 'outlets');
  const [concurrency, setConcurrency] = useState(4);
  const [model, setModel] = useState('');
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
        from: isContinue ? from : undefined,
        resumeRunId: isContinue ? continueRun!.run.run_id : undefined,
        concurrency,
        model: model || undefined,
      });
      toast(isContinue ? 'Continuing the run.' : mode === 'live' ? 'Live run started.' : 'Practice run started.', 'ok');
      onStarted(res.run_id);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isContinue ? 'Continue this run' : 'Start a run'}
      description={
        isContinue
          ? 'Steps that already produced a valid result are kept, not redone.'
          : 'Eleven steps, from reading this morning’s news to a brief the graphics desk can draw from.'
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={start} busy={busy} disabled={blocked}>
            {isContinue ? `Continue from ${STAGE_META[from]?.title ?? from}` : mode === 'live' ? 'Start live run' : 'Start practice run'}
          </Button>
        </>
      }
    >
      {!isContinue && (
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
      )}

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
            disabled={isContinue}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="tuesday-column"
          />
        )}
      </Field>

      {mode === 'replay' && !isContinue && (system?.fixtures?.length ?? 0) > 1 && (
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

      {isContinue && (
        <Field
          label="Continue from which step"
          hint="Earlier steps are reused if their results still pass their checks, so nothing is paid for twice."
        >
          {(p) => (
            <select {...p} className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)}>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {String(STAGE_META[s.id]?.n ?? s.n).padStart(2, '0')} · {STAGE_META[s.id]?.title ?? s.title}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

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
                max={12}
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

      {error && (
        <div className="mt-4 rounded-md border border-[#e8cdcd] bg-[#f8e9e9] px-3 py-2 text-[13px] text-(--color-bad)">{error}</div>
      )}
    </Modal>
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
