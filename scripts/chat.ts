/**
 * chat — talk to your NanoMika agent from the terminal.
 *
 * Usage:
 *   pnpm run chat <message...>   send a message and print the reply
 *   pnpm run chat                print what arrived while no chat was open
 *
 * Sends the message through the CLI channel (Unix socket) to the wired agent.
 * Reads replies until the stream goes quiet, then exits. Anything the agent
 * sent while no chat was connected (a late reply, a scheduled task's output,
 * an approval request) is printed first, marked "[earlier]".
 *
 * Preconditions: the NanoMika host is running (`pnpm start` or `pnpm dev`)
 * and an agent group is wired to `cli/local` (the host creates one on first
 * start; see src/bootstrap.ts).
 */
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../src/config.js';

const SILENCE_MS = 2000; // exit after this much quiet time following the first reply
const TOTAL_TIMEOUT_MS = 120_000; // hard stop
const CATCH_UP_MS = 500; // with no message: how long to wait for missed messages

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function main(): void {
  const text = process.argv.slice(2).join(' ').trim();
  const catchUpOnly = text.length === 0;
  let missedCount = 0;

  const socket = net.connect(socketPath());

  socket.on('error', (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      console.error(`chat: cannot reach NanoMika host at ${socketPath()} (${e.code}).`);
      console.error('Is the host running? Start it with `pnpm start` (or `pnpm dev`) in another terminal.');
    } else {
      console.error('CLI socket error:', err);
    }
    process.exit(2);
  });

  let firstReplySeen = false;
  let silenceTimer: NodeJS.Timeout | null = null;
  let hardTimer: NodeJS.Timeout | null = null;

  function scheduleExit(): void {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      socket.end();
      process.exit(0);
    }, SILENCE_MS);
  }

  socket.on('connect', () => {
    if (catchUpOnly) {
      socket.write(JSON.stringify({ backlog: true }) + '\n');
      setTimeout(() => {
        if (missedCount === 0) console.log('(no new messages)');
        socket.end();
        process.exit(0);
      }, CATCH_UP_MS);
      return;
    }
    socket.write(JSON.stringify({ text }) + '\n');
    hardTimer = setTimeout(() => {
      if (!firstReplySeen) {
        console.error(`timeout: no reply in ${TOTAL_TIMEOUT_MS}ms`);
        socket.end();
        process.exit(3);
      }
    }, TOTAL_TIMEOUT_MS);
  });

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.text === 'string' && msg.backlog === true) {
          // Missed while no chat was open: print it, keep waiting for the reply.
          process.stdout.write(`[earlier] ${msg.text}\n`);
          missedCount++;
        } else if (typeof msg.text === 'string') {
          process.stdout.write(msg.text + '\n');
          firstReplySeen = true;
          if (hardTimer) {
            clearTimeout(hardTimer);
            hardTimer = null;
          }
          scheduleExit();
        }
      } catch {
        // Ignore non-JSON lines — forward compatibility.
      }
    }
  });

  socket.on('close', () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (hardTimer) clearTimeout(hardTimer);
    process.exit(firstReplySeen || catchUpOnly ? 0 : 3);
  });
}

main();
