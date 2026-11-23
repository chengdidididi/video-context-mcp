import { roundSec } from '../utils/time.js';

/**
 * Compute 8x6 localized patch differences + global mean difference between two 8-bit grayscale frames.
 * Captures both localized UI/popup/code/subtitle changes (via top2TileAvg) and broad scrolls/cuts (via meanDiff).
 */
export function computePatchVisualDiff(bufA, bufB, width = 160, height = 90, tileCols = 8, tileRows = 6) {
  const tileW = Math.floor(width / tileCols);
  const tileH = Math.floor(height / tileRows);
  const normFactor = 1 / (tileW * tileH * 255);
  const totalTiles = tileCols * tileRows;

  let top1 = 0;
  let top2 = 0;
  let sumTiles = 0;

  for (let tr = 0; tr < tileRows; tr++) {
    const yStart = tr * tileH;
    for (let tc = 0; tc < tileCols; tc++) {
      const xStart = tc * tileW;
      let absSum = 0;
      for (let y = 0; y < tileH; y++) {
        const rowOffset = (yStart + y) * width + xStart;
        for (let x = 0; x < tileW; x++) {
          const idx = rowOffset + x;
          const diff = bufA[idx] - bufB[idx];
          absSum += diff < 0 ? -diff : diff;
        }
      }
      const tileDiff = absSum * normFactor;
      sumTiles += tileDiff;
      if (tileDiff >= top1) {
        top2 = top1;
        top1 = tileDiff;
      } else if (tileDiff > top2) {
        top2 = tileDiff;
      }
    }
  }

  const meanDiff = sumTiles / totalTiles;
  const top2Avg = (top1 + top2) * 0.5;
  const novelty = Math.max(meanDiff * 1.8, top2Avg);

  return { novelty, top2Avg, meanDiff };
}

/**
 * Two-Gate Stateful Visual Tracker:
 *  - Gate 1 (Cumulative Patch Diff): Compares current frame against `refBuf` (the last emitted frame)
 *    across 8x6 localized tiles so gradual scrolls, slow fades, small popups, and typed code lines are all caught.
 *  - Gate 2 (Change-then-Settle): Once Gate 1 triggers, waits until step-to-step motion drops below `settleThreshold`
 *    (so mid-scroll blur and half-faded transitions are skipped in favor of crisp settled frames),
 *    with a `maxPendingWaitSec` cap so continuous live-action pans still emit their sharpest intermediate frame.
 */
export function createTwoGateTracker({
  width = 160,
  height = 90,
  tileCols = 8,
  tileRows = 6,
  diffThreshold = 0.12,
  settleThreshold = 0.045,
  minIntervalSec = 0.4,
  maxPendingWaitSec = 2.4,
} = {}) {
  let refBuf = null;
  let prevBuf = null;
  let lastEmittedSec = -Infinity;
  let pending = null;
  const candidates = [];

  function emit(timestampSec, buf, noveltyScore, trigger) {
    const rounded = roundSec(timestampSec, 2);
    candidates.push({
      timestampSec: rounded,
      importance: Math.min(1.5, Math.max(0.1, noveltyScore)),
      trigger,
    });
    refBuf = Buffer.from(buf);
    lastEmittedSec = timestampSec;
    pending = null;
  }

  function pushFrame(frameSlice, frameIndex, timestampSec) {
    if (frameIndex === 0 || !refBuf || !prevBuf) {
      emit(timestampSec, frameSlice, 1.0, 'opening');
      prevBuf = Buffer.from(frameSlice);
      return;
    }

    const vsRef = computePatchVisualDiff(frameSlice, refBuf, width, height, tileCols, tileRows);
    const vsPrev = computePatchVisualDiff(frameSlice, prevBuf, width, height, tileCols, tileRows);

    if (!pending) {
      if (
        timestampSec - lastEmittedSec >= minIntervalSec &&
        vsRef.novelty >= diffThreshold
      ) {
        if (vsPrev.novelty <= settleThreshold) {
          // Slow cumulative drift reached threshold while already settled
          emit(timestampSec, frameSlice, vsRef.novelty, 'cumulative_drift');
        } else {
          // Enter Gate 2: wait for transition/scroll/animation to settle
          pending = {
            startSec: timestampSec,
            maxNovelty: vsRef.novelty,
            bestSec: timestampSec,
            bestBuf: Buffer.from(frameSlice),
            bestStepMotion: vsPrev.novelty,
          };
        }
      }
    } else {
      // Cancel transient 1-frame glitch/flash if screen reverted back to refBuf
      if (vsRef.novelty < diffThreshold * 0.65) {
        pending = null;
      } else {
        pending.maxNovelty = Math.max(pending.maxNovelty, vsRef.novelty);
        if (vsPrev.novelty <= pending.bestStepMotion) {
          pending.bestSec = timestampSec;
          pending.bestBuf = Buffer.from(frameSlice);
          pending.bestStepMotion = vsPrev.novelty;
        }

        if (vsPrev.novelty <= settleThreshold) {
          // Gate 2 passed: screen settled cleanly!
          emit(timestampSec, frameSlice, pending.maxNovelty, 'settled_state');
        } else if (timestampSec - pending.startSec >= maxPendingWaitSec) {
          // Continuous action/panning exceeded wait window: emit least-blurred frame in window
          if (pending.bestSec - lastEmittedSec >= minIntervalSec) {
            emit(pending.bestSec, pending.bestBuf, pending.maxNovelty, 'continuous_motion');
          } else {
            emit(timestampSec, frameSlice, pending.maxNovelty, 'continuous_motion');
          }
        }
      }
    }

    prevBuf = Buffer.from(frameSlice);
  }

  function flush() {
    if (pending && pending.bestSec - lastEmittedSec >= minIntervalSec) {
      emit(pending.bestSec, pending.bestBuf, pending.maxNovelty, 'settled_eof');
    }
    return candidates;
  }

  return { pushFrame, flush };
}

