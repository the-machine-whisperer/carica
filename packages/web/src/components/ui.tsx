import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useCopy } from '../lib/hooks';
import { GLOSSARY } from '../lib/copy';

export function Card({
  children,
  className = '',
  as: As = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: any;
}) {
  return (
    <As className={`rounded-md border border-(--color-rule) bg-white/70 ${className}`}>{children}</As>
  );
}

export function PanelHeader({
  n,
  title,
  blurb,
  right,
}: {
  n?: number;
  title: string;
  blurb?: string;
  right?: ReactNode;
}) {
  return (
    <header className="mb-5 flex items-start justify-between gap-6 border-b border-(--color-rule) pb-3">
      <div>
        <h2 className="flex items-baseline gap-2 font-serif text-2xl text-(--color-ink)">
          {n != null && <span className="text-(--color-ink-3) text-base tabular-nums">S{String(n).padStart(2, '0')}</span>}
          {title}
        </h2>
        {blurb && <p className="mt-1 text-[13px] text-(--color-ink-3)">{blurb}</p>}
      </div>
      {right}
    </header>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent';
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-(--color-paper-2) text-(--color-ink-2) border-(--color-rule)',
    ok: 'bg-[#eaf3ed] text-(--color-ok) border-[#cbe2d4]',
    warn: 'bg-[#faf2e0] text-(--color-warn) border-[#ecdcb6]',
    bad: 'bg-[#f8e9e9] text-(--color-bad) border-[#e8cdcd]',
    accent: 'bg-[#f5ebe9] text-(--color-accent) border-[#e5cfcb]',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  pending: 'bg-[#d6d1c6]',
  running: 'bg-(--color-warn) live-dot',
  ok: 'bg-(--color-ok)',
  failed: 'bg-(--color-bad)',
  skipped: 'bg-[#b9b4a8]',
};

export function StatusDot({ status, className = '' }: { status: string; className?: string }) {
  return (
    <span
      role="img"
      aria-label={status}
      className={`inline-block size-2 shrink-0 rounded-full ${STATUS_TONE[status] ?? STATUS_TONE.pending} ${className}`}
    />
  );
}

/** Horizontal score bar. `negative` flips the colour so "high risk" never reads as good. */
export function Bar({
  value,
  max = 10,
  negative = false,
  className = '',
}: {
  value: number;
  max?: number;
  negative?: boolean;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      className={`h-1.5 w-full overflow-hidden rounded-full bg-(--color-paper-2) ${className}`}
      role="img"
      aria-label={`${value} out of ${max}`}
    >
      <div
        className="h-full rounded-full transition-[width]"
        style={{
          width: `${pct}%`,
          background: negative
            ? `color-mix(in srgb, var(--color-bad) ${40 + pct * 0.6}%, #d9cfc3)`
            : `color-mix(in srgb, var(--color-accent) ${30 + pct * 0.7}%, #ded7cb)`,
        }}
      />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-(--color-rule) px-4 py-8 text-center text-[13px] text-(--color-ink-3)">
      {children}
    </div>
  );
}

export function Loading({ what = 'artifact' }: { what?: string }) {
  return (
    <div className="px-4 py-8 text-[13px] text-(--color-ink-3)" role="status" aria-live="polite">
      loading {what}…
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-[#e8cdcd] bg-[#f8e9e9] px-3 py-2 text-[13px] text-(--color-bad)">
      {children}
    </div>
  );
}

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  count,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  count?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 text-start text-[13px] text-(--color-ink-2) hover:text-(--color-ink)"
      >
        <span className={`inline-block text-[10px] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="flex-1">{summary}</span>
        {count != null && <span className="tabular-nums text-(--color-ink-3)">{count}</span>}
      </button>
      {open && (
        <div id={id} className="mt-2">
          {children}
        </div>
      )}
    </div>
  );
}

export function CopyButton({ text, label = 'copy', k }: { text: string; label?: string; k: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(text, k)}
      className="rounded border border-(--color-rule) bg-(--color-paper) px-2 py-1 text-[11px] text-(--color-ink-2) hover:bg-(--color-paper-2)"
    >
      {copied === k ? 'copied' : label}
    </button>
  );
}

export function Kv({ k, v, mono = false }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-2 text-[12px]">
      <dt className="shrink-0 text-(--color-ink-3)">{k}</dt>
      <dd className={`min-w-0 text-(--color-ink-2) ${mono ? 'font-mono text-[11px]' : ''}`}>{v}</dd>
    </div>
  );
}

/** A rule with a label — used to break long stage panels into scannable sections. */
export function Rule({ children }: { children: ReactNode }) {
  return (
    <div className="my-5 flex items-center gap-3">
      <span className="text-[11px] font-medium uppercase tracking-wider text-(--color-ink-3)">{children}</span>
      <span className="h-px flex-1 bg-(--color-rule)" />
    </div>
  );
}

// ---------------------------------------------------------------- controls

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
};

/**
 * One button, four intentions. Actions in this app spend money or write to disk, so the
 * primary variant is used sparingly — one per screen — and destructive ones look it.
 */
export function Button({ variant = 'secondary', size = 'md', busy, children, className = '', ...rest }: ButtonProps) {
  const sizes = {
    sm: 'px-2.5 py-1 text-[12px]',
    md: 'px-3.5 py-1.5 text-[13px]',
    lg: 'px-5 py-2.5 text-[15px]',
  };
  const variants = {
    primary: 'bg-(--color-accent) text-white hover:bg-[#8c3838] border border-transparent',
    secondary: 'bg-white text-(--color-ink) border border-(--color-rule) hover:bg-(--color-paper-2)',
    ghost: 'bg-transparent text-(--color-ink-2) border border-transparent hover:bg-(--color-paper-2)',
    danger: 'bg-white text-(--color-bad) border border-[#e8cdcd] hover:bg-[#f8e9e9]',
  };
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${sizes[size]} ${variants[variant]} ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-current border-e-transparent opacity-70 ${className}`}
    />
  );
}

