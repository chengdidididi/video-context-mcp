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
Video Context MCP packages deterministic YouTube and Bilibili video URLs/BV IDs into a local Context Bundle in one call.
Workflow:
1. Pass only deterministic URLs, BV IDs, av IDs, or 11-char YouTube Video IDs to video_extract (never fuzzy titles).
2. Once video_extract returns, read ALL core outputs together (batching parallel read calls as needed): paths.transcript (if non-null), EVERY image in paths.grid_files, and EVERY image in paths.sprite_files.
3. Do NOT skip or guess-filter any grid or sprite image — always load the complete transcript, all grids, and all sprites so silent visuals, burned-in text, and post-credits scenes are never missed.
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
      version: '2.1.1',
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // Tool 1: video_extract (Unified One-Shot Pipeline with smart defaults & 5s progress heartbeats)
  server.tool(
    'video_extract',
    'One-shot video context extraction (300s timeout + progress heartbeats): fetches cleaned transcript, chapters, sprite sheets, and settled 3x3 timestamped visual grids, auto-cleans temporary video cache, and returns all local file paths to read together.',
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
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe('Force re-extraction even if completed bundle already exists in output.'),
    },
    async (args, extra) => {
      const progressToken = extra?._meta?.progressToken;
      let tick = 0;
      const sendHeartbeat = (message) => {
        if (progressToken === undefined || typeof extra?.sendNotification !== 'function') return;
        tick += 1;
        extra
          .sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: Math.min(95, tick * 5),
              total: 100,
              message,
            },
          })
          .catch(() => {});
      };

      sendHeartbeat('Starting video extraction...');
      const heartbeatTimer =
        progressToken !== undefined
          ? setInterval(
              () => sendHeartbeat('Downloading compact video stream & composing visual grids...'),
              5_000
            )
          : null;
      if (heartbeatTimer?.unref) heartbeatTimer.unref();

      try {
        const res = await extractVideo(args);
        if (progressToken !== undefined && typeof extra?.sendNotification === 'function') {
          extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: 100, total: 100, message: 'Completed' },
            })
            .catch(() => {});
        }
        return formatToolResponse(res);
      } catch (err) {
        return formatToolError(err);
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
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
    'Read current effective settings (and environment variable mapping) or persist common setting updates into config.yaml.',
    {
      output_dir: z.string().optional().describe('Persist default output directory (env: VIDEO_CONTEXT_OUTPUT_DIR).'),
      keep_video_cache: z
        .boolean()
        .optional()
        .describe('Keep temporary downloaded video stream in cache/ after grid extraction (default false; env: VIDEO_CONTEXT_KEEP_VIDEO_CACHE).'),
      timeout_sec: z
        .number()
        .int()
        .min(15)
        .max(1800)
        .optional()
        .describe('Persist execution timeout in seconds (default 300; env: VIDEO_CONTEXT_TIMEOUT_SEC).'),
      bilibili_cookie: z
        .string()
        .optional()
        .describe('Persist Bilibili Cookie string in config.yaml (env: BILIBILI_COOKIE).'),
      allow_guest_degraded: z
        .boolean()
        .optional()
        .describe('Persist guest degraded fallback toggle (env: VIDEO_CONTEXT_ALLOW_GUEST).'),
      max_frames: z
        .number()
        .int()
        .min(9)
        .max(450)
        .optional()
        .describe('Persist max frames cap per video (default 180; env: VIDEO_CONTEXT_MAX_FRAMES).'),
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
