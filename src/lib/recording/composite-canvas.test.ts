// Vitest covers the pure layout math + the compositor's state machine
// (start/stop, swapSource crossfade timing, enableEndCard idempotence).
// The actual drawImage calls are exercised against a fake CanvasRenderingContext2D
// recorder so we can assert ordering (cam first, then source, then watermark,
// then end-card on top) without a real DOM.
//
// vitest.config.ts sets `environment: 'node'` — no real HTMLCanvasElement
// or HTMLVideoElement. We use shape-compatible fakes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPOSITE_HEIGHT,
  COMPOSITE_WIDTH,
  CROSSFADE_MS,
  END_CARD_MS,
  HALF_HEIGHT,
  computeContainLayout,
  computeCoverLayout,
  computeFitLayout,
  createCompositor,
  crossfadeAlpha,
} from './composite-canvas';

// ── Fakes ───────────────────────────────────────────────────────────────

// Minimal fake context — records every call so tests can assert order &
// arguments without pulling in jsdom.
function makeCtx() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  let alpha = 1;
  const ctx = {
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    font: '',
    textAlign: '' as CanvasTextAlign,
    textBaseline: '' as CanvasTextBaseline,
    shadowColor: '',
    shadowBlur: 0,
    set globalAlpha(v: number) { alpha = v; calls.push({ op: 'globalAlpha', args: [v] }); },
    get globalAlpha() { return alpha; },
    save(): void   { calls.push({ op: 'save', args: [] }); },
    restore(): void { calls.push({ op: 'restore', args: [] }); },
    translate(x: number, y: number): void { calls.push({ op: 'translate', args: [x, y] }); },
    scale(x: number, y: number): void { calls.push({ op: 'scale', args: [x, y] }); },
    fillRect(x: number, y: number, w: number, h: number): void {
      calls.push({ op: 'fillRect', args: [x, y, w, h] });
    },
    fillText(t: string, x: number, y: number): void {
      calls.push({ op: 'fillText', args: [t, x, y] });
    },
    drawImage(...args: unknown[]): void {
      calls.push({ op: 'drawImage', args });
    },
  };
  return { ctx, calls };
}

function makeCanvas() {
  const { ctx, calls } = makeCtx();
  const canvas = {
    width: COMPOSITE_WIDTH,
    height: COMPOSITE_HEIGHT,
    getContext(_kind: string, _opts?: unknown) { return ctx; },
  } as unknown as HTMLCanvasElement;
  return { canvas, calls };
}

function makeVideo(videoWidth = 720, videoHeight = 1280) {
  return { videoWidth, videoHeight } as unknown as HTMLVideoElement;
}

let rafQueue: Array<FrameRequestCallback> = [];
beforeEach(() => {
  rafQueue = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (cb: FrameRequestCallback): number => { rafQueue.push(cb); return rafQueue.length; },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    value: (_id: number): void => { /* tests advance manually */ },
    configurable: true,
  });
});
afterEach(() => {
  rafQueue = [];
  vi.restoreAllMocks();
});

// ── computeCoverLayout ─────────────────────────────────────────────────

describe('computeCoverLayout', () => {
  it('returns degenerate layout when video is unmeasurable', () => {
    expect(computeCoverLayout(0, 0, 0, 0, 540, 480)).toMatchObject({ sw: 0, sh: 0 });
    expect(computeCoverLayout(720, 0, 0, 0, 540, 480)).toMatchObject({ sw: 0, sh: 0 });
  });

  it('crops sides for video wider than dest (16:9 → 9:8)', () => {
    // dest 540×480 (~9:8). Video 1280×720 (16:9) is wider → crop sides.
    const lay = computeCoverLayout(1280, 720, 0, 480, 540, 480);
    expect(lay.sh).toBe(720);                            // full height read
    expect(lay.sw).toBe(Math.round(720 * (540 / 480)));  // 810
    expect(lay.sx).toBe(Math.round((1280 - lay.sw) / 2));
    expect(lay.sy).toBe(0);
    expect(lay.dx).toBe(0); expect(lay.dy).toBe(480);
    expect(lay.dw).toBe(540); expect(lay.dh).toBe(480);
  });

  it('crops top/bottom for video taller than dest (9:16 cam → 9:8 panel)', () => {
    // dest 540×480 (~1.125 AR). Video 720×1280 (~0.5625 AR) is taller → crop vertical.
    const lay = computeCoverLayout(720, 1280, 0, 0, 540, 480);
    expect(lay.sw).toBe(720);                            // full width read
    expect(lay.sh).toBe(Math.round(720 / (540 / 480)));  // 640
    expect(lay.sx).toBe(0);
    expect(lay.sy).toBe(Math.round((1280 - lay.sh) / 2));
  });

  it('exact-AR match reads the full source rect', () => {
    const lay = computeCoverLayout(540, 480, 10, 20, 540, 480);
    expect(lay).toMatchObject({ sx: 0, sy: 0, sw: 540, sh: 480, dx: 10, dy: 20, dw: 540, dh: 480 });
  });
});

