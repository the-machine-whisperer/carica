/**
 * Where the eleven steps sit on screen, and how the line between two of them is drawn.
 *
 * Pure arithmetic on purpose — no React, no DOM, no measuring. The component decides how
 * big a step is; this file only decides which step goes where, and what shape a connector
 * has to be so that the flow reads as a flow.
 *
 * The pipeline is *declared* as a dependency graph, not as a list, and it is drawn from
 * those dependencies rather than from the order the stages happen to be written in. Today
 * that graph is a near-linear chain of eleven, but the layout has no opinion about that:
 * add a step that depends on two others and it lands in the right column on its own.
 */

/** The structural half of `StageInfo` — all the layout needs, and all it should be given. */
export interface GraphStage {
  id: string;
  dependsOn?: string[];
}

export interface GraphNode {
  id: string;
  /** Column within its row, 0-based. */
  col: number;
  row: number;
  /** Longest-path depth from a stage with no dependencies. The true topological column. */
  depth: number;
  dependsOn: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  cols: number;
  rows: number;
  byId: Record<string, GraphNode>;
}

export interface LayoutOptions {
  /**
   * How many steps to a row before wrapping. Eleven steps in one row is 130px a step on a
   * laptop, which is a row of unreadable slivers — and the point of this screen is that a
   * step is big enough to hold its jobs.
   */
  perRow?: number;
  /**
   * Reverse every other row so the chain snakes back on itself. Off by default: a reader
   * who has to work out which way a row runs is doing the diagram's job for it.
   */
  serpentine?: boolean;
}

/**
 * Longest path from a root, per node.
 *
 * Longest rather than shortest, so a step never sits to the left of something it depends
 * on. Cycles cannot occur in a declared pipeline, but a malformed one must not hang the
 * screen, so the walk carries its own visit set and stops rather than recursing forever.
 */
function depths(stages: GraphStage[]): Record<string, number> {
  const deps = new Map(stages.map((s) => [s.id, (s.dependsOn ?? []).filter((d) => stages.some((x) => x.id === d))]));
  const memo: Record<string, number> = {};

  const walk = (id: string, seen: Set<string>): number => {
    if (memo[id] != null) return memo[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    const parents = deps.get(id) ?? [];
    const d = parents.length ? Math.max(...parents.map((p) => walk(p, seen) + 1)) : 0;
    seen.delete(id);
    memo[id] = d;
    return d;
  };

  for (const s of stages) walk(s.id, new Set());
  return memo;
}

/**
 * Lay the pipeline out as a wrapped grid, in dependency order.
 *
 * Position is by reading order — first row first, each row left to right — because that is
 * how the run itself proceeds and it is the one ordering nobody has to be taught.
 */
export function layoutGraph(stages: GraphStage[], options: LayoutOptions = {}): GraphLayout {
  const perRow = Math.max(1, options.perRow ?? 4);
  const list = stages ?? [];
  const depth = depths(list);

  // Sort by depth, and by declared order within a depth, so two steps that could run at the
  // same time sit side by side rather than in whichever order the payload arrived.
  const order = list.map((s, i) => ({ s, i })).sort((a, b) => depth[a.s.id] - depth[b.s.id] || a.i - b.i);

  const nodes: GraphNode[] = order.map(({ s }, index) => {
    const row = Math.floor(index / perRow);
    const within = index % perRow;
    const col = options.serpentine && row % 2 === 1 ? perRow - 1 - within : within;
    return { id: s.id, col, row, depth: depth[s.id] ?? 0, dependsOn: (s.dependsOn ?? []).slice() };
  });

  const byId: Record<string, GraphNode> = {};
  for (const n of nodes) byId[n.id] = n;

  const edges: GraphEdge[] = [];
  for (const n of nodes) {
    for (const from of n.dependsOn) {
      if (byId[from]) edges.push({ from, to: n.id });
    }
  }

  return {
    nodes,
    edges,
    cols: Math.min(perRow, nodes.length) || 1,
    rows: nodes.length ? Math.floor((nodes.length - 1) / perRow) + 1 : 0,
    byId,
  };
}

// ---------------------------------------------------------------- connectors

/**
 * A measured box, in the connector layer's own coordinates.
 *
 * Measured rather than computed: the grid is laid out by CSS, which mirrors itself under
 * `dir="rtl"`, and an SVG drawn from computed columns would then point at nothing. Reading
 * the boxes back means the lines follow whatever the browser actually did.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Rects = Record<string, Rect | undefined>;

/** Rounded-corner orthogonal path through a list of waypoints. */
function orth(points: { x: number; y: number }[], radius = 8): string {
  const pts = points.filter((p, i) => i === 0 || Math.abs(p.x - points[i - 1].x) > 0.5 || Math.abs(p.y - points[i - 1].y) > 0.5);
  if (pts.length < 2) return '';
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;

  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const before = { x: cur.x + ((prev.x - cur.x) / (inLen || 1)) * r, y: cur.y + ((prev.y - cur.y) / (inLen || 1)) * r };
    const after = { x: cur.x + ((next.x - cur.x) / (outLen || 1)) * r, y: cur.y + ((next.y - cur.y) / (outLen || 1)) * r };
    d += ` L ${before.x.toFixed(1)} ${before.y.toFixed(1)} Q ${cur.x.toFixed(1)} ${cur.y.toFixed(1)} ${after.x.toFixed(1)} ${after.y.toFixed(1)}`;
  }

  const last = pts[pts.length - 1];
  d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  return d;
}

