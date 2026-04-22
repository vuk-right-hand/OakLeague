// Advisory automated mouth-ROI metric. NOT IN THE GATE.
//
// See SPIKE_B_PLAN.md Rev 3 C1 / Rev 5 decision 8: luminance-variance cannot
// separate blinks / breathing / idle jitter from first phoneme without
// per-session idle baseline + lip-contour displacement (a week of OpenCV/ML
// work, out of spike scope). Blind rater scores are the sole gate signal.
//
// This module computes a cheap diagnostic number for the results appendix.
// Returned diff values are unitless luminance deltas in [0..255], averaged
// across the bounding box. Do NOT threshold these; just log them.

export type MouthRoi = { x: number; y: number; w: number; h: number };

// Default ROI — lower-middle third of a 9:16 portrait frame. Callers may
// override per-provider if the framing differs materially (Tavus Phoenix-4
// tends to frame tighter than Simli).
export const DEFAULT_MOUTH_ROI: MouthRoi = { x: 0.33, y: 0.60, w: 0.34, h: 0.22 };

// Compute mean-luminance delta between two frames inside the ROI. Frames are
// ImageData-compatible (RGBA). Intended for use off an OffscreenCanvas fed
// by the <video> track at ~30 fps — NOT main-thread canvas (jank).
export function meanLumaDelta(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  height: number,
  roi: MouthRoi = DEFAULT_MOUTH_ROI,
): number {
  if (a.length !== b.length || a.length !== width * height * 4) return 0;

  const x0 = Math.max(0, Math.floor(roi.x * width));
  const y0 = Math.max(0, Math.floor(roi.y * height));
  const x1 = Math.min(width, Math.floor((roi.x + roi.w) * width));
  const y1 = Math.min(height, Math.floor((roi.y + roi.h) * height));

  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      // Rec. 601 luma approximation, integer-friendly.
      const la = (a[i] * 299 + a[i + 1] * 587 + a[i + 2] * 114) / 1000;
      const lb = (b[i] * 299 + b[i + 1] * 587 + b[i + 2] * 114) / 1000;
      sum += Math.abs(la - lb);
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}
