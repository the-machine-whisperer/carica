import { createHash } from 'node:crypto';

/**
 * Stable, content-derived ids. Deterministic on purpose: re-running a stage over the
 * same input yields the same ids, so artifacts diff cleanly across runs.
 *
 * @param {string} prefix e.g. 'it', 'st', 'cp', 'ev'
 * @param {string} seed   the content the id should be stable against (usually a URL)
 * @param {number} [len]
 */
export function stableId(prefix, seed, len = 10) {
  const h = createHash('sha256').update(String(seed)).digest('hex').slice(0, len);
  return `${prefix}_${h}`;
}

/** SHA-256 of a string, used to pin charters and the editorial policy into artifacts. */
export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Short sha for display. */
export function shortSha(text) {
  return sha256(text).slice(0, 12);
}

/**
 * Filesystem- and URL-safe run id: 2026-08-15T09-30-00Z_slug
 * @param {Date} now
 * @param {string} slug
 */
export function makeRunId(now, slug) {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  const clean = String(slug || 'run').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  return `${iso}_${clean || 'run'}`;
}
