// React/duet capture compositor — top half = user selfie (mirrored),
// bottom half = source content (hook video / long-form / avatar). Watermark
// + persistent invite URL bottom-right; optional end-card panel for the last
// 1.5s. Output canvas at 540×960 (9:16); MediaRecorder consumes the canvas
// captureStream() at 30 fps.
//
// Renders one MIRRORED selfie on top so the user sees themselves the way
// they expect (left↔right inversion). Source video is NOT mirrored — both
// hook and avatar streams come framed correctly already.
//
// Source swap (hook → avatar when user taps Ask while ARMED) is a 300ms
// alpha crossfade rather than a hard cut (Plan §25 NM3). Watermark stays
// at 25% opacity bottom-right (NM5 — beefed up from initial 12% spec) with
// the referral URL baked into the video itself for the full duration —
// the end-card supplements it for share-app preview thumbnails.
//
// Pure-function layout helpers (computeCoverLayout, crossfadeAlpha) are
// exported separately for unit testing. The RAF loop integrates them.

export const COMPOSITE_WIDTH = 540;
export const COMPOSITE_HEIGHT = 960;
export const HALF_HEIGHT = COMPOSITE_HEIGHT / 2;
export const CROSSFADE_MS = 300;
export const END_CARD_MS = 1500;
// 25% per Plan §25 NM5 (raised from initial 12% in §7 / §20.12 — watermark
// + end-card are the v1 attribution-funnel teeth after C2PA was cut from v1).
export const WATERMARK_OPACITY = 0.25;
export const WATERMARK_WIDTH_FRAC = 0.14;
export const WATERMARK_PADDING = 12;
export const URL_FONT_PX = 14;
export const END_CARD_PANEL_HEIGHT = 140;

// ── Pure layout helpers ─────────────────────────────────────────────────

export type CoverLayout = {
  /** Source-rect in video pixel coordinates (the cropped region we read). */
  sx: number; sy: number; sw: number; sh: number;
  /** Dest-rect on the canvas. */
  dx: number; dy: number; dw: number; dh: number;
};

/**
 * Object-fit:cover math. Returns the source-rect to read from a source of
 * dimensions (videoW × videoH) so it fills the dest-rect (destW × destH)
 * with center-cropped overflow on the longer axis. videoW/videoH ≤ 0 yields
 * a degenerate layout the caller can detect via sw/sh === 0.
 */
export function computeCoverLayout(
  videoW: number, videoH: number,
  destX: number, destY: number, destW: number, destH: number,
): CoverLayout {
  if (videoW <= 0 || videoH <= 0 || destW <= 0 || destH <= 0) {
    return { sx: 0, sy: 0, sw: 0, sh: 0, dx: destX, dy: destY, dw: destW, dh: destH };
  }
  const videoAR = videoW / videoH;
  const destAR = destW / destH;
  let sx: number, sy: number, sw: number, sh: number;
  if (videoAR > destAR) {
    // Video is wider than dest → crop the sides.
    sh = videoH;
    sw = Math.round(videoH * destAR);
    sx = Math.round((videoW - sw) / 2);
    sy = 0;
  } else {
    // Video is taller (or equal) → crop top/bottom.
    sw = videoW;
    sh = Math.round(videoW / destAR);
    sx = 0;
    sy = Math.round((videoH - sh) / 2);
  }
  return { sx, sy, sw, sh, dx: destX, dy: destY, dw: destW, dh: destH };
}

/**
 * Linear crossfade alphas — incoming ramps 0→1, outgoing ramps 1→0 over
 * durationMs. Clamped at the boundaries. elapsedMs is wall-clock since the
 * swap began.
 */
export function crossfadeAlpha(
  elapsedMs: number,
  durationMs: number = CROSSFADE_MS,
): { incoming: number; outgoing: number } {
  if (durationMs <= 0)            return { incoming: 1, outgoing: 0 };
  if (elapsedMs <= 0)             return { incoming: 0, outgoing: 1 };
  if (elapsedMs >= durationMs)    return { incoming: 1, outgoing: 0 };
  const t = elapsedMs / durationMs;
  return { incoming: t, outgoing: 1 - t };
}

