/**
 * SmoothCut — the flagship of Ania 2.0, and the one part of it that has nothing to do
 * with a camera.
 *
 * The owner's verdict on what Ania 2.0 was for (2026-09-05):
 *
 *     "o maior problema do Ania 1 era a transição de talk para idle...
 *      o Ania 2 nasceu justamente pra resolver isso"
 *
 * The Ania 1.0 player cuts between sequences by index, not by image. When speech ends it
 * jumps from wherever the talk sweep happened to be to `idle_range_low` (or to a random
 * entry from `idle_start_positions`), and the two frames on either side of that cut have
 * no reason whatsoever to look alike. The mouth is open in one and shut in the next; the
 * head is turned one way and then the other. That is the pop everybody sees, and it fires
 * on every talk->idle, idle->talk, action exit and range wrap.
 *
 * The motion graph already knows what those cuts cost — it is a table of "these two
 * frames look alike enough to cut between, and here is how much it shows". So the fix is
 * not to invent new frames, it is to CHOOSE the entry frame the graph says is cheapest:
 *
 *   1. Pick the entry in the target range that minimises `c(current, candidate)`.
 *   2. If even the best entry is still a visible jump (`>= costThreshold`, the same 6 the
 *      crossfade trigger uses), look for a short BRIDGE — 1..`maxBridge` frames chained
 *      through the graph's own edges — and play it on the way in. A bridge is the
 *      avatar's own footage, so it reads as motion rather than as a dissolve.
 *   3. Only if no bridge exists does the renderer fall back to a <= 120 ms crossfade.
 *
 * Independence is the point of this module. It needs a `motionGraph` and nothing else:
 * no webcam, no pose bank, no descriptors, no `setMocapEnabled(true)`. A page that only
 * ever plays TTS gets every one of these cuts fixed. Without a graph every method is
 * inert and the caller keeps its own choice byte for byte, which is what keeps
 * `player-runtime/verify.mjs` frame-identical.
 *
 * Determinism is load-bearing: every ordering below breaks ties explicitly (cost, then
 * closeness to the author's own start points, then the lower index), because the three
 * runtimes and the Python reference all have to land on the same frame.
 */

import type { MotionGraph } from './matcher';
import { SIG_LEN, signature } from './graph-builder';
import type { FramePixels } from './graph-builder';

/** A transition this expensive is a visible jump (the §4.2 crossfade trigger). */
export const CUT_COST_THRESHOLD = 6.0;
/** Cost of a cut nothing in the graph sanctions — mirrors `MatcherOptions.c_jump`. */
export const CUT_C_JUMP = 8.0;
/** Longest bridge the search will play, in frames. */
export const CUT_MAX_BRIDGE = 3;
/** Hard ceiling on edge expansions per bridge search, so a dense graph cannot stall. */
export const CUT_MAX_EXPANSIONS = 64;
/** Longest dissolve, when there is no bridge to play instead. */
export const CUT_CROSSFADE_MS = 120.0;
/** Costs equal to this many decimal places count as a tie. */
export const CUT_TIE_DECIMALS = 3;
/** A candidate within this much of the best cost is "just as smooth" (bias window). */
export const CUT_BIAS_SLACK = 0.5;
/**
 * Ceiling on a signature-derived cost. `graph.build_graph` clips at this because a graph
 * only ever stores CHEAP edges; a cut between two ranges is nowhere near it, so the entry
 * ranking is deliberately left UNCLIPPED - clipping it would make every candidate tie at
 * 20 and the search would pick by index, which is exactly the bug that made the first
 * bench report "0 % improvement" while the picture plainly improved.
 */
export const CUT_COST_CLIP = 20.0;

export interface SmoothCutOptions {
  /**
   * `true` cuts through the graph whenever one is loaded, `false` never does, `'auto'`
   * is `true` when a graph is present — the same thing, spelled the way a config file
   * spells it.
   */
  enabled: boolean | 'auto';
  /** Longest bridge to play, in frames. 0 disables bridging (crossfade only). */
  maxBridge: number;
  /** Longest dissolve when no bridge is found. */
  crossfadeMs: number;
  /** Above this cost the cut is visible and wants a bridge or a dissolve. */
  costThreshold: number;
  /** Cost of an unsanctioned cut. */
  cJump: number;
  /** Ceiling on edge expansions per bridge search. */
  maxExpansions: number;
  /** Costs equal to this many decimal places are a tie (Python `tie_decimals`). */
  tieDecimals: number;
  /** How far above the best cost the expression bias may reach (`bias_slack`). */
  biasSlack: number;
}

