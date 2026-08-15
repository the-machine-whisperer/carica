import type { ReactNode } from 'react';

// Hebrew block + presentation forms.
const HEBREW = /[֐-׿יִ-ﭏ]/g;
const LATIN = /[A-Za-z]/g;

/**
 * Direction from content, not from a guess about the user.
 *
 * Israeli source material is overwhelmingly Hebrew and the app shows it side by side with
 * English glosses. Getting direction wrong does not merely look untidy — a Hebrew sentence
 * laid out left-to-right is genuinely hard to read, and punctuation lands in the wrong place.
 */
export function detectDir(text: unknown): 'rtl' | 'ltr' {
  if (typeof text !== 'string' || !text) return 'ltr';
  const he = (text.match(HEBREW) ?? []).length;
  const la = (text.match(LATIN) ?? []).length;
  return he > la ? 'rtl' : 'ltr';
}

/**
 * Renders text in its own direction, isolated so it cannot reorder the line around it.
 * Prefer passing an explicit `dir` when the data carries one (harvested items do).
 */
export function Bidi({
  text,
  dir,
  className = '',
  as: As = 'span',
}: {
  text: string | undefined | null;
  dir?: 'rtl' | 'ltr';
  className?: string;
  as?: any;
}) {
  if (text == null || text === '') return null;
  const d = dir ?? detectDir(text);
  return (
    <As dir={d} className={`isolate-bidi ${d === 'rtl' ? 'prose-he' : ''} ${className}`}>
      {text}
    </As>
  );
}

/** A Hebrew line with its English gloss underneath — the recurring pattern in this app. */
export function Glossed({
  he,
  en,
  className = '',
  heClass = '',
  enClass = '',
}: {
  he?: string | null;
  en?: string | null;
  className?: string;
  heClass?: string;
  enClass?: string;
}) {
  if (!he && !en) return null;
  return (
    <div className={className}>
      {he ? <Bidi as="div" text={he} dir="rtl" className={heClass} /> : null}
      {en ? (
        <div dir="ltr" className={`isolate-bidi ${enClass}`}>
          {en}
        </div>
      ) : null}
    </div>
  );
}

export function Quote({ he, en, source }: { he?: string; en?: string; source?: string }): ReactNode {
  if (!he && !en) return null;
  return (
    <blockquote className="mt-2 border-s-2 border-(--color-rule) ps-3 text-[13px] text-(--color-ink-2)">
      <Glossed he={he} en={en} heClass="font-serif" enClass="mt-0.5 italic text-(--color-ink-3)" />
      {source ? (
        <a
          href={source}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-1 inline-block text-[11px] text-(--color-accent-2) underline underline-offset-2"
        >
          source
        </a>
      ) : null}
    </blockquote>
  );
}
