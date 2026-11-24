import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AsrConfigRequiredError } from './asr/index.js';
import {
  extractVideo,
  getAuthStatus,
  manageConfig,
} from './pipeline.js';
import { AuthRequiredError } from './platforms/auth.js';

const SERVER_INSTRUCTIONS = `
Video Context MCP packages deterministic YouTube/Bilibili videos or local video files into a local Context Bundle in one call.
- Pass only deterministic URLs, BV IDs, av IDs, 11-char YouTube Video IDs, or existing local video file paths to video_extract (never fuzzy titles).
- Outputs a unified transcript.md (containing metadata, description, chapters, and cleaned [MM:SS] transcript) and grids/ (Two-Gate settled 3x3 visual grids with zero-occlusion "#FrameNo | Timestamp" top bars), returning their local file paths.
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
  let payload;
  if (err instanceof AuthRequiredError) {
    payload = {
      error: true,
      code: err.code,
      message: err.message,
      auth_details: err.details,
    };
  } else if (err instanceof AsrConfigRequiredError) {
    payload = {
      error: true,
      code: err.code,
      message: err.message,
      asr_details: err.details,
    };
  } else {
    payload = {
      error: true,
      code: 'EXECUTION_ERROR',
      message: err?.message || String(err),
    };
  }

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
      version: '2.3.0',
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  // Tool 1: video_extract (Zero audio/ASR options exposed to AI)
  server.tool(
    'video_extract',
    'One-shot video context extraction: accepts a deterministic YouTube/Bilibili URL/ID or a local video file path, writes cleaned transcript into transcript.md, runs single-pass Two-Gate visual sampling to compose 3x3 timestamped grids (8px gutter), auto-cleans temporary cache, and returns local file paths.',
    {
      url_or_id: z
        .string()
        .describe(
          'Deterministic YouTube/Bilibili URL, BV ID (e.g. BV1xx...), av ID, 11-char YouTube ID, or local video file path.'
        ),
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
              () => sendHeartbeat('Processing media stream, transcript & visual grids...'),
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

  // Tool 2: video_auth_status (Includes redacted read-only ASR readiness line)
  server.tool(
    'video_auth_status',
    'Check yt-dlp/ffmpeg binary availability, active output directory, active env overrides, redacted ASR readiness, and live Bilibili login status.',
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

  // Tool 3: video_config (Zero audio/ASR options exposed to AI)
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
    'Return a single generated grid image as MCP ImageContent (for clients without direct local image file reading).',
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