export interface EdgePathOptions {
  /** The reading direction of the grid the boxes were measured in. */
  rtl?: boolean;
  /** How far outside a box the line runs before it turns. */
  gutter?: number;
  radius?: number;
}

/**
 * The SVG path for one connector.
 *
 * Two cases, and the second is the one that looks broken if it is not thought about:
 *
 *  - **Along a row.** A straight line out of the trailing edge of one step into the leading
 *    edge of the next. Nothing clever required.
 *  - **Round to the next row.** The last step of a row connects to the first step of the
 *    row below, which is all the way back across the screen. Drawn as a return: down out of
 *    the bottom of the step, along the lane between the two rows, and up into the top of
 *    the next one — the way a line of text carries on below, rather than as a diagonal
 *    slash across four unrelated steps. It stays inside the grid's own bounds, so no
 *    scrolling ancestor can clip it.
 *
 * Everything is expressed as leading/trailing rather than left/right, so the same path
 * comes out mirrored, and correct, in a right-to-left layout.
 */
export function edgePath(from: string, to: string, rects: Rects, options: EdgePathOptions = {}): string {
  const a = rects[from];
  const b = rects[to];
  if (!a || !b) return '';

  const gutter = options.gutter ?? 14;
  const dir = options.rtl ? -1 : 1;

  // Trailing edge of `a`, leading edge of `b` — mirrored under RTL.
  const start = { x: options.rtl ? a.x : a.x + a.w, y: a.y + a.h / 2 };
  const end = { x: options.rtl ? b.x + b.w : b.x, y: b.y + b.h / 2 };

  const sameRow = Math.abs(start.y - end.y) < Math.min(a.h, b.h) / 2;
  const forward = dir * (end.x - start.x) > 0;

  if (sameRow && forward) {
    // A jog through the midpoint keeps a slight height difference from becoming a diagonal.
    const midX = (start.x + end.x) / 2;
    return orth([start, { x: midX, y: start.y }, { x: midX, y: end.y }, end], options.radius ?? 8);
  }

  // The wrap. Down out of the bottom, back along the lane between the rows, up into the top.
  const lane = a.y + a.h + Math.max(gutter / 2, (b.y - (a.y + a.h)) / 2);
  const down = { x: options.rtl ? a.x + a.w * 0.25 : a.x + a.w * 0.75, y: a.y + a.h };
  const up = { x: options.rtl ? b.x + b.w * 0.75 : b.x + b.w * 0.25, y: b.y };

  return orth(
    [down, { x: down.x, y: lane }, { x: up.x, y: lane }, { x: up.x, y: up.y }],
    options.radius ?? 8
  );
}
