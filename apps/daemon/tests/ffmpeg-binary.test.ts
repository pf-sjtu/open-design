import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveFfmpegPath, setFfmpegInstallerLoaderForTests } from '../src/media/ffmpeg-binary.js';

afterEach(() => {
  setFfmpegInstallerLoaderForTests(undefined);
});

describe('resolveFfmpegPath', () => {
  it('prefers OD_FFMPEG_BIN over the historical daemon knob', () => {
    setFfmpegInstallerLoaderForTests(() => '/installer/ffmpeg');
    expect(resolveFfmpegPath({
      OD_FFMPEG_BIN: '/explicit/ffmpeg.exe',
      HYPERFRAMES_FFMPEG_PATH: '/hyperframes/ffmpeg.exe',
    })).toBe('/explicit/ffmpeg.exe');
  });

  it('falls back to HYPERFRAMES_FFMPEG_PATH when OD_FFMPEG_BIN is unset', () => {
    setFfmpegInstallerLoaderForTests(() => '/installer/ffmpeg');
    expect(resolveFfmpegPath({ HYPERFRAMES_FFMPEG_PATH: '/hyperframes/ffmpeg.exe' }))
      .toBe('/hyperframes/ffmpeg.exe');
  });

  it('uses the installed @ffmpeg-installer binary when the environment is silent', () => {
    setFfmpegInstallerLoaderForTests(() => '/installer/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe');
    expect(resolveFfmpegPath({})).toBe('/installer/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe');
  });

  // This is the Windows ARM64 path: the installer package throws at require time
  // ("Unsupported platform/architecture: win32-arm64"), so resolution must fall
  // through to PATH instead of crashing the daemon.
  it('falls back to PATH ffmpeg when the installer cannot resolve this platform', () => {
    setFfmpegInstallerLoaderForTests(() => null);
    expect(resolveFfmpegPath({})).toBe('ffmpeg');
  });

  it('ignores blank overrides', () => {
    setFfmpegInstallerLoaderForTests(() => null);
    expect(resolveFfmpegPath({ OD_FFMPEG_BIN: '   ', HYPERFRAMES_FFMPEG_PATH: '' })).toBe('ffmpeg');
  });

  it('executes the host arm64 ffmpeg when OD_FFMPEG_BIN points at it', () => {
    const hostFfmpeg = process.env.OD_TEST_ARM64_FFMPEG ?? 'C:/green_tools/ffmpeg/bin/ffmpeg.exe';
    if (!existsSync(hostFfmpeg)) return;

    setFfmpegInstallerLoaderForTests(() => null);
    const resolved = resolveFfmpegPath({ OD_FFMPEG_BIN: hostFfmpeg });
    expect(resolved).toBe(hostFfmpeg);

    const version = execFileSync(resolved, ['-version'], { encoding: 'utf8', timeout: 20_000 });
    expect(version).toContain('ffmpeg version');
  });
});
