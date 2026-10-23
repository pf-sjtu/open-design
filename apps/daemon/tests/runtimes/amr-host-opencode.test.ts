import { join } from 'node:path';
import { test } from 'vitest';

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  minimalAgentDef,
  resolveAgentLaunch,
  rmSync,
  tmpdir,
  withEnvSnapshot,
  writeFileSync,
} from './helpers/test-helpers.js';

// Windows resolves executables by extension, so every fixture name has to match
// the platform the daemon will actually spawn.
const EXE = process.platform === 'win32' ? '.exe' : '';

// The OpenCode companion is ~170 MB, so a packaged build ships it only on
// request. AMR must still work when the host already has an OpenCode of its
// own (bun/pnpm global, or PATH): resolving only the bundled tree made such a
// build report AMR as unavailable even though a good runtime was installed.
test('resolveAgentLaunch accepts a host OpenCode when the payload has no companion', () => {
  const root = mkdtempSync(join(tmpdir(), 'od-launch-amr-host-opencode-'));
  try {
    return withEnvSnapshot(
      ['PATH', 'OD_AGENT_HOME', 'OD_RESOURCE_ROOT', 'VELA_OPENCODE_BIN', 'VELA_BIN'],
      () => {
        const resourceRoot = join(root, 'resources', 'open-design');
        const builtInDir = join(resourceRoot, 'bin');
        const builtInVela = join(builtInDir, `vela${EXE}`);
        const hostBinDir = join(root, 'host-bin');
        mkdirSync(builtInDir, { recursive: true });
        mkdirSync(hostBinDir, { recursive: true });
        writeFileSync(builtInVela, '#!/bin/sh\nexit 0\n');
        chmodSync(builtInVela, 0o755);
        const hostOpenCode = join(hostBinDir, `opencode${EXE}`);
        writeFileSync(hostOpenCode, '#!/bin/sh\nexit 0\n');
        chmodSync(hostOpenCode, 0o755);

        process.env.PATH = hostBinDir;
        process.env.OD_AGENT_HOME = join(root, 'empty-home');
        process.env.OD_RESOURCE_ROOT = resourceRoot;
        delete process.env.VELA_OPENCODE_BIN;
        delete process.env.VELA_BIN;

        const launch = resolveAgentLaunch(minimalAgentDef({ id: 'amr', bin: 'vela' }));

        if (launch.selectedPath !== builtInVela) {
          throw new Error(`expected built-in Vela ${builtInVela}, got ${String(launch.selectedPath)}`);
        }
        if (launch.launchKind !== 'selected') {
          throw new Error(`expected launchKind=selected, got ${launch.launchKind}`);
        }
        if (launch.diagnostic != null) {
          throw new Error(`expected no diagnostic, got ${JSON.stringify(launch.diagnostic)}`);
        }
        return undefined;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Without any OpenCode anywhere, AMR must stay unavailable rather than resolve
// to a Vela that cannot start a run.
test('resolveAgentLaunch keeps AMR unavailable when no OpenCode exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'od-launch-amr-no-opencode-'));
  try {
    return withEnvSnapshot(
      ['PATH', 'OD_AGENT_HOME', 'OD_RESOURCE_ROOT', 'VELA_OPENCODE_BIN', 'VELA_BIN'],
      () => {
        const resourceRoot = join(root, 'resources', 'open-design');
        const builtInDir = join(resourceRoot, 'bin');
        const builtInVela = join(builtInDir, `vela${EXE}`);
        const emptyBinDir = join(root, 'empty-bin');
        mkdirSync(builtInDir, { recursive: true });
        mkdirSync(emptyBinDir, { recursive: true });
        writeFileSync(builtInVela, '#!/bin/sh\nexit 0\n');
        chmodSync(builtInVela, 0o755);

        process.env.PATH = emptyBinDir;
        process.env.OD_AGENT_HOME = join(root, 'empty-home');
        process.env.OD_RESOURCE_ROOT = resourceRoot;
        delete process.env.VELA_OPENCODE_BIN;
        delete process.env.VELA_BIN;

        const launch = resolveAgentLaunch(minimalAgentDef({ id: 'amr', bin: 'vela' }));

        if (launch.selectedPath != null) {
          throw new Error(`expected no AMR selection, got ${String(launch.selectedPath)}`);
        }
        return undefined;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
