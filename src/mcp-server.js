import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  extractVideoClip,
  extractVideoGrids,
  getAuthStatus,
  inspectVideo,
  manageConfig,
} from './pipeline.js';
import { AuthRequiredError } from './platforms/auth.js';

const SERVER_INSTRUCTIONS = `
Video Context MCP converts deterministic YouTube and Bilibili video URLs/BV IDs into local multimodal Context Bundles under a unified output directory (configured in config.yaml or VIDEO_CONTEXT_OUTPUT_DIR).
Follow this progressive workflow:
1. Only pass deterministic URLs, BV IDs, or YouTube Video IDs (never fuzzy video titles; search first if needed).
2. Always call video_inspect (Tier 1) first to read cleaned timestamps in transcript and video metadata/chapters. If the transcript alone answers the user's question (e.g. talking-head podcast), stop and answer directly.
3. Call video_extract_grids (Tier 2) when global visual context (slides, code, actions) is needed. Read only the specific grid image paths covering relevant timestamps. Every cell has a zero-occlusion top black header "#FrameNo | Timestamp".
4. Call video_extract_clip (Tier 3) for dense inspection of a short key segment or output_mode="raw_frames" for clean unwatermarked screenshots.
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
      version: '1.0.0',
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // Tool 1: video_auth_status
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

  // Tool 2: video_config
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
      scene_threshold: z
        .number()
        .min(0.05)
        .max(0.95)
        .optional()
        .describe('Persist Tier 2 scene threshold (env: VIDEO_CONTEXT_SCENE_THRESHOLD).'),
      min_interval_sec: z
        .number()
        .min(0.2)
        .optional()
        .describe('Persist Tier 2 minimum debounce interval (env: VIDEO_CONTEXT_MIN_INTERVAL_SEC).'),
      max_interval_sec: z
        .number()
        .min(1.0)
        .optional()
        .describe('Persist Tier 2 maximum fallback interval (env: VIDEO_CONTEXT_MAX_INTERVAL_SEC).'),
      max_frames: z
        .number()
        .int()
        .min(9)
        .max(450)
        .optional()
        .describe('Persist Tier 2 max frames cap (env: VIDEO_CONTEXT_MAX_FRAMES).'),
      clip_interval_sec: z
        .number()
        .min(0.1)
        .max(10)
        .optional()
        .describe('Persist Tier 3 default clip interval (env: VIDEO_CONTEXT_CLIP_INTERVAL_SEC).'),
      clip_max_span_sec: z
        .number()
        .min(10)
        .max(600)
        .optional()
        .describe('Persist Tier 3 max allowed clip span (env: VIDEO_CONTEXT_CLIP_MAX_SPAN_SEC).'),
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

  // Tool 3: video_inspect (Tier 1)
  server.tool(
    'video_inspect',
    'Tier 1 fast probe (~1-3s, zero video stream download): fetch metadata, chapters, cleaned timestamped transcript.md, and official progress-bar sprite sheets.',
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
      allow_guest_degraded: z
        .boolean()
        .optional()
        .describe('Override allow_guest_degraded for this request.'),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe('Force re-fetching metadata and subtitles even if cached.'),
    },
    async (args) => {
      try {
        const res = await inspectVideo(args);
        return formatToolResponse(res);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  // Tool 4: video_extract_grids (Tier 2)
  server.tool(
    'video_extract_grids',
    'Tier 2 global visual extraction: cache 480p/720p video-only stream locally, fuse scene changes + subtitle anchors + fallback with debounce, and compose zero-occlusion timestamped grids.',
    {
      url_or_id: z
        .string()
        .describe('Deterministic YouTube/Bilibili URL, BV ID, or YouTube Video ID.'),
      part: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('1-indexed part number for multi-part Bilibili videos.'),
      output_dir: z
        .string()
        .optional()
        .describe('Optional custom root output directory override for this request.'),
      scene_threshold: z
        .number()
        .min(0.05)
        .max(0.95)
        .optional()
        .describe('Override FFmpeg scene change threshold (defaults to config.yaml / env).'),
      min_interval_sec: z
        .number()
        .min(0.2)
        .optional()
        .describe('Override minimum debounce interval in seconds (defaults to config.yaml / env).'),
      max_interval_sec: z
        .number()
        .min(1.0)
        .optional()
        .describe('Override maximum fallback interval in seconds (defaults to config.yaml / env).'),
      max_frames: z
        .number()
        .int()
        .min(9)
        .max(450)
        .optional()
        .describe('Override maximum total sampled frames (defaults to config.yaml / env).'),
      allow_guest_degraded: z
        .boolean()
        .optional()
        .describe('Override allow_guest_degraded for this request.'),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe('Force regenerating grids even if frames_index.json already exists.'),
    },
    async (args) => {
      try {
        const res = await extractVideoGrids(args);
        return formatToolResponse(res);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  // Tool 5: video_extract_clip (Tier 3)
  server.tool(
    'video_extract_clip',
    'Tier 3 local microscope: extract high-density frames for a specific [start_time, end_time] window via cached stream or HTTP Range slicing.',
    {
      url_or_id: z
        .string()
        .describe('Deterministic YouTube/Bilibili URL, BV ID, or YouTube Video ID.'),
      part: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('1-indexed part number for multi-part Bilibili videos.'),
      start_time: z
        .union([z.string(), z.number()])
        .describe('Clip start time (e.g. "04:10", "01:02:15.5", or seconds 250).'),
      end_time: z
        .union([z.string(), z.number()])
        .describe('Clip end time (e.g. "04:45" or seconds 285).'),
      interval_sec: z
        .number()
        .min(0.1)
        .max(10)
        .optional()
        .describe('Override sampling interval in seconds (defaults to config.yaml / env).'),
      output_mode: z
        .enum(['grid', 'raw_frames'])
        .optional()
        .default('grid')
        .describe('"grid" for timestamped grids, or "raw_frames" for clean unwatermarked full-HD single frames.'),
      output_dir: z
        .string()
        .optional()
        .describe('Optional custom root output directory override for this request.'),
      allow_guest_degraded: z
        .boolean()
        .optional()
        .describe('Override allow_guest_degraded for this request.'),
    },
    async (args) => {
      try {
        const res = await extractVideoClip(args);
        return formatToolResponse(res);
      } catch (err) {
        return formatToolError(err);
      }
    }
  );

  // Tool 6: video_read_image
  server.tool(
    'video_read_image',
    'Return a single generated grid, sprite, or raw frame image as MCP ImageContent (for clients without direct local image file reading).',
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
