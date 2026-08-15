import { useEffect, useState } from 'react';
import { useArtifact, useAsync } from '../lib/hooks';
import { api } from '../lib/api';
import { Badge, Button, Card, Empty, ErrorNote, Explain, Loading, PanelHeader } from '../components/ui';
import { useToast } from '../components/Toast';
import { Glossed } from '../lib/bidi';
import { clock } from '../lib/format';
import type { ViewProps } from './types';

type Decision = 'approved' | 'revision_requested' | 'rejected';

const CHOICES: { value: Decision; label: string; tone: 'ok' | 'warn' | 'bad' }[] = [
  { value: 'approved', label: 'Approve', tone: 'ok' },
  { value: 'revision_requested', label: 'Request revision', tone: 'warn' },
  { value: 'rejected', label: 'Reject', tone: 'bad' },
];

/**
 * The human checkpoint. The pipeline never self-approves — S11 reads what is written here
 * and refuses to invent a decision the editor did not make.
 */
export function PublishView({ runId, version, state }: ViewProps) {
  const { data: prompts, loading } = useArtifact<any>(runId, '08_prompts.json', version);
  const { data: gate } = useArtifact<any>(runId, '09_gate.json', version);
  const { data: published } = useArtifact<any>(runId, '11_publish.json', version);
  const { data: existing, reload } = useAsync(() => api.decisions(runId), [runId, version]);

  const toast = useToast();
  const [editor, setEditor] = useState('');
  const [choices, setChoices] = useState<Record<string, { decision: Decision; note: string }>>({});
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const seed: Record<string, { decision: Decision; note: string }> = {};
    for (const d of published?.decisions ?? existing ?? []) {
      seed[d.concept_id] = { decision: d.decision, note: d.editor_note ?? '' };
      if (d.decided_by && !editor) setEditor(d.decided_by);
    }
    setChoices(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [published, existing]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('carica.editor');
      if (saved) setEditor((e) => e || saved);
    } catch {
      /* private mode */
    }
  }, []);

  if (loading) return <Loading what="candidates" />;
  if (!prompts) return <Empty>No prompt packages to decide on yet.</Empty>;

  const verdictFor = (id: string) => (gate?.verdicts ?? []).find((v: any) => v.concept_id === id);
  const decidable = prompts.packages.filter((p: any) => verdictFor(p.concept_id)?.verdict !== 'BLOCK');
  const blocked = prompts.packages.filter((p: any) => verdictFor(p.concept_id)?.verdict === 'BLOCK');
  const complete = decidable.every((p: any) => choices[p.concept_id]?.decision);

  async function submit() {
    setErr(null);
    setSaving(true);
    try {
      try {
        localStorage.setItem('carica.editor', editor);
      } catch {
        /* private mode */
      }
      const decisions = decidable
        .filter((p: any) => choices[p.concept_id]?.decision)
        .map((p: any) => ({
          story_id: p.story_id,
          concept_id: p.concept_id,
          decision: choices[p.concept_id].decision,
          decided_by: editor.trim(),
          editor_note: choices[p.concept_id].note,
        }));
      await api.postDecisions(runId, decisions);
      setSaved(new Date().toISOString());
      toast('Decisions recorded against your name.', 'ok');
      reload();
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Export the briefs. This runs step 11 again — which reads the decisions just recorded
   * and writes the graphics desk's brief. The pipeline still cannot approve itself: it is
   * reading a file only a named editor can have written.
   */
  async function exportBriefs() {
    setErr(null);
    setExporting(true);
    try {
      await api.startRun({
        mode: (state.mode as 'live' | 'replay') ?? 'live',
        resumeRunId: runId,
        from: 'publish',
      });
      toast('Exporting the briefs…', 'ok');
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <PanelHeader
        n={11}
        title="Your approval"
        blurb="Nothing leaves this app until you sign each candidate off by name. This step cannot approve itself."
        right={published ? <Badge tone="ok">exported</Badge> : null}
      />

      {state.humanRequired && (
        <div className="mb-4 rounded-md border border-[#ecdcb6] bg-[#faf2e0] px-3 py-2 text-[12px] text-(--color-warn)">
          {state.humanRequired.message}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-[12px]">
          <span className="block text-[11px] text-(--color-ink-3)">Deciding editor</span>
          <input
            value={editor}
            onChange={(e) => setEditor(e.target.value)}
            placeholder="your name"
            className="mt-0.5 w-56 rounded border border-(--color-rule) bg-white px-2 py-1 text-[13px]"
          />
        </label>
        <p className="mb-1 text-[11px] text-(--color-ink-3)">
          Decisions are attributable — the name is recorded with each one.
        </p>
      </div>

      <ul className="space-y-3">
        {decidable.map((p: any) => {
          const v = verdictFor(p.concept_id);
          const cur = choices[p.concept_id];
          return (
            <Card key={p.concept_id} className="px-3 py-3">
              <div className="flex items-start justify-between gap-4">
                <Glossed
                  he={p.premise_he}
                  en={p.premise_en}
                  className="min-w-0"
                  heClass="font-serif text-[15px] leading-snug"
                  enClass="mt-0.5 text-[12px] text-(--color-ink-2)"
                />
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {v && <Badge tone={v.verdict === 'PASS' ? 'ok' : 'warn'}>gate: {v.verdict}</Badge>}
                  <span className="font-mono text-[10px] text-(--color-ink-3)">{p.concept_id}</span>
                </div>
              </div>

              {v?.revision_asks?.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {v.revision_asks.map((a: string, i: number) => (
                    <li key={i} className="text-[11px] text-(--color-warn)">
                      gate asks: {a}
                    </li>
                  ))}
                </ul>
              )}

              {p.risk_notes?.filter((r: any) => r.severity === 'high').length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {p.risk_notes
                    .filter((r: any) => r.severity === 'high')
                    .map((r: any, i: number) => (
                      <li key={i} className="text-[11px] text-(--color-bad)">
                        {r.kind.replace(/_/g, ' ')}: {r.note}
                      </li>
                    ))}
                </ul>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {CHOICES.map((c) => {
                  const active = cur?.decision === c.value;
                  return (
                    <button
                      key={c.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() =>
                        setChoices({ ...choices, [p.concept_id]: { decision: c.value, note: cur?.note ?? '' } })
                      }
                      className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${
                        active
                          ? c.tone === 'ok'
                            ? 'border-(--color-ok) bg-[#eaf3ed] text-(--color-ok)'
                            : c.tone === 'warn'
                              ? 'border-(--color-warn) bg-[#faf2e0] text-(--color-warn)'
                              : 'border-(--color-bad) bg-[#f8e9e9] text-(--color-bad)'
                          : 'border-(--color-rule) bg-white text-(--color-ink-2) hover:bg-(--color-paper-2)'
                      }`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>

              <textarea
                value={cur?.note ?? ''}
                onChange={(e) =>
                  setChoices({
                    ...choices,
                    [p.concept_id]: { decision: cur?.decision ?? 'approved', note: e.target.value },
                  })
                }
                placeholder="Note for the graphics team or the record…"
                rows={2}
                aria-label={`Editor note for ${p.concept_id}`}
                className="mt-2 w-full rounded border border-(--color-rule) bg-white px-2 py-1.5 text-[12px]"
              />
            </Card>
          );
        })}
      </ul>

      {blocked.length > 0 && (
        <div className="mt-4 rounded-md border border-[#e8cdcd] bg-[#f8e9e9] px-3 py-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-(--color-bad)">
            <Explain term="gate">Blocked by the standards check</Explain> — not offered for decision
          </div>
          <ul className="mt-1 space-y-0.5">
            {blocked.map((p: any) => (
              <li key={p.concept_id} className="text-[12px] text-(--color-ink-2)">
                <span className="font-mono text-[11px]">{p.concept_id}</span> —{' '}
                {verdictFor(p.concept_id)?.block_reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {err && (
        <div className="mt-4">
          <ErrorNote>{err}</ErrorNote>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-(--color-rule) pt-3">
        <Button variant="primary" disabled={!editor.trim() || !complete} busy={saving} onClick={submit}>
          Record decisions
        </Button>

        {saved && (
          <Button busy={exporting} onClick={exportBriefs}>
            Export the briefs
          </Button>
        )}

        <span className="text-[11.5px] text-(--color-ink-3)">
          {!editor.trim()
            ? 'Put your name in first — every decision is recorded against it.'
            : !complete
              ? 'Every candidate needs a decision before you can record them.'
              : saved
                ? `Recorded at ${clock(saved)}. Export writes the graphics desk's brief for everything you approved.`
                : 'Recording your decisions does not publish anything — it saves them for the export step.'}
        </span>
      </div>

      {published?.decisions?.length > 0 && (
        <div className="mt-5">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-(--color-ink-3)">Exported record</h3>
          <ul className="mt-1 space-y-1">
            {published.decisions.map((d: any, i: number) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2 text-[12px]">
                <Badge tone={d.decision === 'approved' ? 'ok' : d.decision === 'rejected' ? 'bad' : 'warn'}>
                  {d.decision.replace(/_/g, ' ')}
                </Badge>
                <span className="font-mono text-[11px] text-(--color-ink-3)">{d.concept_id}</span>
                <span className="text-(--color-ink-3)">{d.decided_by}</span>
                {d.brief_path && (
                  <a
                    href={`/api/runs/${encodeURIComponent(runId)}/brief/${encodeURIComponent(
                      d.brief_path.replace(/^out\//, '')
                    )}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-(--color-accent-2) underline underline-offset-2"
                  >
                    brief
                  </a>
                )}
                {d.editor_note && <span className="text-(--color-ink-2)">“{d.editor_note}”</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