export const DEFAULT_SMOOTH_CUT_OPTIONS: SmoothCutOptions = {
  enabled: 'auto',
  maxBridge: CUT_MAX_BRIDGE,
  crossfadeMs: CUT_CROSSFADE_MS,
  costThreshold: CUT_COST_THRESHOLD,
  cJump: CUT_C_JUMP,
  maxExpansions: CUT_MAX_EXPANSIONS,
  tieDecimals: CUT_TIE_DECIMALS,
  biasSlack: CUT_BIAS_SLACK,
};

/** What the controller should do for one cut. */
export interface CutPlan {
  /** The frame to enter the target range on. */
  frame: number;
  /** The graph cost of the transition actually taken (the worst step of a bridge). */
  cost: number;
  /** Cost of the best DIRECT entry, before any bridge. */
  directCost: number;
  /** What the legacy random start point would have cost — the before/after number. */
  baselineCost: number;
  /** Frames to play on the way in, in order. Empty when the entry is cheap enough. */
  bridge: number[];
  /** Whether the renderer should dissolve — only when nothing cheaper was available. */
  crossfade: boolean;
  /** `false` when this module had no opinion and `frame` is the caller's own fallback. */
  planned: boolean;
}

/** `(from, to) -> visual cost`. Injected so a host with a pose bank can share the
 * matcher's own notion of a natural step, which knows where the sequence cuts are. */
export type CutCostFn = (from: number, to: number) => number;

function median(values: number[]): number {
  const a = values.slice().sort((x, y) => x - y);
  const m = a.length;
  if (!m) return 0;
  return m % 2 ? a[(m - 1) / 2] : 0.5 * (a[m / 2 - 1] + a[m / 2]);
}

/** Python's `round(x, n)` — banker-free, which is what the tie comparison needs. */
function round(x: number, decimals: number): number {
  const p = Math.pow(10, decimals);
  return Math.round(x * p) / p;
}

/**
 * A second opinion over the candidates that are all equally smooth. Returns one of them,
 * or `null` to keep the cheapest. This is the seam Sutil's smile/head-yaw hint plugs into.
 */
export type CutBiasFn = (candidates: number[]) => number | null;

function readGraph(graph: MotionGraph | null | undefined): {
  offsets: Int32Array;
  to: Int32Array;
  cost: Float64Array;
} | null {
  if (!graph || !graph.offsets || !graph.to || !graph.cost) return null;
  const offsets = Int32Array.from(graph.offsets as ArrayLike<number>);
  const to = Int32Array.from(graph.to as ArrayLike<number>);
  const cost = Float64Array.from(graph.cost as ArrayLike<number>);
  if (offsets.length < 2 || to.length !== cost.length) return null;
  return { offsets, to, cost };
}

export class SmoothCut {
  private offsets: Int32Array | null = null;
  private to: Int32Array | null = null;
  private edgeCost: Float64Array | null = null;
  /** `from * N + to -> cost`, for the O(1) cost lookup the entry scan needs. */
  private edgeIndex: Map<number, number> = new Map();
  private n = 0;
  private allowed: Uint8Array | null = null;
  private costFn: CutCostFn | null = null;

  // ---- signature costs: the sidecar-free path -----------------------------------
  /** `frameCount x SIG_LEN`, row-major float64. `null` until signatures are built. */
  private sig: Float64Array | null = null;
  /** Row self-dot products, so a distance is one dot product instead of a subtraction. */
  private sigSq: Float64Array | null = null;
  /** "the frame that naturally follows i" - the two-frame window the graph metric uses. */
  private nxt: Int32Array | null = null;
  /**
   * The median distance between naturally consecutive frames: "one playback step". Every
   * signature cost is divided by it, which is what makes `c = 1` mean the same thing here
   * as it does in `motion_graph.json`. Leaving this at a placeholder 1.0 makes every cost
   * ~10^5 times too small and silently disables the bridge and the bias window.
   */
  private succMedian = 1.0;
  private hasSidecarMedian = false;