/** Overall progress across the eleven steps. Deadline work needs a "how far along" at a glance. */
export function Progress({ done, total, tone = 'accent' }: { done: number; total: number; tone?: 'accent' | 'ok' | 'bad' }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const bg = tone === 'ok' ? 'var(--color-ok)' : tone === 'bad' ? 'var(--color-bad)' : 'var(--color-accent)';
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-(--color-paper-2)"
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={`${done} of ${total} steps done`}
    >
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: bg }} />
    </div>
  );
}

/**
 * A term with its definition one click away, in place.
 *
 * The alternative — a glossary page — is a page nobody visits while trying to get a
 * cartoon out. Definitions live in lib/copy.ts.
 */
export function Explain({ term, children }: { term: keyof typeof GLOSSARY | string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const text = GLOSSARY[term as string];
  if (!text) return <>{children}</>;
  return (
    <span className="relative inline-flex items-center gap-1">
      {children}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`What does "${term}" mean?`}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        className="inline-flex size-[14px] items-center justify-center rounded-full border border-(--color-rule) text-[9px] leading-none text-(--color-ink-3) hover:border-(--color-ink-3) hover:text-(--color-ink-2)"
      >
        ?
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute top-[120%] z-30 w-72 rounded-md border border-(--color-rule) bg-white p-2.5 text-[12px] font-normal leading-relaxed text-(--color-ink-2) shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}

/**
 * A modal dialog. Focus moves in, Escape closes, the background scrolls no further —
 * the parts people notice only when they are missing.
 */
export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>(
      'input:not([type=hidden]), select, textarea, button, [tabindex]:not([tabindex="-1"])'
    );
    first?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-[#1a1917]/35 p-4 pt-[8vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full rounded-lg border border-(--color-rule) bg-(--color-paper) shadow-xl ${wide ? 'max-w-3xl' : 'max-w-xl'}`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-(--color-rule) px-5 py-3.5">
          <div>
            <h2 id={titleId} className="font-serif text-xl text-(--color-ink)">
              {title}
            </h2>
            {description && <p className="mt-1 text-[13px] text-(--color-ink-3)">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-me-1 rounded px-2 py-0.5 text-[18px] leading-none text-(--color-ink-3) hover:bg-(--color-paper-2) hover:text-(--color-ink)"
          >
            ×
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-(--color-rule) bg-(--color-paper-2) px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/** A labelled form control with its explanation attached, not floating beside it. */
export function Field({
  label,
  hint,
  error,
  children,
  required,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: (props: { id: string; 'aria-describedby': string }) => ReactNode;
  required?: boolean;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <div className="mb-4">
      <label htmlFor={id} className="block text-[13px] font-medium text-(--color-ink)">
        {label}
        {required && <span className="ms-1 text-(--color-accent)">*</span>}
      </label>
      {hint && (
        <p id={descId} className="mt-0.5 text-[12px] leading-relaxed text-(--color-ink-3)">
          {hint}
        </p>
      )}
      <div className="mt-1.5">{children({ id, 'aria-describedby': descId })}</div>
      {error && <p className="mt-1 text-[12px] text-(--color-bad)">{error}</p>}
    </div>
  );
}

export const inputClass =
  'w-full rounded-md border border-(--color-rule) bg-white px-2.5 py-1.5 text-[13px] text-(--color-ink) placeholder:text-(--color-ink-3)/70 focus:border-(--color-accent-2)';

/** A named block of related settings or facts. */
export function Section({ title, description, children, right }: { title: string; description?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline justify-between gap-4 border-b border-(--color-rule) pb-2">
        <div>
          <h3 className="font-serif text-lg text-(--color-ink)">{title}</h3>
          {description && <p className="mt-0.5 text-[12.5px] text-(--color-ink-3)">{description}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}