// ── computeContainLayout ───────────────────────────────────────────────

describe('computeContainLayout (B-prime)', () => {
  it('returns degenerate layout for invalid input', () => {
    expect(computeContainLayout(0, 0, 0, 0, 540, 480)).toMatchObject({ sw: 0, sh: 0 });
    expect(computeContainLayout(720, 0, 0, 0, 540, 480)).toMatchObject({ sw: 0, sh: 0 });
  });

  it('portrait 9:16 source into landscape 1.125 slot → pillarbox left+right, full source', () => {
    // 720×1280 (videoAR ≈ 0.5625) into 540×480 (destAR = 1.125) → fit height,
    // dest width = 480 * 0.5625 = 270, pillarbox ((540-270)/2)=135 each side.
    const lay = computeContainLayout(720, 1280, 0, 0, 540, 480);
    expect(lay.sx).toBe(0);
    expect(lay.sy).toBe(0);
    expect(lay.sw).toBe(720);
    expect(lay.sh).toBe(1280);
    expect(lay.dh).toBe(480);
    expect(lay.dw).toBe(270);
    expect(lay.dx).toBe(135);
    expect(lay.dy).toBe(0);
  });

  it('landscape 16:9 source into landscape 1.125 slot → letterbox top+bottom, full source', () => {
    // 1280×720 (videoAR ≈ 1.78) into 540×480 (destAR = 1.125) → fit width,
    // dest height = 540/1.78 ≈ 304, letterbox ((480-304)/2)=88 each side.
    const lay = computeContainLayout(1280, 720, 0, 0, 540, 480);
    expect(lay.sw).toBe(1280);
    expect(lay.sh).toBe(720);
    expect(lay.dw).toBe(540);
    expect(lay.dh).toBe(304); // 540/(1280/720) = 303.75 → 304
    expect(lay.dx).toBe(0);
    expect(lay.dy).toBe(88);  // (480-304)/2 = 88
  });

  it('exact-AR match fills the slot with no bars', () => {
    const lay = computeContainLayout(540, 480, 10, 20, 540, 480);
    expect(lay).toMatchObject({ dx: 10, dy: 20, dw: 540, dh: 480 });
  });
});

// ── computeFitLayout (smart auto rule) ────────────────────────────────

describe('computeFitLayout', () => {
  it('auto picks contain when source is portrait-er than slot', () => {
    // 9:16 source vs 1.125:1 slot — videoAR < destAR → contain.
    const auto = computeFitLayout(720, 1280, 0, 0, 540, 480, 'auto');
    const cont = computeContainLayout(720, 1280, 0, 0, 540, 480);
    expect(auto).toEqual(cont);
  });

  it('auto picks cover when source is landscape (matches/exceeds slot AR)', () => {
    // 16:9 source vs 1.125:1 slot — videoAR > destAR → cover.
    const auto = computeFitLayout(1280, 720, 0, 0, 540, 480, 'auto');
    const cov  = computeCoverLayout(1280, 720, 0, 0, 540, 480);
    expect(auto).toEqual(cov);
  });

  it('explicit cover mode forces cover even on portrait source', () => {
    const forced = computeFitLayout(720, 1280, 0, 0, 540, 480, 'cover');
    const cov    = computeCoverLayout(720, 1280, 0, 0, 540, 480);
    expect(forced).toEqual(cov);
  });

  it('explicit contain mode forces contain even on landscape source', () => {
    const forced = computeFitLayout(1280, 720, 0, 0, 540, 480, 'contain');
    const cont   = computeContainLayout(1280, 720, 0, 0, 540, 480);
    expect(forced).toEqual(cont);
  });

  it('returns degenerate layout for invalid input regardless of mode', () => {
    for (const mode of ['auto', 'cover', 'contain'] as const) {
      expect(computeFitLayout(0, 0, 0, 0, 540, 480, mode)).toMatchObject({ sw: 0, sh: 0 });
    }
  });
});

// ── crossfadeAlpha ──────────────────────────────────────────────────────

