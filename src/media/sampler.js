import { roundSec } from '../utils/time.js';

const PRIORITY = {
  scene: 3,
  subtitle: 2,
  fallback: 1,
};

/**
 * Multi-signal frame sampling planner per SPEC 5.2:
 * Combines:
 *  1. Scene changes (gt(scene, threshold)) + opening anchor
 *  2. Subtitle semantic anchors: min(start + 0.4s, midpoint)
 *  3. Max-interval fallback: fills any gap > maxIntervalSec
 * Enforces priority-aware debounce (Δt >= minIntervalSec, preferring scene > subtitle > fallback).
 */
export function buildHybridSamplePlan({
  durationSec,
  sceneTimestamps = [],
  subtitleSegments = [],
  minIntervalSec = 1.0,
  maxIntervalSec = 8.0,
  maxFrames = 180,
}) {
  const safeDuration = Math.max(0.5, Number(durationSec || 0));
  const safeEnd = Math.max(0.1, safeDuration - 0.15);

  // Adaptive minimum interval if video is very long so total frames stay <= maxFrames
  const effectiveMinInterval = Math.max(
    minIntervalSec,
    safeDuration / Math.max(9, maxFrames)
  );

  const candidates = [];

  // Always include an opening frame near the start
  const openingTs = Math.min(0.5, safeEnd * 0.25);
  candidates.push({
    timestampSec: roundSec(openingTs, 2),
    trigger: 'scene',
    priority: PRIORITY.scene,
  });

  // 1. Scene change points (+0.1s stabilization so mid-transition crossfades settle)
  for (const rawTs of sceneTimestamps) {
    const stabilized = Math.min(safeEnd, Math.max(0, Number(rawTs) + 0.1));
    candidates.push({
      timestampSec: roundSec(stabilized, 2),
      trigger: 'scene',
      priority: PRIORITY.scene,
    });
  }

  // 2. Subtitle semantic anchors
  let lastSubAnchor = -Infinity;
  for (const seg of subtitleSegments) {
    if (seg.start === undefined) continue;
    const mid = (seg.start + (seg.end ?? seg.start + 1.0)) / 2;
    const anchor = Math.min(safeEnd, Math.max(0, Math.min(seg.start + 0.4, mid)));
    // Pre-filter ultra-dense subtitle anchors using effectiveMinInterval
    if (anchor - lastSubAnchor >= effectiveMinInterval) {
      candidates.push({
        timestampSec: roundSec(anchor, 2),
        trigger: 'subtitle',
        priority: PRIORITY.subtitle,
      });
      lastSubAnchor = anchor;
    }
  }

  // Sort chronologically
  candidates.sort((a, b) => a.timestampSec - b.timestampSec || b.priority - a.priority);

  // Priority-aware debounce pass (Δt >= effectiveMinInterval)
  const debounced = [];
  for (const cand of candidates) {
    if (debounced.length === 0) {
      debounced.push({ ...cand });
      continue;
    }

    const prev = debounced[debounced.length - 1];
    const delta = cand.timestampSec - prev.timestampSec;

    if (delta >= effectiveMinInterval) {
      debounced.push({ ...cand });
    } else if (cand.priority > prev.priority) {
      // Higher-priority trigger (e.g. scene cut right after subtitle start) replaces lower-priority point
      // as long as it doesn't violate interval with debounced[length - 2]
      const beforePrev = debounced.length >= 2 ? debounced[debounced.length - 2] : null;
      if (!beforePrev || cand.timestampSec - beforePrev.timestampSec >= effectiveMinInterval) {
        debounced[debounced.length - 1] = { ...cand };
      }
    }
  }

  // 3. Max-interval fallback pass: fill any silent/static gap > maxIntervalSec
  const effectiveMaxInterval = Math.max(maxIntervalSec, effectiveMinInterval * 1.5);
  const withFallback = [];

  const insertGapFallbacks = (fromSec, toSec) => {
    const span = toSec - fromSec;
    if (span <= effectiveMaxInterval) return;
    const steps = Math.ceil(span / effectiveMaxInterval);
    const stepSize = span / steps;
    for (let k = 1; k < steps; k++) {
      const fbTs = roundSec(Math.min(safeEnd, fromSec + k * stepSize), 2);
      if (
        fbTs - fromSec >= effectiveMinInterval &&
        toSec - fbTs >= effectiveMinInterval
      ) {
        withFallback.push({
          timestampSec: fbTs,
          trigger: 'fallback',
          priority: PRIORITY.fallback,
        });
      }
    }
  };

  if (debounced.length === 0) {
    withFallback.push({
      timestampSec: roundSec(openingTs, 2),
      trigger: 'fallback',
      priority: PRIORITY.fallback,
    });
    insertGapFallbacks(openingTs, safeEnd);
  } else {
    insertGapFallbacks(0, debounced[0].timestampSec);
    for (let i = 0; i < debounced.length; i++) {
      withFallback.push(debounced[i]);
      const nextTs = i + 1 < debounced.length ? debounced[i + 1].timestampSec : safeEnd;
      insertGapFallbacks(debounced[i].timestampSec, nextTs);
    }
  }

  withFallback.sort((a, b) => a.timestampSec - b.timestampSec);

  // Enforce hard cap maxFrames by uniform stride if needed
  let finalPoints = withFallback;
  if (finalPoints.length > maxFrames) {
    const sampled = [];
    for (let i = 0; i < maxFrames; i++) {
      const idx = Math.min(
        finalPoints.length - 1,
        Math.round((i * (finalPoints.length - 1)) / (maxFrames - 1))
      );
      sampled.push(finalPoints[idx]);
    }
    finalPoints = sampled;
  }

  return finalPoints.map((pt, idx) => ({
    frameNo: idx + 1,
    timestampSec: roundSec(pt.timestampSec, 2),
    trigger: pt.trigger,
  }));
}

/**
 * Build uniform interval sample points for Tier 3 clip microscope.
 */
export function buildIntervalSamplePlan({
  startSec,
  endSec,
  intervalSec = 0.5,
  maxFrames = 240,
}) {
  const span = Math.max(0.1, endSec - startSec);
  const effectiveInterval = Math.max(0.1, intervalSec, span / maxFrames);
  const points = [];
  let frameNo = 1;

  for (let t = startSec; t <= endSec + 1e-6; t += effectiveInterval) {
    const clamped = Math.min(endSec, t);
    points.push({
      frameNo: frameNo++,
      timestampSec: roundSec(clamped, 2),
      localSec: roundSec(clamped - startSec, 3),
      trigger: 'interval',
    });
    if (frameNo > maxFrames) break;
  }

  return points;
}
