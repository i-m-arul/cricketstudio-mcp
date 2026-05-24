#!/usr/bin/env node
/**
 * Launcher for the CricketStudio MCP server.
 *
 * The server is TypeScript (src/server.ts). We run it through the bundled
 * tsx CLI as a child process with inherited stdio — the same path as
 * `npx tsx src/server.ts` — so a single `npx github:i-m-arul/cricketstudio-mcp`
 * works on any Node >=20 without relying on native type-stripping. (An
 * in-process tsx loader globally intercepts module loads and breaks a
 * dependency's oddly-named .json, so a child process is the safe route.)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = resolve(root, 'src', 'server.ts');

let tsxCli;
try {
  tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
} catch {
  tsxCli = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
}

const child = spawn(process.execPath, [tsxCli, server], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
