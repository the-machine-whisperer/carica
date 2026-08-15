import { useEffect, useState } from 'react';
import { DIMENSIONS } from '@carica/core/browser';
import { api, type Setting, type SystemStatus } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { CODEX_COPY, SETTINGS_COPY } from '../lib/copy';
import { Badge, Button, Card, CopyButton, Explain, Field, Loading, Modal, Section, inputClass } from '../components/ui';
import { useToast } from '../components/Toast';

/**
 * Everything that used to mean editing a file by hand: readiness, models, the rubric
 * weights, and the state of the editorial policy.
 *
 * **There is nothing secret on this screen, by design.** carica holds no API key of its
 * own — every stage is an inline `codex exec`, and the Codex CLI carries its own sign-in,
 * made once in a terminal with `codex login`. So "ready for a live run" is a question
 * about a command being installed and logged in, not about a secret having been pasted
 * into a box, and this screen has no box to paste one into. If you are ever tempted to
 * add one back: the pipeline never calls a provider API directly, so a key here would be
 * a key with nothing to spend.
 */
export function SetupScreen({ system, onReloadSystem, onBack }: { system: SystemStatus | null; onReloadSystem: () => void; onBack: () => void }) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <button type="button" onClick={onBack} className="mb-4 text-[13px] text-(--color-ink-3) hover:text-(--color-ink)">
        ← Back to runs
      </button>
      <h1 className="mb-1 font-serif text-3xl text-(--color-ink)">Setup</h1>
      <p className="mb-8 max-w-2xl text-[13.5px] leading-relaxed text-(--color-ink-2)">
        {CODEX_COPY.noKeys}
      </p>

      <ReadinessSection system={system} />
      <SettingsSection onSaved={onReloadSystem} />
      <WeightsSection />
      <PolicySection system={system} />
      <AboutSection system={system} />
    </div>
  );
}

function ReadinessSection({ system }: { system: SystemStatus | null }) {
  if (!system) return <Loading what="status" />;
  return (
    <Section title="Can this computer do a live run?" description="Checked every few seconds.">
      <ul className="mb-4 space-y-2.5">
        {system.checks.map((c) => (
          <li key={c.id} className="flex gap-3">
            <span
              aria-hidden
              className={`mt-[3px] flex size-[18px] shrink-0 items-center justify-center rounded-full text-[11px] ${
                c.state === 'ok'
                  ? 'bg-[#eaf3ed] text-(--color-ok)'
                  : c.state === 'warn'
                    ? 'bg-[#faf2e0] text-(--color-warn)'
                    : 'bg-[#f8e9e9] text-(--color-bad)'
              }`}
            >
              {c.state === 'ok' ? '✓' : c.state === 'warn' ? '!' : '✗'}
            </span>
            <div>
              <div className="text-[13.5px] font-medium text-(--color-ink)">{c.label}</div>
              <div className="text-[12.5px] text-(--color-ink-2)">{c.detail}</div>
              {c.fix && <div className="mt-0.5 text-[12.5px] text-(--color-ink-3)">{c.fix}</div>}
            </div>
          </li>
        ))}
      </ul>

      <CodexCard system={system} />

      <p className="mt-3 text-[12px] text-(--color-ink-3)">
        {system.ready_for_live
          ? 'Ready for a live run.'
          : 'Practice runs work regardless of the above — they use saved data and cost nothing.'}
      </p>
    </Section>
  );
}

/**
 * The remedy panel. A check that says "not found" and stops there is no use to somebody
 * who has never opened a terminal, so the exact command to type is on the screen, next to
 * the thing it fixes, and copyable.
 */
