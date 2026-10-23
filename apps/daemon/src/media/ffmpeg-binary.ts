// FFmpeg binary resolution.
//
// `@ffmpeg-installer/ffmpeg` decides its platform package at require time and
// throws `Unsupported platform/architecture: win32-arm64` when there is no
// sub-package — which is exactly the Windows ARM64 case (the npm publisher has
// no `@ffmpeg-installer/win32-arm64`, even though FFmpeg itself ships official
// winarm64 builds). A static import therefore kills the daemon before any media
// work starts, so resolution is lazy and fail-open:
//
//   1. OD_FFMPEG_BIN            explicit override, wins over everything
//   2. HYPERFRAMES_FFMPEG_PATH  historical daemon knob (keep working)
//   3. @ffmpeg-installer/ffmpeg when it loads on this platform
//   4. "ffmpeg" from PATH      (Windows ARM64 with a system FFmpeg)
//
// The fallback order is what makes a packaged arm64 build usable without
// shipping an arm64 installer package: set OD_FFMPEG_BIN (or install FFmpeg on
// PATH) and media rendering still works.

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

let installerLoaderOverride: (() => string | null) | undefined;

function defaultInstallerPath(): string | null {
  try {
    const installer = nodeRequire('@ffmpeg-installer/ffmpeg') as { path?: unknown } | undefined;
    const candidate = installer?.path;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
  } catch {
    // Missing package, or the platform/architecture throw above. Callers fall
    // through to PATH.
    return null;
  }
}

export function resolveFfmpegPath(
  env: NodeJS.ProcessEnv = process.env,
  installerPath: () => string | null = installerLoaderOverride ?? defaultInstallerPath,
): string {
  const explicit = env.OD_FFMPEG_BIN?.trim() || env.HYPERFRAMES_FFMPEG_PATH?.trim();
  if (explicit != null && explicit.length > 0) return explicit;
  return installerPath() ?? 'ffmpeg';
}

/** Test seam: replace the `@ffmpeg-installer` probe (pass undefined to restore). */
export function setFfmpegInstallerLoaderForTests(loader: (() => string | null) | undefined): void {
  installerLoaderOverride = loader;
}
