import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getGridSpec } from '../config.js';
import { mapWithConcurrency } from '../utils/exec.js';
import { formatFrameTimestamp, formatSlugTimestamp } from '../utils/time.js';

/**
 * Automatically adapt grid & probe geometry for vertical/portrait videos (`aspect_ratio <= ~0.87`, e.g. 9:16, 3:4, 4:5)
 * when the user has not manually overridden the default 3x3 640x360 landscape grid settings:
 * - Landscape (`16:9`, `4:3`, `1:1`): 3 cols × 3 rows (9 frames), cell `640×360`, probe `160×90` (`8×6` tiles)
 * - Portrait (`9:16`, `3:4`):         5 cols × 2 rows (10 frames), cell `360×640`, probe `90×160` (`6×8` tiles)
 *   -> Eliminates 68.4% black pillarbox waste and boosts effective horizontal text resolution by 1.78x (area 3.16x).
 */
export function resolveOrientationAwareGridSpec(sourceWidth = 0, sourceHeight = 0, baseSpec = null) {
  const spec = baseSpec || getGridSpec();
  const isDefaultLandscapeCfg =
    spec.cols === 3 &&
    spec.rows === 3 &&
    spec.cellWidth === 640 &&
    spec.cellHeight === 360;

  const isPortraitSource =
    sourceWidth > 0 && sourceHeight > 0 && sourceHeight / sourceWidth >= 1.15;

  if (isDefaultLandscapeCfg && isPortraitSource) {
    return {
      ...spec,
      orientation: 'portrait',
      cols: 5,
      rows: 2,
      cellWidth: 360,
      cellHeight: 640,
      probeWidth: 90,
      probeHeight: 160,
      tileCols: 6,
      tileRows: 8,
    };
  }

  return {
    ...spec,
    orientation: isPortraitSource ? 'portrait' : 'landscape',
    probeWidth: isPortraitSource ? 90 : 160,
    probeHeight: isPortraitSource ? 160 : 90,
    tileCols: isPortraitSource ? 6 : 8,
    tileRows: isPortraitSource ? 8 : 6,
  };
}

function createHeaderBarSvg(label, width, height) {
  const escaped = label
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#000000"/>
    <line x1="0" y1="${height - 1}" x2="${width}" y2="${height - 1}" stroke="#262626" stroke-width="1"/>
    <text x="10" y="${Math.round(height * 0.71)}" fill="#FFFFFF" font-family="Menlo, Monaco, Consolas, 'Courier New', monospace" font-size="14" font-weight="700" letter-spacing="0.4px">${escaped}</text>
  </svg>`;

  return Buffer.from(svg);
}

/**
 * Compose extracted frames into timestamped grids (3x3 landscape or 5x2 portrait) with 24px zero-occlusion header bars,
 * dynamically cropping empty trailing rows on the final grid image to save 33%–67% visual tokens on partial pages.
 */
export async function composeGrids({
  extractedFrames,
  gridsDir,
  relativeDirPrefix = 'grids',
  sourceStreamHeight = null,
  spec,
  signal = null,
}) {
  const effectiveSpec = spec || getGridSpec();
  await fs.promises.mkdir(gridsDir, { recursive: true });

  const {
    cols,
    rows,
    cellWidth,
    cellHeight,
    headerHeight,
    gutter,
    jpegQuality,
  } = effectiveSpec;

  const totalCellHeight = cellHeight + headerHeight;
  const perGrid = cols * rows;
  const canvasWidth = cols * cellWidth + (cols - 1) * gutter;
  const fullCanvasHeight = rows * totalCellHeight + (rows - 1) * gutter;

  const maxTs = extractedFrames[extractedFrames.length - 1]?.timestampSec || 0;
  const forceHours = maxTs >= 3600;
  const padDigits = Math.max(3, String(extractedFrames.length).length);

  const totalGrids = Math.ceil(extractedFrames.length / perGrid);
  const gridIndices = Array.from({ length: totalGrids }, (_, g) => g);

  const blackSlotPromise = sharp({
    create: {
      width: cellWidth,
      height: totalCellHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();

  const gridsMeta = await mapWithConcurrency(
    gridIndices,
    4,
    async (g) => {
      const chunk = extractedFrames.slice(g * perGrid, (g + 1) * perGrid);
      const gridIndex = g + 1;
      const startSec = chunk[0].timestampSec;
      const endSec = chunk[chunk.length - 1].timestampSec;

      // Dynamically crop empty trailing rows on the tail grid (e.g. 1..3 frames -> 1 row instead of 3 rows)
      const activeRows = Math.max(1, Math.min(rows, Math.ceil(chunk.length / cols)));
      const activeSlots = activeRows * cols;
      const gridCanvasHeight = activeRows * totalCellHeight + (activeRows - 1) * gutter;

      const filename = `grid_${String(gridIndex).padStart(3, '0')}_${formatSlugTimestamp(startSec)}-${formatSlugTimestamp(endSec)}.jpg`;
      const destPath = path.join(gridsDir, filename);

      const matrixSec = Array.from({ length: activeRows }, () => Array(cols).fill(null));
      const frameRecords = [];
      const composites = [];

      for (let slot = 0; slot < activeSlots; slot++) {
        const r = Math.floor(slot / cols);
        const c = slot % cols;
        const left = c * (cellWidth + gutter);
        const top = r * (totalCellHeight + gutter);

        const item = chunk[slot];
        if (!item) {
          composites.push({ input: await blackSlotPromise, left, top });
          continue;
        }

        const tsStr = formatFrameTimestamp(item.timestampSec, forceHours);
        const frameNumStr = String(item.frameNo).padStart(padDigits, '0');
        const label = `#${frameNumStr} | ${tsStr}`;

        const headerSvg = createHeaderBarSvg(label, cellWidth, headerHeight);

        composites.push({
          input: headerSvg,
          left,
          top,
        });
        composites.push({
          input: item.frameBuffer || item.framePath,
          left,
          top: top + headerHeight,
        });

        matrixSec[r][c] = item.timestampSec;
        frameRecords.push({
          frame_no: item.frameNo,
          label,
          row: r,
          col: c,
          timestamp_sec: item.timestampSec,
          timestamp_str: tsStr,
          trigger: item.trigger,
        });
      }

      await sharp({
        create: {
          width: canvasWidth,
          height: gridCanvasHeight,
          channels: 3,
          background: { r: 44, g: 44, b: 48 },
        },
      })
        .composite(composites)
        .jpeg({ quality: jpegQuality })
        .toFile(destPath);

      return {
        grid_index: gridIndex,
        file: `${relativeDirPrefix}/${filename}`,
        abs_path: destPath,
        rows: activeRows,
        cols,
        image_size: [canvasWidth, gridCanvasHeight],
        start_sec: startSec,
        end_sec: endSec,
        matrix_sec: matrixSec,
        frames: frameRecords,
      };
    },
    signal
  );

  gridsMeta.sort((a, b) => a.grid_index - b.grid_index);

  const indexPayload = {
    orientation: effectiveSpec.orientation || 'landscape',
    grid_layout: [rows, cols],
    cell_content_size: [cellWidth, cellHeight],
    header_bar_height: headerHeight,
    grid_image_size: [canvasWidth, fullCanvasHeight],
    source_stream_height: sourceStreamHeight,
    total_frames: extractedFrames.length,
    total_grids: gridsMeta.length,
    grids: gridsMeta.map(({ abs_path, ...rest }) => rest),
  };

  return {
    indexPayload,
    gridsWithAbsPaths: gridsMeta,
  };
}
