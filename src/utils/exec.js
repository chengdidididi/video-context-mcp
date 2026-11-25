import { spawn } from 'node:child_process';
import { getEnhancedEnv, getTimeoutMs } from '../config.js';

/**
 * Execute an external binary safely with argument array, unified timeout budget, and external AbortSignal propagation.
 */
export function runCommand(binary, args = [], options = {}) {
  const { cwd, timeoutMs = getTimeoutMs(), env, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error(`Command aborted before start: ${binary}`));
      return;
    }

    const child = spawn(binary, args, {
      cwd,
      env: env || getEnhancedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    let abortedExternally = false;

    const onExternalAbort = () => {
      abortedExternally = true;
      child.kill('SIGKILL');
    };

    if (signal) {
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (abortedExternally) {
        reject(signal?.reason || new Error(`Command interrupted by pipeline abort: ${binary}`));
        return;
      }

      if (timedOut) {
        reject(
          new Error(
            `Subprocess timed out after ${Math.round(timeoutMs / 1000)}s: ${binary} ${args.slice(0, 5).join(' ')}`
          )
        );
        return;
      }

      if (code !== 0 && !options.allowNonZero) {
        const snippet = (stderr || stdout).trim().slice(-1200);
        const err = new Error(
          `Command failed (exit ${code}): ${binary} ${args.slice(0, 6).join(' ')}\n${snippet}`
        );
        err.exitCode = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }

      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Run async tasks with bounded concurrency (stops scheduling new items immediately if `signal` aborts).
 */
export async function mapWithConcurrency(items, concurrency, mapper, signal = null) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason || new Error('Concurrent batch aborted');
      }
      const idx = nextIndex++;
      if (idx >= items.length) break;
      results[idx] = await mapper(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
