import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEFAULT_MODEL_OPTION } from './shared.js';
import { agentCapabilities } from '../capabilities.js';
import type { RuntimeAgentDef } from '../types.js';

const ANTIGRAVITY_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

// Headless runs use agy's documented stdin channel (agy >= 1.1.15):
//   agy --input-format stream-json --output-format stream-json
// with the prompt written to stdin as one NDJSON `user` message. The prompt
// must never ride argv: on Windows the composed OD prompt routinely exceeds
// CreateProcess's 32_767-char command line and the spawn dies with
// `ENAMETOOLONG` before agy starts (OPEND-3495). And agy has no other way to
// read stdin — with `-p <text>` it ignores stdin entirely (agy 1.1.1: "no
// longer reading stdin when a prompt is provided via a flag"), while `-p -`
// is the literal prompt "-" (#7161). Every stream-json message runs one turn;
// the daemon hands the frame over as a complete file-backed stdin, so agy
// sees EOF after it and ends the session once the turn finishes.
const ANTIGRAVITY_STREAM_JSON_ARGS = [
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
] as const;

export function encodeAntigravityStdinPrompt(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

// `agy` v1.0.3 still has no `--model` flag (upstream issue #35), but the
// TUI's Switch-Model picker writes the choice to its settings.json, and
// every headless `agy` invocation re-reads that file on startup — verified by
// capturing the `--log-file` line `Propagating selected model override to
// backend: label="<model>"`. So we can route OD's model picker through
// settings.json: when the user picks a concrete model in Settings, the
// daemon writes the label into agy's settings.json right before spawn,
// and the resulting headless run uses that model.
//
// Two ids the picker exposes are special:
//   - 'default'         : leave settings.json untouched, so agy keeps
//                         whatever the user last picked in its own TUI.
//                         (Respects user choice when they switch models
//                         from `agy` directly.)
//   - any other id      : the literal display label agy expects (e.g.
//                         "Gemini 3.1 Pro (High)", "Claude Sonnet 4.6
//                         (Thinking)"). We persist it before spawn.
//
// `supportsCustomModel: true` now that agy exposes `--model` (>= 1.4): a typed
// id rides the spawn instead of a global settings.json write, and the daemon
// only accepts ids that are either in the live `agy models` catalogue or
// syntactically valid custom ids (`sanitizeCustomModel`).
//
// The model catalogue used to be a hardcoded list mirrored from the TUI
// (`agy` 1.0.x had no way to enumerate it), which is why it drifted out of date
// — by 1.4.4 the shipped labels named models the account no longer had. agy now
// has `agy models`, so `listModels` below reads the live catalogue and
// `ANTIGRAVITY_FALLBACK_MODELS` is only the offline hint.
const ANTIGRAVITY_SETTINGS_PATH = join(
  homedir(),
  '.gemini',
  'antigravity-cli',
  'settings.json',
);

// `agy models` (agy >= 1.4) prints one `id<TAB>Display Label` row per model
// after a `Fetching available models...` preamble. The ids are what `--model`
// takes; the labels are what the TUI picker and the legacy settings.json path
// expect.
export function parseAntigravityModels(
  stdout: string,
): Array<{ id: string; label: string }> | null {
  const rows: Array<{ id: string; label: string }> = [];
  const seen = new Set<string>();
  for (const rawLine of String(stdout ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/u, '').trimEnd();
    if (line.trim().length === 0) continue;
    if (/^fetching available models/i.test(line.trim())) continue;
    const tabIndex = line.indexOf('\t');
    if (tabIndex <= 0) continue;
    const id = line.slice(0, tabIndex).trim();
    const label = line.slice(tabIndex + 1).trim() || id;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, label });
  }
  return rows.length > 0 ? rows : null;
}

// id -> display label for the models the current CLI reported. Legacy agy
// builds (no `--model` flag) need the label in settings.json, but the picker
// may have handed us an id from the live list.
const antigravityModelLabels = new Map<string, string>();

export function rememberAntigravityModelLabels(
  models: ReadonlyArray<{ id: string; label: string }>,
): void {
  for (const model of models) antigravityModelLabels.set(model.id, model.label);
}

export function resolveAntigravityModelLabel(
  model: string,
  fallbackModels: ReadonlyArray<{ id: string; label: string }> = [],
): string {
  const remembered = antigravityModelLabels.get(model);
  if (remembered != null) return remembered;
  const fallback = fallbackModels.find((option) => option.id === model);
  return fallback?.label ?? model;
}

