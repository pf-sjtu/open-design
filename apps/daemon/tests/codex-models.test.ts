import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { codexAgentDef, parseCodexDebugModels } from '../src/runtimes/defs/codex.js';

// Captured from `codex debug models` on codex-cli 0.163.0 (fields trimmed to the
// ones the parser reads).
const liveCatalogue = readFileSync(
  fileURLToPath(new URL('./fixtures/codex-models-0.163.0.json', import.meta.url)),
  'utf8',
);

describe('parseCodexDebugModels', () => {
  it('keeps the listed models and drops the hide-visibility ones', () => {
    const models = parseCodexDebugModels(liveCatalogue);
    expect(models).not.toBeNull();

    const ids = models?.map((model) => model.id) ?? [];
    expect(ids).toContain('gpt-6-astra');
    expect(ids).toContain('gpt-6.1-sol');
    expect(ids).toContain('gpt-5.6-luna');
    // `visibility: "hide"` models must not reach the picker.
    expect(ids).not.toContain('gpt-daybreak-blue-latest');
    expect(ids).not.toContain('codex-auto-review');
  });

  it('carries the speed tier through to service tier options', () => {
    const models = parseCodexDebugModels(liveCatalogue);
    const astra = models?.find((model) => model.id === 'gpt-6-astra');
    expect(astra?.label).toBe('GPT-6-Astra');
    expect(astra?.serviceTierOptions?.map((tier) => tier.id)).toContain('priority');
  });
});

describe('codex static fallback catalogue', () => {
  it('matches the models the installed CLI actually lists', () => {
    const liveIds = (parseCodexDebugModels(liveCatalogue) ?? [])
      .map((model) => model.id)
      .filter((id) => id !== 'default');
    const fallbackIds = codexAgentDef.fallbackModels
      .map((model) => model.id)
      .filter((id) => id !== 'default');

    // Every live model is representable offline; no stale 5.x/o-series leftovers.
    for (const id of liveIds) expect(fallbackIds).toContain(id);
    expect(fallbackIds).not.toContain('o4-mini');
    expect(fallbackIds).not.toContain('gpt-5-codex');
  });

  it('offers the reasoning efforts the live catalogue reports', () => {
    const efforts = codexAgentDef.reasoningOptions.map((option) => option.id);
    expect(efforts).toContain('xhigh');
    expect(efforts).toContain('max');
    expect(efforts).toContain('ultra');
  });

  it('still detects the catalogue from the CLI', () => {
    expect(codexAgentDef.listModels?.args).toEqual(['debug', 'models']);
  });
});