  public readonly opt: SmoothCutOptions;

  /** Last plan's cost and bridge, for `getMocapDebug()`. */
  public lastCutCost = 0;
  public bridgeFrames = 0;
  public cuts = 0;
  public bridges = 0;
  public crossfades = 0;

  constructor(graph?: MotionGraph | null, options?: Partial<SmoothCutOptions>) {
    this.opt = { ...DEFAULT_SMOOTH_CUT_OPTIONS, ...(options || {}) };
    this.setGraph(graph ?? null);
  }

  setGraph(graph: MotionGraph | null): void {
    const g = readGraph(graph);
    this.edgeIndex = new Map();
    if (!g) {
      this.offsets = null;
      this.to = null;
      this.edgeCost = null;
      this.n = 0;
      return;
    }
    this.offsets = g.offsets;
    this.to = g.to;
    this.edgeCost = g.cost;
    this.n = g.offsets.length - 1;
    for (let i = 0; i < this.n; i++) {
      for (let e = g.offsets[i]; e < g.offsets[i + 1]; e++) {
        this.edgeIndex.set(i * this.n + g.to[e], g.cost[e]);
      }
    }
    const sm = Number((graph as { succCostMedian?: number } | null)?.succCostMedian ?? 0);
    if (Number.isFinite(sm) && sm > 0) {
      this.succMedian = sm;
      this.hasSidecarMedian = true;
    }
    this.ensureNext();
  }

  /**
   * Which frame naturally follows each one. Without sequence info the bank is one run, so
   * it is `i + 1` and the last frame follows itself. Defaulting this to `i` instead leaves
   * the successor distances empty and the median at its placeholder, which is the failure
   * mode the Python reference calls out by name.
   */
  private ensureNext(): void {
    if (this.nxt && this.nxt.length === this.n) return;
    const nxt = new Int32Array(Math.max(0, this.n));
    for (let i = 0; i < this.n; i++) nxt[i] = i + 1 < this.n ? i + 1 : i;
    this.nxt = nxt;
  }

