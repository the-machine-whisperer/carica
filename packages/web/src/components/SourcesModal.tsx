import { useEffect, useMemo, useState } from 'react';
import { api, type RegistryOutlet } from '../lib/api';
import { Badge, Button, Loading, Modal, inputClass } from './ui';

/**
 * Which outlets a run reads.
 *
 * Empty means all of them, and that stays the default — an editor with no opinion should
 * not be made to form one. The reason to form one is on screen: every outlet ticked here
 * becomes its own agent in step 2, and on an ordinary news day most of the registry is
 * carrying the same few stories, so the extra agents buy duplicate coverage of the same
 * wire copy.
 *
 * This screen only ever NARROWS. Nothing typed here can add an outlet the registry does
 * not define, and an outlet ticked here that step 1 does not rank is reported in the run
 * log as not harvested rather than invented into existence.
 */
export function SourcesModal({
  selected,
  onApply,
  onClose,
}: {
  selected: string[];
  onApply: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [outlets, setOutlets] = useState<RegistryOutlet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>(selected);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let live = true;
    api
      .config()
      .then((c) => live && setOutlets((c.outlets?.outlets ?? []) as RegistryOutlet[]))
      .catch((e) => live && setError(String(e?.message ?? e)));
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => {
    if (!outlets) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return outlets;
    return outlets.filter((o) =>
      [o.id, o.name_en, o.name_he, o.lean].some((v) => String(v ?? '').toLowerCase().includes(q))
    );
  }, [outlets, filter]);

  const all = draft.length === 0;
  const toggle = (id: string) => setDraft((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));

  // Below five, step 1 cannot be narrowed: its contract requires a ranking of at least five
  // outlets, and a three-outlet ranking would fail it. The harvest narrows regardless, and
  // that is where the per-outlet agents are — but say so rather than let the editor wonder
  // why step 1 still discusses outlets they excluded.
  const belowRankingFloor = draft.length > 0 && draft.length < 5;

  return (
    <Modal
      title="Which sources to read"
      description="Step 2 runs one agent per outlet. Fewer outlets is faster and cheaper — and on most days it is the same news."
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onApply(draft)} disabled={!outlets}>
            {all ? 'Use all sources' : `Use these ${draft.length}`}
          </Button>
        </>
      }
    >
      {error && <p className="text-[13px] text-(--color-bad)">The outlet registry could not be read: {error}</p>}
      {!outlets && !error && <Loading what="the outlet list" />}

      {outlets && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name or leaning…"
              aria-label="Filter outlets"
              className={`${inputClass} w-56`}
            />
            <div className="flex gap-3 text-[11.5px]">
              <button type="button" className="underline underline-offset-2 hover:text-(--color-ink)" onClick={() => setDraft([])}>
                Use all
              </button>
              <button
                type="button"
                className="underline underline-offset-2 hover:text-(--color-ink)"
                onClick={() => setDraft(outlets.slice(0, 5).map((o) => o.id))}
              >
                Top 5 by standing
              </button>
              <button
                type="button"
                className="underline underline-offset-2 hover:text-(--color-ink)"
                onClick={() => setDraft(shown.map((o) => o.id))}
                disabled={!shown.length}
              >
                Tick everything shown
              </button>
            </div>
            <span className="ms-auto text-[11.5px] text-(--color-ink-3)">
              {all ? `all ${outlets.length}` : `${draft.length} of ${outlets.length}`}
            </span>
          </div>

          <ul className="scrollbar-thin max-h-[46vh] overflow-y-auto rounded border border-(--color-rule)">
            {shown.map((o) => {
              const on = draft.includes(o.id);
              return (
                <li key={o.id} className="border-b border-(--color-rule) last:border-b-0">
                  <label
                    className={`flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-(--color-paper-2) ${
                      on ? 'bg-(--color-paper-2)' : ''
                    }`}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggle(o.id)} className="accent-(--color-accent)" />
                    <span className="text-[13px] text-(--color-ink)">{o.name_en}</span>
                    <span className="text-[12px] text-(--color-ink-3)" dir="rtl">
                      {o.name_he}
                    </span>
                    <span className="ms-auto flex items-center gap-2">
                      {o.paywall && o.paywall !== 'none' && (
                        <span className="text-[10.5px] text-(--color-ink-3)" title="Headline and dek only — never read behind a paywall">
                          {o.paywall} paywall
                        </span>
                      )}
                      {o.lean && <Badge tone="neutral">{o.lean}</Badge>}
                    </span>
                  </label>
                </li>
              );
            })}
            {!shown.length && <li className="px-3 py-4 text-[12.5px] text-(--color-ink-3)">Nothing matches that.</li>}
          </ul>

          <p className="mt-3 text-[11.5px] text-(--color-ink-3)">
            {all
              ? `Nothing ticked, so all ${outlets.length} outlets are read — ${outlets.length} parallel jobs in step 2.`
              : `${draft.length} parallel job${draft.length === 1 ? '' : 's'} in step 2 instead of ${outlets.length}.`}{' '}
            An outlet you tick that step 1 does not rank is reported as not harvested, never invented.
          </p>

          {belowRankingFloor && (
            <p className="mt-2 rounded border border-[#ecdcb6] bg-[#faf2e0] px-2.5 py-1.5 text-[11.5px] text-(--color-warn)">
              With fewer than five, step 1 still ranks every outlet — a ranking needs at least five to mean anything —
              and only step 2 is narrowed to your {draft.length}.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