export function writeAntigravityModelSelection(
  label: string,
  settingsPath: string = ANTIGRAVITY_SETTINGS_PATH,
): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt JSON — fall through and rewrite the file from scratch so
      // the next spawn starts from a known-good state.
    }
  }
  existing.model = label;
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

// Per-process serialization for write-settings → spawn → agy-reads
// cycles on antigravity. `~/.gemini/antigravity-cli/settings.json` is
// process-global, so two OD runs that both pick concrete (non-default)
// models can race: run A writes model A, spawn A starts, run B writes
// model B before A's agy has read settings.json — A then executes on
// model B. The daemon serialises non-default antigravity spawns
// through this chain: each acquire awaits the previous release, and
// each release fires only after the spawned agy actually emits
// `Propagating selected model override to backend: label="<X>"` in
// its `--log-file` (which is the upstream signal that settings.json
// has been read).
let antigravityLockChain: Promise<void> = Promise.resolve();

export async function acquireAntigravityModelLock(): Promise<() => void> {
  const previous = antigravityLockChain;
  let release: () => void = () => {};
  antigravityLockChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

// Visible for tests. Resets the module-level lock chain so a test that
// installed a hanging acquirer can release it without leaking state to
// subsequent test cases. Production code never calls this.
export function _resetAntigravityModelLockForTests(): void {
  antigravityLockChain = Promise.resolve();
}

export interface WaitForAgyModelOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  // Override for tests; production reads the daemon-owned log file path.
  readFile?: (path: string) => Promise<string>;
  // Override `Date.now` for tests; production uses the wall clock.
  now?: () => number;
  // Stops polling when fired. Production wires this to `child.once('exit')`
  // so the watcher cancels as soon as agy exits — the lock release is
  // then driven by the exit handler rather than the helper's return
  // value, eliminating the slow-startup race the looper review at
  // 263fd2fe7 flagged: if a cold agy takes >timeoutMs to read its
  // settings.json, we'd otherwise return false, the caller would
  // release the lock, and a concurrent run B could rewrite
  // settings.json before A's agy actually read it.
  abortSignal?: AbortSignal;
}

// Polls agy's `--log-file` for the line
//   `Propagating selected model override to backend: label="<expectedModel>"`
// which `model_config_manager.go` emits once agy has finished reading
// `~/.gemini/antigravity-cli/settings.json` and sent the model
// override to the upstream backend. Returns true on observed signal,
// false on timeout OR abort. Never throws — a missing log file is
// treated as "not yet seen" so the polling loop keeps retrying until
// either the deadline or the abort signal fires.
//
// IMPORTANT: callers MUST NOT use a `false` return as a "go ahead and
// release the settings.json lock" signal — false means "I gave up
// polling," not "agy definitely didn't read this." Release the lock
// only on (a) a `true` return, OR (b) child exit. See server.ts for
// the wiring.
export async function waitForAgyToReadModel(
  logFilePath: string,
  expectedModel: string,
  options: WaitForAgyModelOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const readFile =
    options.readFile ?? ((path: string) => fsReadFile(path, 'utf8'));
  const now = options.now ?? Date.now;
  const abortSignal = options.abortSignal;
  if (abortSignal?.aborted) return false;
  const escaped = expectedModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `Propagating selected model override to backend: label="${escaped}"`,
  );
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (abortSignal?.aborted) return false;
    try {
      const content = await readFile(logFilePath);
      if (pattern.test(content)) return true;
    } catch {
      // Log file may not have appeared yet; keep polling.
    }
    if (now() >= deadline) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  return false;
}

// The 13 model labels below mirror `agy models` for consumer-tier accounts as
// of 2026-10-23 (agy 1.4.4). They are only a fallback: `listModels` runs
// `agy models` and the picker uses that live list whenever the CLI answers.
const ANTIGRAVITY_FALLBACK_MODELS = [
  { id: 'Gemini 4 Argon (Medium)', label: 'Gemini 4 Argon (Medium)' },
  { id: 'Gemini 4 Argon (High)', label: 'Gemini 4 Argon (High)' },
  { id: 'Gemini 4 Argon (Low)', label: 'Gemini 4 Argon (Low)' },
  { id: 'Gemini 3.8 Flash (High)', label: 'Gemini 3.8 Flash (High)' },
  { id: 'Gemini 3.8 Flash (Medium)', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'Gemini 3.8 Flash (Low)', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'Claude Opus 5.5 (High)', label: 'Claude Opus 5.5 (High)' },
  { id: 'Claude Opus 5.5 (Medium)', label: 'Claude Opus 5.5 (Medium)' },
  { id: 'Claude Opus 5.5 (Low)', label: 'Claude Opus 5.5 (Low)' },
  { id: 'Claude Sonnet 5.5 (High)', label: 'Claude Sonnet 5.5 (High)' },
  { id: 'Claude Sonnet 5.5 (Medium)', label: 'Claude Sonnet 5.5 (Medium)' },
  { id: 'Claude Sonnet 5.5 (Low)', label: 'Claude Sonnet 5.5 (Low)' },
  { id: 'GPT-OSS 120B (Medium)', label: 'GPT-OSS 120B (Medium)' },
] as const;