// ── Compositor ──────────────────────────────────────────────────────────

export type CompositorOptions = {
  /** Pre-sized to 540×960. Caller is responsible for sizing to avoid layout-
   *  thrash mid-recording (changing canvas.width clears the bitmap and
   *  resets ctx state, which would corrupt frames in flight). */
  canvas: HTMLCanvasElement;
  /** User-facing selfie cam. Drawn mirrored. */
  cameraVideoEl: HTMLVideoElement;
  /** Source content. May be null while waiting for an avatar onVideoTrack. */
  sourceVideoEl: HTMLVideoElement | null;
  /** Pre-rasterized logo (caller rasterizes the SVG to an ImageBitmap once
   *  to avoid the per-RAF SVG decode cost — verified ~2% iPhone-11 CPU per
   *  tick, see Plan §S4 / §RC2). Pass null to skip the logo blit. */
  watermarkBitmap?: ImageBitmap | HTMLImageElement | null;
  /** 'oakl.gg/r/<short>' — drawn each tick under the watermark and again on
   *  the end-card. Mint at open-check (Plan R3-M3) so in-video URL == share URL. */
  referralUrl: string;
  /** '@vuk' — end-card text "{handle} on OakLeague". */
  creatorHandle: string;
  /** Inject for tests. Defaults to performance.now. */
  now?: () => number;
};

export interface Compositor {
  /** Pre-sized canvas the compositor draws into; pass to MediaRecorder via
   *  canvas.captureStream(fps). Same instance as opts.canvas. The caller
   *  MUST call captureStream() and bind MediaRecorder BEFORE start(): Safari
   *  has historically dropped the first paint into an after-the-fact stream,
   *  resulting in 1-3 frames of black at the head of the recording. */
  readonly canvas: HTMLCanvasElement;
  /** Begin RAF loop. Idempotent. */
  start(): void;
  /** Stop RAF loop. Idempotent. Does NOT clear the canvas. */
  stop(): void;
  /** Swap the bottom-half source. Triggers a 300ms crossfade from the
   *  current source to newSourceEl. Pass null to fade to black. No-op if
   *  newSourceEl === current source. */
  swapSource(newSourceEl: HTMLVideoElement | null): void;
  /** Begin the end-card fade-in. Idempotent — repeated calls are no-ops.
   *  Caller schedules this END_CARD_MS before the intended STOP. */
  enableEndCard(): void;
  /** Draw a single frame. Exposed so callers can prime the canvas before
   *  starting MediaRecorder, and for synchronous tests. */
  drawFrame(): void;
}

