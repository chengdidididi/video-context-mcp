import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  extractVideo,
  getAuthStatus,
  manageConfig,
} from './pipeline.js';
import { AuthRequiredError } from './platforms/auth.js';

const SERVER_INSTRUCTIONS = `
Video Context MCP packages deterministic YouTube and Bilibili video URLs/BV IDs into a unified local Context Bundle in a single call.
Workflow:
1. Only pass deterministic URLs, BV IDs, or YouTube Video IDs (never fuzzy video titles; search first if needed).
2. Call video_extract once: it outputs metadata (manifest.json), cleaned transcript (transcript.md), progress-bar sprites (sprites/), Two-Gate settled 3x3 timestamped grids (grids/), and 2D timestamp matrix (frames_index.json), returning ONLY their local file paths.
3. Read transcript.md first to locate relevant timestamps, then selectively read only the matching grid_xxx.jpg image files (each cell has a zero-occlusion top black bar "#FrameNo | Timestamp").
`.trim();

function formatToolResponse(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function formatToolError(err) {
  const payload =
    err instanceof AuthRequiredError
      ? {
          error: true,
          code: err.code,
          message: err.message,
          auth_details: err.details,
        }
      : {
          error: true,
          code: 'EXECUTION_ERROR',
          message: err?.message || String(err),
        };

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function createVideoContextMcpServer() {
  const server = new McpServer(
    {
      name: 'video-context-mcp',
      version: '2.0.0',
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // Tool 1: video_extract (Unified One-Shot Pipeline)
  server.tool(
    'video_extract',
    'One-shot video context extraction: download subtitles, native progress-bar sprites, and pure video stream; run Two-Gate (8x6 patch cumulative diff + motion settle) + max_frames cap to generate zero-occlusion 3x3 timestamped grids; return local file paths only.',
    {
      url_or_id: z
        .string()
        .describe('Deterministic YouTube/Bilibili URL, BV ID (e.g. BV1xx...), av ID, or 11-char YouTube ID.'),
      part: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('1-indexed part number for multi-part Bilibili videos (defaults to 1).'),
      output_dir: z
        .string()
        .optional()
        .describe('Optional custom root output directory override for this request.'),
      diff_threshold: z
        .number()
        .min(0.03)
        .max(0.6)
        .optional()
        .describe('Override Gate 1 cumulative 8x6 patch visual diff threshold (default from config.yaml: 0.12).'),
      settle_threshold: z
        .number()
        .min(0.01)
        .max(0.25)
        .optional()
        .describe('Override Gate 2 motion-settle threshold (default from config.yaml: 0.045).'),
      max_frames: z
        .number()
        .int()
        .min(9)
        .max(450)
        .optional()
        .describe('Override global maximum frames cap (default from config.yaml: 180).'),
      allow_guest_degraded: z
        .boolean()
        .optional()
        .describe('Override allow_guest_degraded for Bilibili without login cookie.'),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe('Force re-extraction even if completed bundle already exists in output.'),
    },
    async (args) => {
      try {
        const res = await extractVideo(args);
        return formatToolResponse(res);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  // Tool 2: video_auth_status
  server.tool(
    'video_auth_status',
    'Check yt-dlp/ffmpeg binary availability, active output directory, active env overrides, and live Bilibili login status.',
    {},
    async () => {
      try {
        const res = await getAuthStatus();
        return formatToolResponse(res);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  // Tool 3: video_config
  server.tool(
    'video_config',
    'Read current effective settings (and environment variable mapping) or persist setting updates directly into config.yaml.',
    {
      output_dir: z.string().optional().describe('Persist default output directory (env: VIDEO_CONTEXT_OUTPUT_DIR).'),
      bilibili_cookie: z
        .string()
        .optional()
        .describe('Persist Bilibili Cookie string in config.yaml (env: BILIBILI_COOKIE).'),
      allow_guest_degraded: z
        .boolean()
        .optional()
        .describe('Persist guest degraded fallback toggle (env: VIDEO_CONTEXT_ALLOW_GUEST).'),
      probe_fps: z
        .number()
        .min(0.5)
        .max(10)
        .optional()
        .describe('Persist grayscale probe stream FPS (env: VIDEO_CONTEXT_PROBE_FPS).'),
      diff_threshold: z
        .number()
        .min(0.03)
        .max(0.6)
        .optional()
        .describe('Persist Gate 1 cumulative patch diff threshold (env: VIDEO_CONTEXT_DIFF_THRESHOLD).'),
      settle_threshold: z
        .number()
        .min(0.01)
        .max(0.25)
        .optional()
        .describe('Persist Gate 2 motion-settle threshold (env: VIDEO_CONTEXT_SETTLE_THRESHOLD).'),
      min_interval_sec: z
        .number()
        .min(0.2)
        .optional()
        .describe('Persist minimum debounce interval (env: VIDEO_CONTEXT_MIN_INTERVAL_SEC).'),
      max_interval_sec: z
        .number()
        .min(2.0)
        .optional()
        .describe('Persist maximum static fallback interval (env: VIDEO_CONTEXT_MAX_INTERVAL_SEC).'),
      max_frames: z
        .number()
        .int()
        .min(9)
        .max(450)
        .optional()
        .describe('Persist max frames cap (env: VIDEO_CONTEXT_MAX_FRAMES).'),
      grid_cols: z.number().int().min(1).max(6).optional().describe('Persist grid columns (env: VIDEO_CONTEXT_GRID_COLS).'),
      grid_rows: z.number().int().min(1).max(6).optional().describe('Persist grid rows (env: VIDEO_CONTEXT_GRID_ROWS).'),
      cell_width: z.number().int().min(160).max(1920).optional().describe('Persist cell width px (env: VIDEO_CONTEXT_CELL_WIDTH).'),
      cell_height: z.number().int().min(90).max(1080).optional().describe('Persist cell height px (env: VIDEO_CONTEXT_CELL_HEIGHT).'),
      header_height: z.number().int().min(16).max(64).optional().describe('Persist top header bar height px (env: VIDEO_CONTEXT_HEADER_HEIGHT).'),
      gutter: z.number().int().min(0).max(16).optional().describe('Persist grid gutter px (env: VIDEO_CONTEXT_GRID_GUTTER).'),
      jpeg_quality: z.number().int().min(40).max(100).optional().describe('Persist JPEG quality (env: VIDEO_CONTEXT_JPEG_QUALITY).'),
    },
    async (args) => {
      try {
        const res = await manageConfig(args);
        return formatToolResponse(res);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  // Tool 4: video_read_image
  server.tool(
    'video_read_image',
    'Return a single generated grid or sprite image as MCP ImageContent (for clients without direct local image file reading).',
    {
      image_path: z.string().describe('Absolute path to a generated .jpg/.png/.webp file inside output.'),
    },
    async ({ image_path }) => {
      try {
        const resolved = path.resolve(image_path);
        if (!fs.existsSync(resolved)) {
          throw new Error(`Image file not found: ${resolved}`);
        }
        const ext = path.extname(resolved).toLowerCase();
        if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
          throw new Error(`Unsupported image extension "${ext}".`);
        }
        const mimeType =
          ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        const data = (await fs.promises.readFile(resolved)).toString('base64');

        return {
          content: [
            {
              type: 'image',
              data,
              mimeType,
            },
          ],
        };
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  return server;
}

export async function startStdioMcpServer() {
  const server = createVideoContextMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
