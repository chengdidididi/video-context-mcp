import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getGridSpec } from '../config.js';
import { mapWithConcurrency } from '../utils/exec.js';
import { formatFrameTimestamp, formatSlugTimestamp } from '../utils/time.js';

/**
 * Render an SVG buffer for the 24px zero-occlusion black top header bar with crisp white monospace text:
 * e.g. "#001 | 00:12.5"
 */
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
 * Compose extracted 640x360 frames into 3x3 grids (1924x1156) with 24px top header bars,
 * and generate the structured frames_index JSON data (with 2D matrix_sec + frame list).
 */
export async function composeGrids({
  extractedFrames,
  gridsDir,
  relativeDirPrefix = 'grids',
  sourceStreamHeight = null,
  spec,
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
  const canvasHeight = rows * totalCellHeight + (rows - 1) * gutter;

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

  const gridsMeta = await mapWithConcurrency(gridIndices, 4, async (g) => {
    const chunk = extractedFrames.slice(g * perGrid, (g + 1) * perGrid);
    const gridIndex = g + 1;
    const startSec = chunk[0].timestampSec;
    const endSec = chunk[chunk.length - 1].timestampSec;

    const filename = `grid_${String(gridIndex).padStart(3, '0')}_${formatSlugTimestamp(startSec)}-${formatSlugTimestamp(endSec)}.jpg`;
    const destPath = path.join(gridsDir, filename);

    const matrixSec = Array.from({ length: rows }, () => Array(cols).fill(null));
    const frameRecords = [];
    const composites = [];

    for (let slot = 0; slot < perGrid; slot++) {
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
        height: canvasHeight,
        channels: 3,
        background: { r: 31, g: 31, b: 31 },
      },
    })
      .composite(composites)
      .jpeg({ quality: jpegQuality })
      .toFile(destPath);

    return {
      grid_index: gridIndex,
      file: `${relativeDirPrefix}/${filename}`,
      abs_path: destPath,
      start_sec: startSec,
      end_sec: endSec,
      matrix_sec: matrixSec,
      frames: frameRecords,
    };
  });

  gridsMeta.sort((a, b) => a.grid_index - b.grid_index);

  const indexPayload = {
    grid_layout: [rows, cols],
    cell_content_size: [cellWidth, cellHeight],
    header_bar_height: headerHeight,
    grid_image_size: [canvasWidth, canvasHeight],
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