function CodexCard({ system }: { system: SystemStatus }) {
  const { present, bin, logged_in: loggedIn, auth_file: authFile } = system.codex;

  // Four states, and the fourth one matters: `logged_in` is absent when the server could
  // not establish the session at all. "Cannot tell" is not "signed out", and showing it
  // as such on a machine that is signed in perfectly well would send someone off to fix
  // a thing that is not broken. So: not installed → signed out → cannot tell → ready.
  const state = !present ? 'missing' : loggedIn === false ? 'signed_out' : loggedIn === true ? 'ready' : 'unknown';
  const tone = state === 'missing' ? 'bad' : state === 'signed_out' ? 'warn' : state === 'unknown' ? 'neutral' : 'ok';
  const showLogin = state === 'signed_out' || state === 'unknown';

  // A plain div rather than <Card>: Card sets its own border colour, and stacking a second
  // border utility on top of it is decided by stylesheet order, not by the order of the
  // class names — so the tint would silently lose. Set both here, once.
  const skin =
    tone === 'bad'
      ? 'border-[#e8cdcd] bg-[#f8e9e9]'
      : tone === 'warn'
        ? 'border-[#ecdcb6] bg-[#faf2e0]'
        : tone === 'ok'
          ? 'border-[#cbe2d4] bg-[#eaf3ed]'
          : 'border-(--color-rule) bg-(--color-paper-2)';

  return (
    <div className={`rounded-md border px-4 py-3 ${skin}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="font-serif text-[15px] text-(--color-ink)">
          <Explain term="codex">Codex command line</Explain>
        </h4>
        <Badge tone={tone}>
          {state === 'missing'
            ? 'not installed'
            : state === 'signed_out'
              ? 'not signed in'
              : state === 'unknown'
                ? 'sign-in not known'
                : 'signed in'}
        </Badge>
      </div>

      <p className="mt-1.5 text-[12.5px] leading-relaxed text-(--color-ink-2)">
        {state === 'missing'
          ? CODEX_COPY.notInstalled
          : state === 'signed_out'
            ? CODEX_COPY.notSignedIn
            : state === 'unknown'
              ? CODEX_COPY.signInUnknown
              : CODEX_COPY.ready}
      </p>

      {showLogin && (
        <>
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded border border-(--color-rule) bg-(--color-paper-2) px-2 py-1 font-mono text-[12px] text-(--color-ink)">
              {CODEX_COPY.loginCommand}
            </code>
            <CopyButton text={CODEX_COPY.loginCommand} k="codex-login" />
          </div>
          <p className="mt-1.5 text-[12px] text-(--color-ink-3)">{CODEX_COPY.loginNote}</p>
        </>
      )}

      <dl className="mt-2.5 grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 text-[11.5px]">
        <dt className="text-(--color-ink-3)">command</dt>
        <dd className="min-w-0 break-all font-mono text-[11px] text-(--color-ink-2)">{bin}</dd>
        {authFile && (
          <>
            <dt className="text-(--color-ink-3)">sign-in kept in</dt>
            <dd className="min-w-0 break-all font-mono text-[11px] text-(--color-ink-2)">{authFile}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function SettingsSection({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const { data, loading, reload } = useAsync(() => api.settings(), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const settings = data?.settings ?? [];
  const dirty = Object.keys(draft).length > 0;

  async function save() {
    setBusy(true);
    try {
      await api.saveSettings(draft);
      setDraft({});
      toast('Saved to this computer. The next run will use it.', 'ok');
      reload();
      onSaved();
    } catch (e: any) {
      toast(String(e?.message ?? e), 'bad');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading what="settings" />;
  // If the server serves nothing editable, say nothing rather than showing an empty box.
  if (!settings.length) return null;

  return (
    <Section
      title={SETTINGS_COPY.title}
      description={SETTINGS_COPY.description}
      right={
        dirty ? (
          <Button variant="primary" size="sm" onClick={save} busy={busy}>
            Save
          </Button>
        ) : null
      }
    >
      {settings.map((s) => (
        <SettingField key={s.key} setting={s} value={draft[s.key]} onChange={(v) => setDraft({ ...draft, [s.key]: v })} />
      ))}
      {dirty && (
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={save} busy={busy}>
            Save changes
          </Button>
          <Button variant="ghost" onClick={() => setDraft({})} disabled={busy}>
            Discard
          </Button>
        </div>
      )}
    </Section>
  );
}

/**
 * One plain setting. Every value here is readable on screen and stays readable — there is
 * no masking, no reveal toggle and no password field, because nothing this app stores is
 * a secret. See the note at the top of this file before adding one.
 */
function SettingField({ setting, value, onChange }: { setting: Setting; value: string | undefined; onChange: (v: string) => void }) {
  const editing = value !== undefined;

  return (
    <Field
      label={
        <span className="flex items-center gap-2">
          {setting.label}
          {setting.present && !editing && <Badge tone="ok">set</Badge>}
          {setting.required && !setting.present && !editing && <Badge tone="bad">needed for live runs</Badge>}
        </span>
      }
      hint={
        <>
          {setting.help}
          {setting.fallback && !setting.present && (
            <span className="ms-1">Using the default, {setting.fallback}.</span>
          )}
          {setting.from_environment && <span className="ms-1">Currently coming from the system environment.</span>}
        </>
      }
    >
      {(p) => (
        <input
          {...p}
          className={inputClass}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={editing ? value : (setting.value ?? '')}
          placeholder={setting.fallback ?? 'not set'}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

function WeightsSection() {
  const toast = useToast();
  const { data, loading, reload } = useAsync(() => api.weights(), []);
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data?.weights) setDraft({ ...data.weights });
  }, [data]);

  if (loading || !draft) return <Loading what="rubric" />;

  const positiveSum = DIMENSIONS.filter((d) => !d.negative).reduce((a, d) => a + (draft[d.key] ?? 0), 0);
  const dirty = !!data && DIMENSIONS.some((d) => draft[d.key] !== data.weights[d.key]);

  async function save() {
    setBusy(true);
    try {
      const res = await api.saveWeights(draft!);
      toast(res.warning ?? 'New weights saved. The next run will use them.', res.warning ? 'info' : 'ok');
      reload();
    } catch (e: any) {
      toast(String(e?.message ?? e), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="How stories are ranked"
      description="What each of the nine scored dimensions is worth. Changing these changes which story wins."
      right={
        dirty ? (
          <Button variant="primary" size="sm" onClick={save} busy={busy}>
            Save weights
          </Button>
        ) : null
      }
    >
      <p className="mb-3 text-[12.5px] text-(--color-ink-2)">
        These are the defaults every new run starts from. You can also try different <Explain term="weights">weights</Explain>{' '}
        against a finished run on its Ranking step, which re-ranks instantly and changes nothing on disk.
      </p>

      <ul className="space-y-2">
        {DIMENSIONS.map((d) => (
          <li key={d.key} className="flex items-center gap-3">
            <label htmlFor={`w-${d.key}`} className="w-44 shrink-0 text-[13px] text-(--color-ink)" title={d.blurb}>
              {d.label}
              {d.negative && <span className="ms-1 text-[11px] text-(--color-bad)">subtracts</span>}
            </label>
            <input
              id={`w-${d.key}`}
              type="range"
              min={d.negative ? -0.5 : 0}
              max={d.negative ? 0 : 0.5}
              step={0.01}
              value={draft[d.key] ?? 0}
              onChange={(e) => setDraft({ ...draft, [d.key]: Number(e.target.value) })}
              className="h-1 flex-1 accent-(--color-accent)"
            />
            <span className="w-12 text-end font-mono text-[12px] tabular-nums text-(--color-ink-2)">
              {(draft[d.key] ?? 0).toFixed(2)}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-center gap-3 text-[12px]">
        <span className={Math.abs(positiveSum - 1) > 0.001 ? 'text-(--color-warn)' : 'text-(--color-ink-3)'}>
          Positive weights add up to {positiveSum.toFixed(2)}
          {Math.abs(positiveSum - 1) > 0.001 ? ' — they should add up to 1.00 for scores to stay on a 0–10 scale.' : '.'}
        </span>
        {dirty && data && (
          <Button size="sm" variant="ghost" onClick={() => setDraft({ ...data.weights })}>
            Reset
          </Button>
        )}
      </div>
    </Section>
  );
}

function PolicySection({ system }: { system: SystemStatus | null }) {
  const [open, setOpen] = useState(false);
  const { data: text, loading } = useAsync(() => (open ? api.policyText() : Promise.resolve(null)), [open]);
  const policy = system?.policy;

  return (
    <Section title="Editorial policy" description="What the standards check adjudicates against, clause by clause.">
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13.5px] text-(--color-ink)">
            {policy?.draft ? <Badge tone="warn">DRAFT — not signed off</Badge> : <Badge tone="ok">signed off</Badge>}
            {policy?.sha && <span className="font-mono text-[11px] text-(--color-ink-3)">{policy.sha}</span>}
          </div>
          <p className="mt-1 text-[12.5px] text-(--color-ink-2)">
            {policy?.draft
              ? 'Nothing produced here may be published until the paper’s standards desk and legal counsel have signed this off. Runs still work; publication does not.'
              : 'The version recorded with every run’s verdicts.'}
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          Read it
        </Button>
      </Card>

      {open && (
        <Modal title="Editorial policy" onClose={() => setOpen(false)} wide footer={<Button onClick={() => setOpen(false)}>Close</Button>}>
          {loading && <Loading what="policy" />}
          {text && (
            <pre className="scrollbar-thin max-h-[60vh] overflow-y-auto whitespace-pre-wrap font-serif text-[13px] leading-relaxed text-(--color-ink-2)">
              {text}
            </pre>
          )}
        </Modal>
      )}
    </Section>
  );
}

function AboutSection({ system }: { system: SystemStatus | null }) {
  return (
    <Section title="This installation">
      <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
        <dt className="text-(--color-ink-3)">Everything is stored in</dt>
        <dd className="min-w-0 break-all font-mono text-[11.5px] text-(--color-ink-2)">{system?.repo_root ?? '—'}</dd>
        <dt className="text-(--color-ink-3)">Agent runtime</dt>
        <dd className="min-w-0 break-all text-(--color-ink-2)">
          {system?.codex.present ? `Codex command line, at ${system.codex.bin}` : 'not installed on this computer'}
        </dd>
        <dt className="text-(--color-ink-3)">Node</dt>
        <dd className="text-(--color-ink-2)">{system?.node_version ?? '—'}</dd>
        <dt className="text-(--color-ink-3)">Stored credentials</dt>
        <dd className="text-(--color-ink-2)">None. Sign-in belongs to the Codex command line.</dd>
      </dl>
      <p className="mt-3 text-[12px] text-(--color-ink-3)">
        Each run writes its own folder: every result, every source the agents recorded, and the full activity log. Nothing
        is stored in a database, so a run can be re-read, re-checked or archived long after the fact.
      </p>
    </Section>
  );
}
