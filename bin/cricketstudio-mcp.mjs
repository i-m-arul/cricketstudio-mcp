#!/usr/bin/env node
/**
 * Launcher for the CricketStudio MCP server.
 *
 * The server is TypeScript (src/server.ts). Rather than rely on Node's
 * native type-stripping (only on Node >=22.18), we register tsx's ESM
 * loader first, then import the server in the SAME process — so a single
 * `npx github:i-m-arul/cricketstudio-mcp` works on any Node >=20 and keeps
 * the stdio transport intact (no child process).
 */
import { register } from 'tsx/esm/api';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

register();
const server = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts');
await import(pathToFileURL(server).href);