export const antigravityAgentDef = {
  id: 'antigravity',
  name: 'Antigravity',
  bin: 'agy',
  versionArgs: ['--version'],
  helpArgs: ['--help'],
  capabilityFlags: {
    [ANTIGRAVITY_SKIP_PERMISSIONS_FLAG]: 'skipPermissions',
    // agy >= 1.4 accepts `--model <id>` (upstream issue #35 is fixed). Prefer it
    // over the settings.json write: it is per-spawn, so concurrent runs can pick
    // different models without the global-file lock.
    '--model': 'model',
  },
  // `agy models` lists the account's live catalogue (`id<TAB>label`). Only
  // agy >= 1.4 has the subcommand; older builds fail here and fall through to
  // `fallbackModels`.
  listModels: {
    args: ['models'],
    parse: (stdout) => {
      const models = parseAntigravityModels(stdout);
      // Remember id -> label so the legacy settings.json path can still write
      // the label the TUI picker expects.
      if (models != null) rememberAntigravityModelLabels(models);
      return models;
    },
    timeoutMs: 20_000,
  },
  fallbackModels: [DEFAULT_MODEL_OPTION, ...ANTIGRAVITY_FALLBACK_MODELS],
  supportsCustomModel: true,
  // We deliberately do NOT opt into `resumesSessionViaCli` / agy's `-c`
  // resume flag on follow-up turns. Tested both shapes; `-c` activates
  // agy's internal agentic loop (multi-step model retries, tool calls,
  // fallback-to-cached-response on tool errors) which can't be steered
  // from OD's system-prompt OVERRIDE — even with the strongest wording
  // we got an identical byte-for-byte form re-emission on turn 2 when
  // turn 1's tool-call retry path returned the cached form response.
  //
  // Instead we treat agy as a stateless adapter like qwen /
  // deepseek: every spawn gets the full OD-rendered transcript via
  // `buildDaemonTranscript`, and that transcript's prior assistant
  // turns are sanitized to strip `<question-form>` markup + form-schema
  // JSON fences (see `sanitizePriorAssistantTurnForTranscript` in
  // apps/web/src/providers/daemon.ts).
  buildArgs: (
    _prompt,
    _imagePaths,
    _extra = [],
    options = {},
    runtimeContext = {},
  ) => {
    const explicitModel =
      options.model && options.model !== DEFAULT_MODEL_OPTION.id
        ? options.model
        : null;
    const args: string[] = [];
    // Always opt into `--log-file` when the daemon supplied a path: the model
    // lock in server.ts waits for agy to log the settings.json model override
    // there, and the connection test folds its tail into auth / quota
    // classification.
    //
    // Flag order is load-bearing on agy: put `--log-file` first so
    // diagnostics (model override / auth / quota) land in the log.
    if (runtimeContext.agentLogFilePath) {
      args.push('--log-file', runtimeContext.agentLogFilePath);
    }
    // Modern agy routes the model per spawn; legacy builds only read it from
    // the global settings.json, which the daemon rewrites before each run.
    if (explicitModel != null) {
      if (agentCapabilities.get('antigravity')?.model) {
        args.push('--model', explicitModel);
      } else {
        writeAntigravityModelSelection(
          resolveAntigravityModelLabel(explicitModel, ANTIGRAVITY_FALLBACK_MODELS),
          runtimeContext.antigravitySettingsPath,
        );
      }
    }
    // Daemon-managed headless runs have no interactive approval channel.
    if (agentCapabilities.get('antigravity')?.skipPermissions) {
      args.push(ANTIGRAVITY_SKIP_PERMISSIONS_FLAG);
    }
    args.push(...ANTIGRAVITY_STREAM_JSON_ARGS);
    return args;
  },
  promptViaStdin: true,
  encodeStdinPrompt: encodeAntigravityStdinPrompt,
  streamFormat: 'json-event-stream',
  eventParser: 'antigravity',
  installUrl: 'https://antigravity.google/cli',
  docsUrl: 'https://antigravity.google/docs/cli-overview',
} satisfies RuntimeAgentDef;
