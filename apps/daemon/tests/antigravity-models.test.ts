import { afterEach, describe, expect, it } from 'vitest';

import {
  antigravityAgentDef,
  parseAntigravityModels,
  rememberAntigravityModelLabels,
  resolveAntigravityModelLabel,
} from '../src/runtimes/defs/antigravity.js';
import { agentCapabilities } from '../src/runtimes/capabilities.js';

// `agy models` output, verbatim from agy 1.4.4.
const AGY_MODELS_STDOUT = [
  'Fetching available models...',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  '',
].join('\r\n');

afterEach(() => {
  agentCapabilities.delete('antigravity');
});

describe('parseAntigravityModels', () => {
  it('parses the live catalogue and skips the fetch preamble', () => {
    const models = parseAntigravityModels(AGY_MODELS_STDOUT);
    expect(models).not.toBeNull();
    expect(models).toHaveLength(13);
    expect(models?.[0]).toEqual({ id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' });
    expect(models?.at(-1)).toEqual({ id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' });
  });

  it('returns null when the CLI printed no tab-separated rows', () => {
    expect(parseAntigravityModels('Fetching available models...\n')).toBeNull();
    expect(parseAntigravityModels('')).toBeNull();
  });

  it('ignores malformed ids and duplicate rows', () => {
    const models = parseAntigravityModels([
      'not a model id\tNope',
      'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
      'gemini-4-argon-medium\tDuplicate',
      'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
    ].join('\n'));
    expect(models).toEqual([
      { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
    ]);
  });
});

describe('antigravity model selection', () => {
  it('ships a fallback list that matches the current CLI catalogue', () => {
    const labels = antigravityAgentDef.fallbackModels.map((m) => m.label);
    expect(labels).toContain('Gemini 4 Argon (Medium)');
    expect(labels).toContain('Claude Sonnet 5.5 (High)');
    expect(labels).toContain('GPT-OSS 120B (Medium)');
    // The stale 3.x/4.6-era labels must be gone.
    expect(labels.some((label) => /Gemini 3\.1 Pro|Gemini 3\.5 Flash|Sonnet 4\.6|Opus 4\.6/.test(label))).toBe(false);
  });

  it('allows custom model ids now that agy exposes --model + `agy models`', () => {
    expect(antigravityAgentDef.supportsCustomModel).toBe(true);
    expect(antigravityAgentDef.listModels?.args).toEqual(['models']);
  });

  it('passes --model on builds whose --help advertises it', () => {
    agentCapabilities.set('antigravity', { model: true, skipPermissions: true });
    const args = antigravityAgentDef.buildArgs('prompt', [], [], { model: 'gemini-4-argon-high' }, {});
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-4-argon-high');
  });

  it('falls back to the settings.json write on legacy builds without --model', () => {
    agentCapabilities.set('antigravity', { model: false, skipPermissions: false });
    rememberAntigravityModelLabels([{ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' }]);
    // The write itself targets the real settings path; assert the label mapping
    // the legacy path depends on instead of touching ~/.gemini in a test.
    expect(resolveAntigravityModelLabel('gemini-4-argon-high')).toBe('Gemini 4 Argon (High)');
    expect(resolveAntigravityModelLabel('unknown-id')).toBe('unknown-id');
  });
});
