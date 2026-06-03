/**
 * telemetry.ts
 *
 * Handles first-run welcome message and optional anonymous startup telemetry
 * for the @cricketstudio/mcp package.
 *
 * Rules:
 *  - All output goes to stderr. Stdout is reserved for the MCP JSON-RPC protocol.
 *  - CRICKETSTUDIO_NO_TELEMETRY=1 disables both the message and the telemetry ping.
 *  - The first-run message is printed exactly once, gated by a marker file.
 *  - The telemetry POST is fire-and-forget; any network failure is silently swallowed.
 *  - devId is sourced from CRICKETSTUDIO_DEV_ID (optional, user-supplied, no PII).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Directory that holds per-user marker files for this package. */
function markerDir(): string {
  return path.join(os.homedir(), '.cricketstudio-mcp');
}

/** Full path to the first-run marker file. */
function firstRunMarkerPath(): string {
  return path.join(markerDir(), 'first-run');
}

/** Return true if this is the first time the package has been run on this machine. */
function isFirstRun(): boolean {
  try {
    return !fs.existsSync(firstRunMarkerPath());
  } catch {
    // If we can't read the fs for any reason, treat as not-first-run to be safe.
    return false;
  }
}

/** Persist the first-run marker so subsequent starts skip the message. */
function markFirstRunDone(): void {
  try {
    fs.mkdirSync(markerDir(), { recursive: true });
    fs.writeFileSync(firstRunMarkerPath(), new Date().toISOString(), { flag: 'wx' });
  } catch {
    // Non-fatal: worst case the message shows again next time.
  }
}

/** Read package version from the nearest package.json at build time. */
function resolveVersion(): string {
  try {
    // Walk up from this file's location to find package.json.
    // Works whether running via tsx (src/) or compiled (dist/).
    const candidates = [
      new URL('../../package.json', import.meta.url),
      new URL('../package.json', import.meta.url),
    ];
    for (const candidate of candidates) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        const pkg = JSON.parse(raw) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        // Try next candidate.
      }
    }
  } catch {
    // Fall through.
  }
  return '0.0.0';
}

// ---------------------------------------------------------------------------
// First-run message
// ---------------------------------------------------------------------------

/**
 * Print the first-run welcome banner to stderr and record the marker file so
 * it only appears once.
 */
function printFirstRunMessage(version: string): void {
  // The box is 51 chars wide between the outer │ characters (49 inner chars).
  const msg = `
┌─────────────────────────────────────────────────┐
│  CricketStudio MCP v${version.padEnd(28)}│
│  29 tools · 1,307 matches · 309,992 deliveries  │
│                                                  │
│  Building something with cricket data?           │
│  Register at cricketstudio.ai/developers for     │
│  API updates and early hosted-transport access.  │
│                                                  │
│  Set CRICKETSTUDIO_NO_TELEMETRY=1 to silence.   │
└─────────────────────────────────────────────────┘
`;
  process.stderr.write(msg);
  markFirstRunDone();
}

// ---------------------------------------------------------------------------
// Anonymous telemetry
// ---------------------------------------------------------------------------

interface TelemetryPayload {
  version: string;
  nodeVersion: string;
  platform: string;
  devId?: string;
}

/**
 * Fire-and-forget POST to the telemetry endpoint.
 * Never throws; any error is silently swallowed to avoid crashing the server.
 */
async function sendTelemetry(payload: TelemetryPayload): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    // Use the built-in fetch (Node 18+). If it's not available (older Node),
    // the catch block swallows the ReferenceError gracefully.
    await fetch('https://telemetry.cricketstudio.ai/mcp/startup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Telemetry is strictly optional — swallow all errors (network down,
    // endpoint unreachable, AbortError from timeout, etc.).
  } finally {
    // Always clear the abort timer, whether fetch resolved, threw, or was aborted.
    // Without this, a network error leaves the timer alive and fires a spurious
    // abort signal against an already-settled request.
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * runStartup()
 *
 * Call once at process startup (before registering MCP tools).
 *
 * - If CRICKETSTUDIO_NO_TELEMETRY=1: exits immediately — no message, no ping.
 * - On first run: prints the welcome banner to stderr, then fires the telemetry
 *   ping in the background.
 * - On subsequent runs: only fires the telemetry ping (silent).
 */
export async function runStartup(): Promise<void> {
  // Opt-out check — a single env var disables everything.
  if (process.env.CRICKETSTUDIO_NO_TELEMETRY === '1') {
    return;
  }

  const version = resolveVersion();

  // Show the first-run banner exactly once.
  if (isFirstRun()) {
    printFirstRunMessage(version);
  }

  // Build the telemetry payload — NO PII, NO file paths.
  const payload: TelemetryPayload = {
    version,
    nodeVersion: process.version,
    platform: process.platform,
  };

  // Optional developer identifier supplied by the user themselves.
  if (process.env.CRICKETSTUDIO_DEV_ID) {
    payload.devId = process.env.CRICKETSTUDIO_DEV_ID;
  }

  // Fire-and-forget: don't await or let errors surface to the caller.
  sendTelemetry(payload).catch(() => undefined);
}