describe('crossfadeAlpha', () => {
  it('clamps before-start to (0, 1)', () => {
    expect(crossfadeAlpha(-100)).toEqual({ incoming: 0, outgoing: 1 });
    expect(crossfadeAlpha(0)).toEqual({ incoming: 0, outgoing: 1 });
  });
  it('clamps after-end to (1, 0)', () => {
    expect(crossfadeAlpha(CROSSFADE_MS)).toEqual({ incoming: 1, outgoing: 0 });
    expect(crossfadeAlpha(CROSSFADE_MS + 50)).toEqual({ incoming: 1, outgoing: 0 });
  });
  it('linear ramp at the midpoint', () => {
    const m = crossfadeAlpha(CROSSFADE_MS / 2);
    expect(m.incoming).toBeCloseTo(0.5, 5);
    expect(m.outgoing).toBeCloseTo(0.5, 5);
  });
  it('zero-duration is instant', () => {
    expect(crossfadeAlpha(0, 0)).toEqual({ incoming: 1, outgoing: 0 });
  });
});

// ── createCompositor ────────────────────────────────────────────────────

function getMockTime() {
  let t = 1000;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

describe('createCompositor', () => {
  it('drawFrame in steady state: cam, source, watermark, URL — in order', () => {
    const { canvas, calls } = makeCanvas();
    const cam = makeVideo(720, 1280);
    const src = makeVideo(1280, 720);
    const wm = { width: 100, height: 100 } as unknown as ImageBitmap;
    const compositor = createCompositor({
      canvas, cameraVideoEl: cam, sourceVideoEl: src,
      watermarkBitmap: wm, referralUrl: 'oakl.gg/r/abc', creatorHandle: '@vuk',
    });
    compositor.drawFrame();

    // Two drawImage for video (cam + source) plus one for watermark = 3.
    const drawImageCount = calls.filter((c) => c.op === 'drawImage').length;
    expect(drawImageCount).toBe(3);
    // Cam is mirrored — first translate+scale appear before the first drawImage.
    const firstDrawIdx = calls.findIndex((c) => c.op === 'drawImage');
    const camPrefix = calls.slice(0, firstDrawIdx).map((c) => c.op);
    expect(camPrefix).toContain('translate');
    expect(camPrefix).toContain('scale');
    // URL text drawn last.
    const fillTexts = calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]);
    expect(fillTexts).toEqual(['oakl.gg/r/abc']);
  });

  it('null sourceVideoEl draws black bottom half (no source drawImage)', () => {
    const { canvas, calls } = makeCanvas();
    const cam = makeVideo(720, 1280);
    const compositor = createCompositor({
      canvas, cameraVideoEl: cam, sourceVideoEl: null,
      referralUrl: 'oakl.gg/r/abc', creatorHandle: '@vuk',
    });
    compositor.drawFrame();
    const drawImageCount = calls.filter((c) => c.op === 'drawImage').length;
    expect(drawImageCount).toBe(1); // cam only
    // Black fill on the bottom half present.
    const fillRects = calls.filter((c) => c.op === 'fillRect').map((c) => c.args);
    expect(fillRects).toContainEqual([0, HALF_HEIGHT, COMPOSITE_WIDTH, HALF_HEIGHT]);
  });

  it('unmeasurable video falls back to black fill in its half', () => {
    const { canvas, calls } = makeCanvas();
    const cam = makeVideo(0, 0); // metadata not yet loaded
    const src = makeVideo(1280, 720);
    const compositor = createCompositor({
      canvas, cameraVideoEl: cam, sourceVideoEl: src,
      referralUrl: 'oakl.gg/r/abc', creatorHandle: '@vuk',
    });
    compositor.drawFrame();
    const fillRects = calls.filter((c) => c.op === 'fillRect').map((c) => c.args);
    // Top-half black for unmeasured cam.
    expect(fillRects).toContainEqual([0, 0, COMPOSITE_WIDTH, HALF_HEIGHT]);
  });

  it('swapSource triggers crossfade — both old and new draw during 300ms window', () => {
    const time = getMockTime();
    const { canvas, calls } = makeCanvas();
    const cam = makeVideo(720, 1280);
    const oldSrc = makeVideo(1280, 720);
    const newSrc = makeVideo(720, 1280);
    const compositor = createCompositor({
      canvas, cameraVideoEl: cam, sourceVideoEl: oldSrc,
      referralUrl: 'oakl.gg/r/abc', creatorHandle: '@vuk',
      now: time.now,
    });

    compositor.swapSource(newSrc);
    time.advance(CROSSFADE_MS / 2);
    calls.length = 0;
    compositor.drawFrame();

    // Mid-crossfade: cam + outgoing + incoming = 3 video drawImage,
    // plus 0 watermark (no bitmap), so 3 total drawImage.
    const drawImages = calls.filter((c) => c.op === 'drawImage');
    expect(drawImages.length).toBe(3);
  });

  it('crossfade settles after CROSSFADE_MS — only one source drawn', () => {
    const time = getMockTime();
    const { canvas, calls } = makeCanvas();
    const cam = makeVideo(720, 1280);
    const oldSrc = makeVideo(1280, 720);
    const newSrc = makeVideo(720, 1280);
    const compositor = createCompositor({
      canvas, cameraVideoEl: cam, sourceVideoEl: oldSrc,
      referralUrl: 'oakl.gg/r/abc', creatorHandle: '@vuk',
      now: time.now,
    });

    compositor.swapSource(newSrc);
    time.advance(CROSSFADE_MS + 1);
    compositor.drawFrame(); // settles state
    calls.length = 0;
    time.advance(20);
    compositor.drawFrame();

    // Steady state again: cam + source = 2 drawImage.
    expect(calls.filter((c) => c.op === 'drawImage').length).toBe(2);
  });

  it('swapSource is a no-op when newEl === current source', () => {
    const time = getMockTime();
    const { canvas, calls } = makeCanvas();
    const cam = makeVideo(720, 1280);
    const src = makeVideo(1280, 720);
    const compositor = createCompositor({
      canvas, cameraVideoEl: cam, sourceVideoEl: src,
      referralUrl: 'oakl.gg/r/abc', creatorHandle: '@vuk',
      now: time.now,
    });
    compositor.swapSource(src);
    time.advance(CROSSFADE_MS / 2); // would be mid-fade if a swap had started
    calls.length = 0;
    compositor.drawFrame();
    // Steady-state: cam + source = 2 drawImage. If the no-op short-circuit
    // were broken we'd see 3 (cam + outgoing + incoming).
    expect(calls.filter((c) => c.op === 'drawImage').length).toBe(2);
  });

  it('chained swap mid-crossfade preserves a single outgoing→incoming fade', () => {
    // Audit C2: rapid Ask→re-Ask must not drop the prior outgoing into
    // the void. After the second swap we still expect exactly 3 drawImage
    // calls (cam + outgoing + incoming) — i.e. a fresh crossfade is running.
    const time = getMockTime();
    const { canvas, calls } = makeCanvas();
    const cam = makeVideo(720, 1280);
    const a = makeVideo(1280, 720);
    const b = makeVideo(720, 1280);
    const c = makeVideo(640, 480);
    const compositor = createCompositor({
      canvas, cameraVideoEl: cam, sourceVideoEl: a,
      referralUrl: 'oakl.gg/r/abc', creatorHandle: '@vuk',
      now: time.now,
    });
    compositor.swapSource(b);
    time.advance(CROSSFADE_MS / 4);
    compositor.swapSource(c);
    time.advance(CROSSFADE_MS / 4);
    calls.length = 0;
    compositor.drawFrame();
    expect(calls.filter((c) => c.op === 'drawImage').length).toBe(3);
  });

  it('negative-elapsed (clock regression) snaps the crossfade to completion', () => {
    // Audit C3: if now() goes backward between swap and draw, elapsed < 0
    // would freeze outgoing at full alpha indefinitely without this guard.
    let t = 1000;
    const { canvas, calls } = makeCanvas();
    const cam = makeVideo(720, 1280);
    const a = makeVideo(1280, 720);
    const b = makeVideo(720, 1280);
    const compositor = createCompositor({
      canvas, cameraVideoEl: cam, sourceVideoEl: a,
      referralUrl: 'oakl.gg/r/abc', creatorHandle: '@vuk',
      now: () => t,
    });
    compositor.swapSource(b);
    t -= 500; // clock went backward
    calls.length = 0;
    compositor.drawFrame();
    // Snap: only cam + new source drawn. Outgoing dropped.
    expect(calls.filter((c) => c.op === 'drawImage').length).toBe(2);
  });

  it('crossfade uses linear interpolation (outgoing α=1, incoming α=t)', () => {
    // Audit M2: avoid the mid-fade luminance dip from "both layers at
    // fractional α over black". Outgoing draws first at full alpha,
    // incoming draws on top with α=t. Verify the recorded globalAlpha ops:
    // exactly one fractional alpha (the incoming layer) bracketed by
    // save/restore, then watermark URL alpha unrelated to crossfade.
    const time = getMockTime();
    const { canvas, calls } = makeCanvas();
    const cam = makeVideo(720, 1280);
    const a = makeVideo(1280, 720);
    const b = makeVideo(720, 1280);
    const compositor = createCompositor({
      canvas, cameraVideoEl: cam, sourceVideoEl: a,
      referralUrl: 'oakl.gg/r/abc', creatorHandle: '@vuk',
      now: time.now,
    });
    compositor.swapSource(b);
    time.advance(CROSSFADE_MS / 2);
    calls.length = 0;
    compositor.drawFrame();

    const fractionalAlphas = calls
      .filter((c) => c.op === 'globalAlpha')
      .map((c) => c.args[0] as number)
      .filter((v) => v > 0 && v < 1);
    // Incoming-layer α≈0.5 must be in the recorded ops.
    expect(fractionalAlphas.some((v) => Math.abs(v - 0.5) < 0.01)).toBe(true);
  });

  it('stop() resets transient state on the SAME compositor — no stale end-card on restart', () => {
    // Audit C1 (re-audit): the previous test instantiated a fresh compositor
    // — tautological since a new closure has zeroed state regardless of stop().
    // Reuse the same instance to actually exercise stop()'s state reset.
    const time = getMockTime();
    const { canvas, calls } = makeCanvas();
    const cam = makeVideo(720, 1280);
    const src = makeVideo(1280, 720);
    const compositor = createCompositor({
      canvas, cameraVideoEl: cam, sourceVideoEl: src,
      referralUrl: 'oakl.gg/r/abc', creatorHandle: '@vuk',
      now: time.now,
    });
    compositor.start();
    compositor.enableEndCard();
    time.advance(END_CARD_MS + 1000); // run well past end-card duration
    compositor.stop();
    rafQueue.length = 0;

    calls.length = 0;
    compositor.start();
    // Pull the freshly-scheduled RAF.
    rafQueue.shift()?.(0);

    // If stop() reset endCardStart to 0, no end-card panel renders this tick.
    // End-card emits 2 extra fillText (handle + panel URL); persistent URL
    // emits 1. Steady state without end-card → exactly 1 fillText.
    expect(calls.filter((c) => c.op === 'fillText').length).toBe(1);
  });

  it('enableEndCard is idempotent — repeated calls do not reset progress', () => {
    const time = getMockTime();
    const { canvas, calls } = makeCanvas();
    const cam = makeVideo(720, 1280);
    const src = makeVideo(1280, 720);
    const compositor = createCompositor({
      canvas, cameraVideoEl: cam, sourceVideoEl: src,
      referralUrl: 'oakl.gg/r/abc', creatorHandle: '@vuk',
      now: time.now,
    });

    compositor.enableEndCard();
    time.advance(END_CARD_MS / 2);
    compositor.enableEndCard(); // second call is a no-op
    time.advance(END_CARD_MS / 2 + 10);

    calls.length = 0;
    compositor.drawFrame();
    // Progress is fully past END_CARD_MS at this point — end-card alpha=1.
    // The end-card panel writes 2 fillText (handle + URL on the panel) plus
    // the persistent URL fillText = 3 total fillText calls.
    const fillTexts = calls.filter((c) => c.op === 'fillText');
    expect(fillTexts.length).toBe(3);
  });

  it('start/stop drives the RAF loop', () => {
    const { canvas, calls } = makeCanvas();
    const cam = makeVideo(720, 1280);
    const src = makeVideo(1280, 720);
    const compositor = createCompositor({
      canvas, cameraVideoEl: cam, sourceVideoEl: src,
      referralUrl: 'oakl.gg/r/abc', creatorHandle: '@vuk',
    });

    compositor.start();
    expect(rafQueue.length).toBe(1);
    // Tick once
    const cb1 = rafQueue.shift()!;
    cb1(0);
    expect(calls.filter((c) => c.op === 'drawImage').length).toBeGreaterThan(0);
    expect(rafQueue.length).toBe(1); // re-scheduled

    compositor.stop();
    // After stop, the next tick returns early without re-scheduling.
    calls.length = 0;
    rafQueue.shift()!(0);
    expect(calls.length).toBe(0);
    expect(rafQueue.length).toBe(0);
  });

  it('start is idempotent — second call does not double-schedule', () => {
    const { canvas } = makeCanvas();
    const cam = makeVideo(720, 1280);
    const compositor = createCompositor({
      canvas, cameraVideoEl: cam, sourceVideoEl: null,
      referralUrl: 'oakl.gg/r/abc', creatorHandle: '@vuk',
    });
    compositor.start();
    compositor.start();
    expect(rafQueue.length).toBe(1);
  });

  it('throws when canvas has no 2d context', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => createCompositor({
      canvas, cameraVideoEl: makeVideo(), sourceVideoEl: null,
      referralUrl: 'x', creatorHandle: '@x',
    })).toThrow(/2d context/);
  });
});