  /**
   * Tell the planner where the sequences end, so the two-frame window does not step across
   * a cut. `seqOf[i]` is any per-frame sequence id (the matcher's `seqOf` does fine).
   */
  setSequences(seqOf: ArrayLike<number> | null): void {
    if (!seqOf || seqOf.length !== this.n) {
      this.nxt = null;
      this.ensureNext();
      return;
    }
    const nxt = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      nxt[i] = i + 1 < this.n && seqOf[i + 1] === seqOf[i] ? i + 1 : i;
    }
    this.nxt = nxt;
  }

  /** Whether signature costs are available (the sidecar-free ranking). */
  get ready(): boolean {
    return this.sig !== null;
  }

  /**
   * Adopt a precomputed signature matrix (`frameCount x SIG_LEN`, row-major).
   *
   * This is what makes SmoothCut work on an avatar nobody ever indexed: the signatures
   * come from the decoded frames themselves, so no `motion_graph.json` is required. A
   * sidecar, when there is one, only improves the BRIDGE (it supplies the authored edges)
   * and pins `succCostMedian` exactly.
   */
  setSignatures(rows: ArrayLike<number> | null, frameCount?: number): void {
    if (!rows) return;
    const n = frameCount ?? this.n;
    if (!n || rows.length < 2 * SIG_LEN) return;
    if (this.n === 0) this.n = n;
    this.ensureNext();
    const A = new Float64Array(n * SIG_LEN);
    const lim = Math.min(A.length, rows.length);
    for (let i = 0; i < lim; i++) A[i] = Number(rows[i]) || 0;
    const sq = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      const row = i * SIG_LEN;
      for (let d = 0; d < SIG_LEN; d++) acc += A[row + d] * A[row + d];
      sq[i] = acc;
    }
    this.sig = A;
    this.sigSq = sq;
    if (!this.hasSidecarMedian) {
      const d = this.successorDistances();
      this.succMedian = d.length ? median(d) : 1.0;
      if (!(this.succMedian > 1e-12)) this.succMedian = 1e-12;
    }
  }

  /**
   * Decode every frame once and keep its signature. `getFrame` returns the RGBA pixels of
   * one frame, or `null` when it cannot be decoded; the build is abandoned unless at least
   * half the bank came back, because a half-measured bank ranks worse than not ranking.
   */
  buildSignatures(getFrame: (i: number) => FramePixels | null, frameCount?: number): boolean {
    const n = frameCount ?? this.n;
    if (!n) return false;
    const rows = new Float64Array(n * SIG_LEN);
    let got = 0;
    for (let i = 0; i < n; i++) {
      let px: FramePixels | null = null;
      try {
        px = getFrame(i);
      } catch {
        px = null;
      }
      if (!px) continue;
      try {
        rows.set(signature(px), i * SIG_LEN);
        got += 1;
      } catch {
        /* an undecodable frame is skipped, not fatal */
      }
    }
    if (got < Math.max(2, Math.floor(n / 2))) return false;
    this.setSignatures(rows, n);
    return true;
  }

  private successorDistances(): number[] {
    const A = this.sig;
    const nxt = this.nxt;
    if (!A || !nxt || this.n < 2) return [];
    const out: number[] = [];
    for (let i = 0; i + 1 < this.n; i++) {
      if (nxt[i] !== i + 1) continue; // a cut, not a step
      let acc = 0;
      const a = i * SIG_LEN;
      const b = (i + 1) * SIG_LEN;
      for (let d = 0; d < SIG_LEN; d++) {
        const diff = A[a + d] - A[b + d];
        acc += diff * diff;
      }
      out.push(acc / 1024.0);
    }
    return out;
  }

  /** Squared signature distance `i -> j`, before the median normalisation. */
  private sigDist(i: number, j: number): number {
    const A = this.sig;
    const sq = this.sigSq;
    if (!A || !sq) return NaN;
    let dot = 0;
    const a = i * SIG_LEN;
    const b = j * SIG_LEN;
    for (let d = 0; d < SIG_LEN; d++) dot += A[a + d] * A[b + d];
    const v = sq[i] + sq[j] - 2 * dot;
    return (v > 0 ? v : 0) / 1024.0;
  }

  /**
   * `c(i, j)` from the signatures, in natural playback steps, or `NaN` when there are
   * none. Uses the graph's own two-frame window: a splice is only cheap if what comes NEXT
   * also matches, which is what stops the search entering a run travelling the other way.
   * Deliberately unclipped - see {@link CUT_COST_CLIP}.
   */
  private signatureCost(i: number, j: number): number {
    if (!this.sig || !this.nxt) return NaN;
    const d = 0.5 * (this.sigDist(i, j) + this.sigDist(this.nxt[i], this.nxt[j]));
    return d / this.succMedian;
  }

  /** Restrict every choice to this pool (`MatcherOptions.frame_pool`). `null` clears it. */
  setAllowed(allowed: Uint8Array | null): void {
    this.allowed = allowed && allowed.length === this.n ? allowed : null;
  }

  /** Share the matcher's transition cost, which knows where the sequences cut. */
  setCostFn(fn: CutCostFn | null): void {
    this.costFn = fn;
  }

  /** Whether this instance will ever change a caller's choice. */
  get active(): boolean {
    if (this.opt.enabled === false) return false;
    if (this.n <= 0) return false;
    // Either source of truth is enough: a motion graph, or signatures built from the
    // decoded frames. That is what "works on an avatar nobody ever indexed" means.
    return this.offsets !== null || this.sig !== null;
  }

  get frameCount(): number {
    return this.n;
  }

  private isAllowed(j: number): boolean {
    return !this.allowed || this.allowed[j] === 1;
  }

  private *edgesOf(i: number): Generator<[number, number]> {
    if (!this.offsets || !this.to || !this.edgeCost) return;
    if (i < 0 || i >= this.n) return;
    for (let e = this.offsets[i]; e < this.offsets[i + 1]; e++) {
      yield [this.to[e], this.edgeCost[e]];
    }
  }

  /**
   * Visual cost of `from -> to`: 0 for a step the footage already makes, the graph's own
   * cost for a sanctioned cut, `cJump` for anything else.
   *
   * A host that also has the pose bank injects `setCostFn(matcher.transitionCost)`, which
   * is strictly better informed — it knows that `i -> i+1` across a sequence boundary is
   * a cut, not a step, and this module on its own cannot.
   */
  cost(from: number, to: number): number {
    if (this.costFn) return this.costFn(from, to);
    if (from === to) return 0.0;
    // Signatures first when they exist: they are a real measurement of the two images,
    // where the CSR can only say "the graph has no edge here" and fall back to `cJump`,
    // which makes every unsanctioned cut look identically bad and leaves the entry scan
    // nothing to rank.
    if (this.sig) {
      const c = this.signatureCost(from, to);
      if (Number.isFinite(c)) return c;
    }
    if (to === from + 1) return 0.0;
    const c = this.edgeIndex.get(from * this.n + to);
    return c === undefined ? this.opt.cJump : c;
  }

  /**
   * The cheapest way into `[low, high]` from `from`.
   *
   * `starts` are the author's own entry points for that range (`idle_start_positions` /
   * `talk_start_positions`); they do not restrict the search, they break its ties, so a
   * range with two equally cheap entries lands on the one the author actually meant.
   * `fallback` is what the caller would have done unaided, and is returned verbatim when
   * this module is inert — that is the byte-identity guarantee.
   */
  plan(
    from: number,
    low: number,
    high: number,
    starts: ArrayLike<number> | null,
    fallback: number,
    avoid?: ArrayLike<number> | null,
    biasFn?: CutBiasFn | null,
  ): CutPlan {
    const inert: CutPlan = {
      frame: fallback,
      cost: 0,
      directCost: 0,
      baselineCost: 0,
      bridge: [],
      crossfade: false,
      planned: false,
    };
    if (!this.active) return inert;
    const lo = Math.max(0, Math.trunc(low));
    const hi = Math.min(this.n - 1, Math.trunc(high));
    if (hi < lo) return inert;
    const f = Math.max(0, Math.min(this.n - 1, Math.trunc(from)));
    // Frames the caller has ruled out as a destination. At a range wrap that is `from`
    // and its neighbours: entering on the frame the cycler was about to play anyway costs
    // 0 and would win every scan, and the wrap would simply happen one frame later having
    // achieved nothing. A cut has to actually go somewhere.
    const banned = new Set<number>();
    if (avoid) for (let t = 0; t < avoid.length; t++) banned.add(Math.trunc(Number(avoid[t])));

    // Tie-break 2: how far the candidate sits from an entry point the author authored.
    const startList: number[] = [];
    if (starts) {
      for (let t = 0; t < starts.length; t++) {
        const v = Math.trunc(Number(starts[t]));
        if (v >= lo && v <= hi && this.isAllowed(v)) startList.push(v);
      }
    }
    const distToStart = (j: number): number => {
      // No authored start points => every candidate is equally "natural" and the tie falls
      // through to the index. (Mirrors Python's `min(..., default=0)`; scoring distance to
      // the range floor instead would silently prefer the top of the range.)
      if (!startList.length) return 0;
      let d = Infinity;
      for (const sp of startList) {
        const v = Math.abs(j - sp);
        if (v < d) d = v;
      }
      return d;
    };

    let best = -1;
    let bestCost = Infinity;
    let bestDist = Infinity;
    /** Every allowed candidate with its UNROUNDED cost, for the bias window. */
    const cand: [number, number][] = [];
    for (let j = lo; j <= hi; j++) {
      // Cutting to where you already are is not a cheap cut, it is a freeze: `cost(f, f)`
      // is 0 and would win every scan, and the cycler would then wrap onto the same frame
      // for ever. The cut has to go somewhere.
      if (j === f || banned.has(j)) continue;
      if (!this.isAllowed(j)) continue;
      // Rounded to `tieDecimals` BEFORE the comparison: two entries whose costs agree to
      // three places are visually the same cut, and the author's own start point should
      // decide between them rather than a difference in the fourth decimal.
      const raw = this.cost(f, j);
      const c = round(raw, this.opt.tieDecimals);
      const d = distToStart(j);
      cand.push([j, raw]);
      // cost, then closeness to a natural start point, then the lower index
      if (c < bestCost || (c === bestCost && (d < bestDist || (d === bestDist && j < best)))) {
        best = j;
        bestCost = c;
        bestDist = d;
      }
    }
    if (best < 0) return inert;
    let bestRaw = this.cost(f, best);

    // Expression bias: among the candidates that are JUST AS SMOOTH, let a second opinion
    // pick. This is where Sutil's smile/head-yaw hint composes with the cut work — cost
    // first, expression second — so the two features cannot fight over the frame.
    if (biasFn) {
      const near: number[] = [];
      for (const [j, c] of cand) if (c <= bestRaw + this.opt.biasSlack) near.push(j);
      if (near.length > 1) {
        let pick: number | null = null;
        try {
          pick = biasFn(near);
        } catch {
          pick = null;
        }
        if (pick !== null && near.indexOf(Math.trunc(pick)) >= 0) {
          best = Math.trunc(pick);
          bestRaw = this.cost(f, best);
          bestCost = round(bestRaw, this.opt.tieDecimals);
        }
      }
    }

    // What the legacy player would have cut to, so the caller can report before/after.
    const baseFrame = Math.max(0, Math.min(this.n - 1, Math.trunc(fallback)));
    const baselineCost = this.cost(f, baseFrame);

    this.cuts += 1;
    if (bestRaw < this.opt.costThreshold) {
      this.lastCutCost = bestRaw;
      this.bridgeFrames = 0;
      return {
        frame: best,
        cost: bestRaw,
        directCost: bestRaw,
        baselineCost,
        bridge: [],
        crossfade: false,
        planned: true,
      };
    }

    // Still a visible jump: no single frame of the target range is cheap to cut to from
    // here. Walk there through the graph instead — and let the walk choose where it comes
    // out, because the entry that is *reachable* is rarely the one that scored best from
    // a standing start. This is where most of the remaining pop goes.
    const br = this.bridgeToRange(f, lo, hi, distToStart, banned);
    if (br && br.worst < bestRaw) {
      this.bridges += 1;
      this.lastCutCost = br.worst;
      this.bridgeFrames = br.path.length;
      const stillVisible = br.worst >= this.opt.costThreshold;
      if (stillVisible) this.crossfades += 1;
      return {
        frame: br.entry,
        cost: br.worst,
        directCost: bestRaw,
        baselineCost,
        bridge: br.path,
        crossfade: stillVisible,
        planned: true,
      };
    }

    this.crossfades += 1;
    this.lastCutCost = bestRaw;
    this.bridgeFrames = 0;
    return {
      frame: best,
      cost: bestRaw,
      directCost: bestRaw,
      baselineCost,
      bridge: [],
      crossfade: true,
      planned: true,
    };
  }

  /**
   * Shortest visually-cheap walk from `from` into `[lo, hi]`.
   *
   * The difference from {@link bridge} is that the destination is a RANGE, so the search
   * gets to pick the frame it comes out on. That matters: the cheapest entry seen from a
   * standing start is often unreachable, while some other frame of the same range is one
   * cheap hop away.
   *
   * Bounded Dijkstra on the graph's CSR, minimising the WORST edge on the path — that is
   * the step the eye actually catches, not the sum — then the hop count, then the index.
   * Edges at or above `costThreshold` are not walked at all (a bridge made of visible
   * cuts is not a bridge), frames outside the pool are never expanded, so a coverage
   * block is not a shortcut, and the whole search is capped at `maxExpansions` pops: a
   * cut is allowed to be smart, never to drop a frame.
   */
  private bridgeToRange(
    from: number,
    lo: number,
    hi: number,
    distToStart: (j: number) => number,
    banned: Set<number>,
  ): { entry: number; path: number[]; worst: number } | null {
    if (!this.offsets || !this.to || !this.edgeCost) return null;
    const limit = Math.max(0, Math.trunc(this.opt.maxBridge)) + 1; // hops, i.e. edges
    if (limit <= 0) return null;
    const vis = this.opt.costThreshold;
    const start = Math.max(0, Math.min(this.n - 1, Math.trunc(from)));
    // (worst, hops, node, path). A plain array kept sorted is enough: `maxExpansions`
    // bounds it at 64 pops, so a real heap would only add code.
    let heap: { worst: number; hops: number; node: number; path: number[] }[] = [
      { worst: 0, hops: 0, node: start, path: [] },
    ];
    const seen = new Map<number, [number, number]>([[start, [0, 0]]]);
    let pops = 0;
    let best: { entry: number; path: number[]; worst: number; hops: number } | null = null;
    while (heap.length && pops < this.opt.maxExpansions) {
      heap.sort((a, b) => a.worst - b.worst || a.hops - b.hops || a.node - b.node);
      const cur = heap.shift() as { worst: number; hops: number; node: number; path: number[] };
      pops += 1;
      if (best && (cur.worst > best.worst || (cur.worst === best.worst && cur.hops >= best.hops))) continue;
      if (cur.hops >= limit) continue;
      const succ: [number, number][] = [];
      for (const e of this.edgesOf(cur.node)) succ.push(e);
      succ.sort((a, b) => a[0] - b[0]);
      for (const [j, c] of succ) {
        if (c >= vis || !this.isAllowed(j)) continue;
        const w2 = Math.max(cur.worst, c);
        const h2 = cur.hops + 1;
        const prev = seen.get(j);
        if (prev && (prev[0] < w2 || (prev[0] === w2 && prev[1] <= h2))) continue;
        seen.set(j, [w2, h2]);
        const p2 = cur.path.concat([j]);
        if (j >= lo && j <= hi && !banned.has(j)) {
          // arrived; do not walk past the target
          if (
            !best ||
            w2 < best.worst ||
            (w2 === best.worst && (h2 < best.hops || (h2 === best.hops && j < best.entry)))
          ) {
            best = { entry: j, path: p2.slice(0, -1), worst: w2, hops: h2 };
          }
          continue;
        }
        if (h2 < limit) heap.push({ worst: w2, hops: h2, node: j, path: p2 });
      }
    }
    if (!best || best.worst >= vis) return null;
    // `distToStart` is unused in the walk itself — the walk is scored on what the eye
    // sees, and there is at most one arrival per frame — but it is kept in the signature
    // so a future tie-break has it, exactly as the Python reference does.
    void distToStart;
    return { entry: best.entry, path: best.path, worst: best.worst };
  }

  /**
   * A chain of at most `maxBridge` frames from `from` to `to` through the graph's edges,
   * or `null`.
   *
   * Breadth-first by construction, so the shortest bridge wins; inside one depth the
   * frontier is expanded in ascending frame order, so the search is deterministic; and
   * the whole thing is capped at `maxExpansions` edges, so a dense graph costs a bounded
   * amount of work per cut rather than an unbounded one.
   */
  bridge(from: number, to: number): number[] | null {
    if (!this.active) return null;
    const maxB = Math.max(0, Math.trunc(this.opt.maxBridge));
    if (maxB <= 0) return null;
    const f = Math.max(0, Math.min(this.n - 1, Math.trunc(from)));
    const t = Math.max(0, Math.min(this.n - 1, Math.trunc(to)));
    if (f === t) return null;
    let expansions = 0;
    let frontier: number[][] = [[f]];
    for (let depth = 0; depth < maxB; depth++) {
      const next: number[][] = [];
      for (const path of frontier) {
        const last = path[path.length - 1];
        const succ: [number, number][] = [];
        for (const e of this.edgesOf(last)) succ.push(e);
        // ascending frame order -> the same bridge in every runtime
        succ.sort((a, b) => a[0] - b[0]);
        for (const [j] of succ) {
          if (expansions >= this.opt.maxExpansions) return null;
          expansions += 1;
          if (j === t || j === f) continue;
          if (!this.isAllowed(j)) continue;
          if (path.indexOf(j) >= 0) continue;
          // Does this frame reach the target directly? Then the bridge is complete.
          if (this.cost(j, t) < this.opt.costThreshold) return path.slice(1).concat([j]);
          next.push(path.concat([j]));
        }
      }
      if (!next.length) break;
      frontier = next;
    }
    return null;
  }

  /** Zero the counters (a new avatar, a new session). */
  reset(): void {
    this.lastCutCost = 0;
    this.bridgeFrames = 0;
    this.cuts = 0;
    this.bridges = 0;
    this.crossfades = 0;
  }
}

/**
 * Mean visual cost of the frame CHANGES in a run — the acceptance metric for the cut
 * work. Frames that repeat cost nothing (the avatar is holding, not cutting).
 */
export function cutCostMean(frames: ArrayLike<number>, cost: CutCostFn): number {
  let sum = 0;
  let count = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = Math.trunc(Number(frames[i - 1]));
    const b = Math.trunc(Number(frames[i]));
    if (a === b) continue;
    sum += cost(a, b);
    count += 1;
  }
  return count ? sum / count : 0;
}
