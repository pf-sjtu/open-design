import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Local-first dependency resolution.
 *
 * Every binary the packaging pipeline would otherwise download can be supplied
 * by the environment first: when the env var resolves to a usable local path we
 * use it and skip the download/install step, otherwise callers fall back to the
 * upstream behaviour (electron-builder download, `@electron/rebuild`
 * prebuild-install, bundled `@ffmpeg-installer` binary, ...).
 *
 * Resolution never throws for an unset variable — unset simply means "no local
 * override". A *set* variable that points at nothing is a hard error so a typo
 * can never silently turn into a download.
 */

export const LOCAL_ELECTRON_DIST_ENV = "OD_ELECTRON_DIST";
export const LOCAL_BETTER_SQLITE3_PREBUILD_ENV = "OD_BETTER_SQLITE3_PREBUILD";
export const LOCAL_FFMPEG_BIN_ENV = "OD_FFMPEG_BIN";
export const HYPERFRAMES_FFMPEG_PATH_ENV = "HYPERFRAMES_FFMPEG_PATH";

export type LocalDependencyEnv = Record<string, string | undefined>;

export type LocalDependencyKind = "electron-dist" | "better-sqlite3-prebuild" | "ffmpeg";

export type LocalDependencyResolution = {
  env: string;
  kind: LocalDependencyKind;
  path: string | null;
  /** Where the value came from, for build logs and the docs table. */
  source: "env" | "path" | "unset";
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function trimmed(env: LocalDependencyEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value != null && value.length > 0 ? value : null;
}

function requireLocalFile(env: LocalDependencyEnv, name: string, value: string): string {
  if (!isFile(value)) {
    throw new Error(`${name} must point at an existing file: ${value}`);
  }
  return value;
}

function electronExecutableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "electron.exe" : "electron";
}

function ffmpegExecutableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

/**
 * Directory holding an already extracted Electron distribution (`electron.exe`
 * + `resources/`). Mirrors electron-builder's `electronDist` option, so setting
 * this skips electron-builder's own Electron download entirely.
 */
export function resolveLocalElectronDist(
  env: LocalDependencyEnv,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const configured = trimmed(env, LOCAL_ELECTRON_DIST_ENV);
  if (configured == null) return null;
  const executable = join(configured, electronExecutableName(platform));
  if (!isFile(executable)) {
    throw new Error(`${LOCAL_ELECTRON_DIST_ENV} must contain ${electronExecutableName(platform)}: ${configured}`);
  }
  return configured;
}

/**
 * A `better_sqlite3.node` already built for the target Electron ABI. When set,
 * packaging copies it into `node_modules/better-sqlite3/build/Release` instead
 * of running `@electron/rebuild` (and therefore its prebuild-install download).
 */
export function resolveLocalBetterSqlite3Prebuild(
  env: LocalDependencyEnv,
  arch: "arm64" | "x64",
): string | null {
  const configured = trimmed(env, LOCAL_BETTER_SQLITE3_PREBUILD_ENV);
  if (configured == null) return null;
  const path = requireLocalFile(env, LOCAL_BETTER_SQLITE3_PREBUILD_ENV, configured);
  // A Windows ARM64 build must never pick up an x64 addon by accident.
  if (arch === "arm64" && /(?:^|[\\/])win32-x64(?:[\\/]|$)/iu.test(path)) {
    throw new Error(`${LOCAL_BETTER_SQLITE3_PREBUILD_ENV} looks like an x64 prebuild but the target arch is arm64: ${path}`);
  }
  return path;
}

/**
 * FFmpeg executable to use instead of the bundled `@ffmpeg-installer` binary.
 * `OD_FFMPEG_BIN` wins over the daemon's historical `HYPERFRAMES_FFMPEG_PATH`;
 * both win over whatever is on `PATH`.
 */
export function resolveLocalFfmpegBin(
  env: LocalDependencyEnv,
  platform: NodeJS.Platform = process.platform,
): LocalDependencyResolution {
  const explicit = trimmed(env, LOCAL_FFMPEG_BIN_ENV);
  if (explicit != null) {
    return { env: LOCAL_FFMPEG_BIN_ENV, kind: "ffmpeg", path: requireLocalFile(env, LOCAL_FFMPEG_BIN_ENV, explicit), source: "env" };
  }
  const hyperframes = trimmed(env, HYPERFRAMES_FFMPEG_PATH_ENV);
  if (hyperframes != null) {
    return {
      env: HYPERFRAMES_FFMPEG_PATH_ENV,
      kind: "ffmpeg",
      path: requireLocalFile(env, HYPERFRAMES_FFMPEG_PATH_ENV, hyperframes),
      source: "env",
    };
  }
  const onPath = findOnPath(env, ffmpegExecutableName(platform));
  return {
    env: "PATH",
    kind: "ffmpeg",
    path: onPath,
    source: onPath == null ? "unset" : "path",
  };
}

export function findOnPath(env: LocalDependencyEnv, executableName: string): string | null {
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const entry of pathValue.split(delimiter)) {
    if (entry.trim().length === 0) continue;
    const candidate = join(entry, executableName);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** Snapshot for build logs: what was taken from the environment, what was not. */
export function describeLocalDependencies(
  env: LocalDependencyEnv,
  options: { arch: "arm64" | "x64"; platform?: NodeJS.Platform },
): LocalDependencyResolution[] {
  const platform = options.platform ?? process.platform;
  const electronDist = resolveLocalElectronDist(env, platform);
  const sqlitePrebuild = resolveLocalBetterSqlite3Prebuild(env, options.arch);
  return [
    {
      env: LOCAL_ELECTRON_DIST_ENV,
      kind: "electron-dist",
      path: electronDist,
      source: electronDist == null ? "unset" : "env",
    },
    {
      env: LOCAL_BETTER_SQLITE3_PREBUILD_ENV,
      kind: "better-sqlite3-prebuild",
      path: sqlitePrebuild,
      source: sqlitePrebuild == null ? "unset" : "env",
    },
    resolveLocalFfmpegBin(env, platform),
  ];
}
