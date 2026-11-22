#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { setRuntimeOutputDir } from '../src/config.js';
import { startStdioMcpServer } from '../src/mcp-server.js';

const { values } = parseArgs({
  strict: false,
  options: {
    'output-dir': { type: 'string', short: 'o' },
  },
});

if (typeof values['output-dir'] === 'string') {
  setRuntimeOutputDir(values['output-dir']);
}

startStdioMcpServer().catch((err) => {
  console.error('[video-context-mcp] Fatal startup error:', err);
  process.exit(1);
});