/**
 * Finalize Two-Gate candidates with:
 *  1. Subtitle boundary synergy bonus (+0.15 importance when visual change aligns with speech segment start)
 *  2. Sparse static fallback (only if screen stays completely unchanged for > maxIntervalSec)
 *  3. Importance * Temporal-Spacing Cap ("一个上限"): prunes excess frames down to `maxFrames`
 *     by iteratively dropping the weakest & most crowded point while preserving high-impact visual changes.
 */
export function finalizeSamplePlan({
  rawCandidates = [],
  subtitleSegments = [],
  durationSec = 10,
  minIntervalSec = 0.4,
  maxIntervalSec = 15.0,
  maxFrames = 180,
}) {
  const safeDuration = Math.max(0.5, Number(durationSec || 0));
  const safeEnd = Math.max(0.1, safeDuration - 0.15);

  const subStarts = subtitleSegments
    .map((s) => Number(s.start))
    .filter((t) => Number.isFinite(t));

  const points = rawCandidates
    .map((c) => {
      const clampedTs = roundSec(Math.min(safeEnd, Math.max(0, c.timestampSec)), 2);
      const nearSub = subStarts.some((st) => Math.abs(st - clampedTs) <= 1.0);
      return {
        timestampSec: clampedTs,
        importance: c.importance + (nearSub ? 0.15 : 0),
        trigger: c.trigger,
      };
    })
    .sort((a, b) => a.timestampSec - b.timestampSec);

  // Deduplicate any clamped collisions < minIntervalSec (keep higher importance)
  const deduped = [];
  for (const pt of points) {
    if (deduped.length === 0) {
      deduped.push(pt);
      continue;
    }
    const prev = deduped[deduped.length - 1];
    if (pt.timestampSec - prev.timestampSec >= minIntervalSec) {
      deduped.push(pt);
    } else if (pt.importance > prev.importance) {
      deduped[deduped.length - 1] = pt;
    }
  }

  if (deduped.length === 0) {
    deduped.push({ timestampSec: roundSec(Math.min(0.4, safeEnd * 0.25), 2), importance: 1.0, trigger: 'opening' });
  }

  // Insert sparse fallback points ONLY in very long completely static gaps (> maxIntervalSec)
  const effectiveMaxGap = Math.max(maxIntervalSec, minIntervalSec * 3);
  const withFallback = [];
  for (let i = 0; i < deduped.length; i++) {
    withFallback.push(deduped[i]);
    const curTs = deduped[i].timestampSec;
    const nextTs = i + 1 < deduped.length ? deduped[i + 1].timestampSec : safeEnd;
    const gap = nextTs - curTs;
    if (gap > effectiveMaxGap) {
      const steps = Math.ceil(gap / effectiveMaxGap);
      const stepSec = gap / steps;
      for (let k = 1; k < steps; k++) {
        const fbTs = roundSec(Math.min(safeEnd, curTs + k * stepSec), 2);
        if (fbTs - curTs >= minIntervalSec && nextTs - fbTs >= minIntervalSec) {
          withFallback.push({
            timestampSec: fbTs,
            importance: 0.08,
            trigger: 'static_fallback',
          });
        }
      }
    }
  }

  withFallback.sort((a, b) => a.timestampSec - b.timestampSec);

  // Cap ("一个上限"): Importance * Min-Neighbor-Gap iterative pruning down to maxFrames
  const capped = [...withFallback];
  while (capped.length > maxFrames && capped.length > 2) {
    let worstIdx = 1;
    let worstKeepValue = Infinity;

    for (let i = 1; i < capped.length - 1; i++) {
      const leftGap = capped[i].timestampSec - capped[i - 1].timestampSec;
      const rightGap = capped[i + 1].timestampSec - capped[i].timestampSec;
      const minGap = Math.min(leftGap, rightGap);
      const keepValue = capped[i].importance * (minGap + 0.05);
      if (keepValue < worstKeepValue) {
        worstKeepValue = keepValue;
        worstIdx = i;
      }
    }
    capped.splice(worstIdx, 1);
  }

  return capped.map((pt, idx) => ({
    frameNo: idx + 1,
    timestampSec: roundSec(pt.timestampSec, 2),
    trigger: pt.trigger,
  }));
}