export function createCompositor(opts: CompositorOptions): Compositor {
  const ctx = opts.canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('createCompositor: 2d context unavailable');
  const now = opts.now ?? (() => performance.now());

  let sourceEl: HTMLVideoElement | null = opts.sourceVideoEl;
  let outgoingEl: HTMLVideoElement | null = null;
  let crossfadeStart = 0;
  let endCardStart = 0;
  let raf = 0;
  let running = false;

  // Tracks consecutive drawImage failures so a persistent broken stream
  // (e.g. dead Mux HLS) surfaces as a dev-mode warning rather than silently
  // shipping a recording with a black bottom half (audit M1).
  let drawImageErrorStreak = 0;
  function noteDrawImageError(): void {
    drawImageErrorStreak += 1;
    if (drawImageErrorStreak === 30 && process.env.NODE_ENV !== 'production') {
      // 30 consecutive failed RAF ticks ≈ 1s at 30fps. After that something
      // is structurally broken; surface it.
      console.warn('[composite-canvas] drawImage failed 30 frames running — video src likely dead');
    }
  }
  function noteDrawImageOk(): void { drawImageErrorStreak = 0; }

  function drawCover(
    videoEl: HTMLVideoElement,
    dx: number, dy: number, dw: number, dh: number,
    mirror: boolean,
  ): void {
    const vw = videoEl.videoWidth || 0;
    const vh = videoEl.videoHeight || 0;
    if (vw <= 0 || vh <= 0) {
      // Video metadata not ready (Mux HLS pre-buffer, Simli pre-track).
      // Fill black so prior-frame pixels don't bleed through.
      ctx!.fillStyle = '#000';
      ctx!.fillRect(dx, dy, dw, dh);
      return;
    }
    const lay = computeCoverLayout(vw, vh, dx, dy, dw, dh);
    if (mirror) {
      // try/finally pairs save/restore unconditionally — drawImage can throw
      // InvalidStateError when a video loses its src mid-flight (Mux HLS
      // segment swap, Simli replica restart). Without finally, ctx state
      // (transform, alpha, shadow) leaks into every subsequent frame.
      ctx!.save();
      try {
        ctx!.translate(dx + dw, dy);
        ctx!.scale(-1, 1);
        ctx!.drawImage(videoEl, lay.sx, lay.sy, lay.sw, lay.sh, 0, 0, dw, dh);
        noteDrawImageOk();
      } catch { noteDrawImageError(); }
      finally { ctx!.restore(); }
    } else {
      try {
        ctx!.drawImage(videoEl, lay.sx, lay.sy, lay.sw, lay.sh, dx, dy, dw, dh);
        noteDrawImageOk();
      } catch { noteDrawImageError(); }
    }
  }

  function drawWatermark(): void {
    const wm = opts.watermarkBitmap;
    if (wm) {
      const w = (wm as { width: number }).width;
      const h = (wm as { height: number }).height;
      if (w > 0 && h > 0) {
        const targetW = Math.round(COMPOSITE_WIDTH * WATERMARK_WIDTH_FRAC);
        const targetH = Math.max(1, Math.round((h / w) * targetW));
        ctx!.save();
        try {
          ctx!.globalAlpha = WATERMARK_OPACITY;
          ctx!.drawImage(
            wm as CanvasImageSource,
            COMPOSITE_WIDTH - targetW - WATERMARK_PADDING,
            COMPOSITE_HEIGHT - targetH - URL_FONT_PX - WATERMARK_PADDING * 2,
            targetW,
            targetH,
          );
        } catch { /* drawImage failed — skip the logo this tick */ }
        finally { ctx!.restore(); }
      }
    }
    // Persistent URL — small, high-contrast, drop-shadowed so it survives
    // a re-encode (TT/IG/X re-compress aggressively).
    ctx!.save();
    try {
      ctx!.font = `bold ${URL_FONT_PX}px sans-serif`;
      ctx!.textAlign = 'right';
      ctx!.textBaseline = 'bottom';
      ctx!.shadowColor = 'rgba(0,0,0,0.6)';
      ctx!.shadowBlur = 4;
      ctx!.fillStyle = 'rgba(255,255,255,0.85)';
      ctx!.fillText(
        opts.referralUrl,
        COMPOSITE_WIDTH - WATERMARK_PADDING,
        COMPOSITE_HEIGHT - WATERMARK_PADDING,
      );
    } finally { ctx!.restore(); }
  }

  function drawEndCard(progress: number): void {
    // 0→1 progress over END_CARD_MS. Fade the panel in at 2x rate so it's
    // fully opaque at progress=0.5 and stays full for the second half.
    const alpha = Math.min(1, Math.max(0, progress) * 2);
    ctx!.save();
    try {
      ctx!.globalAlpha = alpha;
      ctx!.fillStyle = 'rgba(0,0,0,0.78)';
      ctx!.fillRect(0, COMPOSITE_HEIGHT - END_CARD_PANEL_HEIGHT, COMPOSITE_WIDTH, END_CARD_PANEL_HEIGHT);
      ctx!.fillStyle = '#fff';
      ctx!.textAlign = 'center';
      ctx!.textBaseline = 'middle';
      ctx!.font = 'bold 22px sans-serif';
      ctx!.fillText(
        `${opts.creatorHandle} on OakLeague`,
        COMPOSITE_WIDTH / 2,
        COMPOSITE_HEIGHT - END_CARD_PANEL_HEIGHT + 50,
      );
      ctx!.font = '18px sans-serif';
      ctx!.fillText(
        opts.referralUrl,
        COMPOSITE_WIDTH / 2,
        COMPOSITE_HEIGHT - END_CARD_PANEL_HEIGHT + 90,
      );
    } finally { ctx!.restore(); }
  }

  function drawFrame(): void {
    const t = now();
    // Top half — selfie cam, mirrored.
    drawCover(opts.cameraVideoEl, 0, 0, COMPOSITE_WIDTH, HALF_HEIGHT, true);

    // Bottom half — source video, possibly mid-crossfade.
    if (outgoingEl && crossfadeStart > 0) {
      const elapsed = t - crossfadeStart;
      // Negative elapsed (clock regression — tab-switch + Date.now drift if
      // the caller injected a non-monotonic now()) → snap to completion
      // rather than freezing the outgoing at full alpha indefinitely.
      if (elapsed < 0 || elapsed >= CROSSFADE_MS) {
        outgoingEl = null;
        crossfadeStart = 0;
        if (sourceEl) {
          drawCover(sourceEl, 0, HALF_HEIGHT, COMPOSITE_WIDTH, HALF_HEIGHT, false);
        } else {
          ctx!.fillStyle = '#000';
          ctx!.fillRect(0, HALF_HEIGHT, COMPOSITE_WIDTH, HALF_HEIGHT);
        }
      } else {
        const { incoming } = crossfadeAlpha(elapsed);
        // Linear-interpolate (audit M2): outgoing at α=1 fully covers prior
        // pixels (no ghost), then incoming at α=t on top. Result pixel =
        // t*incoming + (1-t)*outgoing, which is what we actually want.
        // The naïve "both at fractional α over black" version dipped to
        // 0.5*incoming + 0.25*outgoing at t=0.5 — a visible luminance drop.
        drawCover(outgoingEl, 0, HALF_HEIGHT, COMPOSITE_WIDTH, HALF_HEIGHT, false);
        if (sourceEl) {
          ctx!.save();
          try {
            ctx!.globalAlpha = incoming;
            drawCover(sourceEl, 0, HALF_HEIGHT, COMPOSITE_WIDTH, HALF_HEIGHT, false);
          } finally { ctx!.restore(); }
        }
      }
    } else if (sourceEl) {
      drawCover(sourceEl, 0, HALF_HEIGHT, COMPOSITE_WIDTH, HALF_HEIGHT, false);
    } else {
      // No source yet — black fill rather than leaving prior pixels.
      ctx!.fillStyle = '#000';
      ctx!.fillRect(0, HALF_HEIGHT, COMPOSITE_WIDTH, HALF_HEIGHT);
    }

    // Persistent watermark + URL — drawn every tick for the full duration.
    drawWatermark();

    // End-card overlay — only during the last END_CARD_MS.
    if (endCardStart > 0) {
      const progress = Math.min(1, Math.max(0, (t - endCardStart) / END_CARD_MS));
      drawEndCard(progress);
    }
  }

  function loop(): void {
    if (!running) return;
    drawFrame();
    raf = requestAnimationFrame(loop);
  }

  return {
    canvas: opts.canvas,
    start(): void {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(loop);
    },
    stop(): void {
      if (!running) return;
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      // Reset transient timers (audit M1) — without this, a second start()
      // after stop() inherits an end-card or crossfade timestamp from the
      // previous run and instantly draws stale state.
      outgoingEl = null;
      crossfadeStart = 0;
      endCardStart = 0;
    },
    swapSource(newSourceEl: HTMLVideoElement | null): void {
      if (newSourceEl === sourceEl) return;
      // Snap any in-flight crossfade to completion before starting the next
      // (audit C2) — chained Ask→re-Ask swaps would otherwise drop the
      // original outgoing frame and visually jump.
      outgoingEl = sourceEl;
      sourceEl = newSourceEl;
      crossfadeStart = now();
    },
    enableEndCard(): void {
      if (endCardStart > 0) return;
      endCardStart = now();
    },
    drawFrame,
  };
}
