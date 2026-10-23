import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LOCAL_BETTER_SQLITE3_PREBUILD_ENV,
  LOCAL_ELECTRON_DIST_ENV,
  LOCAL_FFMPEG_BIN_ENV,
  HYPERFRAMES_FFMPEG_PATH_ENV,
  describeLocalDependencies,
  resolveLocalBetterSqlite3Prebuild,
  resolveLocalElectronDist,
  resolveLocalFfmpegBin,
} from "@/local-deps.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "open-design-local-deps-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("resolveLocalElectronDist", () => {
  it("returns null when nothing is configured so electron-builder downloads as before", () => {
    expect(resolveLocalElectronDist({}, "win32")).toBeNull();
    expect(resolveLocalElectronDist({ [LOCAL_ELECTRON_DIST_ENV]: "   " }, "win32")).toBeNull();
  });

  it("accepts an extracted Electron directory", async () => {
    await writeFile(join(root, "electron.exe"), "stub", "utf8");
    expect(resolveLocalElectronDist({ [LOCAL_ELECTRON_DIST_ENV]: root }, "win32")).toBe(root);
  });

  it("rejects a configured path without the platform executable", async () => {
    expect(() => resolveLocalElectronDist({ [LOCAL_ELECTRON_DIST_ENV]: root }, "win32"))
      .toThrow(/must contain electron\.exe/);
  });
});

describe("resolveLocalBetterSqlite3Prebuild", () => {
  it("returns null when the addon is not supplied locally", () => {
    expect(resolveLocalBetterSqlite3Prebuild({}, "arm64")).toBeNull();
  });

  it("accepts an existing addon file", async () => {
    const addon = join(root, "better_sqlite3.node");
    await writeFile(addon, Buffer.alloc(16), "utf8");
    expect(resolveLocalBetterSqlite3Prebuild({ [LOCAL_BETTER_SQLITE3_PREBUILD_ENV]: addon }, "arm64")).toBe(addon);
  });

  it("refuses a missing file and an x64 addon for an arm64 target", async () => {
    expect(() => resolveLocalBetterSqlite3Prebuild({ [LOCAL_BETTER_SQLITE3_PREBUILD_ENV]: join(root, "nope.node") }, "x64"))
      .toThrow(/must point at an existing file/);

    const x64 = join(root, "prebuilds", "win32-x64", "better_sqlite3.node");
    await mkdir(join(root, "prebuilds", "win32-x64"), { recursive: true });
    await writeFile(x64, Buffer.alloc(16), "utf8");
    expect(() => resolveLocalBetterSqlite3Prebuild({ [LOCAL_BETTER_SQLITE3_PREBUILD_ENV]: x64 }, "arm64"))
      .toThrow(/looks like an x64 prebuild/);
    expect(resolveLocalBetterSqlite3Prebuild({ [LOCAL_BETTER_SQLITE3_PREBUILD_ENV]: x64 }, "x64")).toBe(x64);
  });
});

describe("resolveLocalFfmpegBin", () => {
  it("prefers OD_FFMPEG_BIN, then HYPERFRAMES_FFMPEG_PATH, then PATH", async () => {
    const explicit = join(root, "explicit-ffmpeg.exe");
    const hyperframes = join(root, "hyperframes-ffmpeg.exe");
    const onPathDir = join(root, "bin");
    await mkdir(onPathDir, { recursive: true });
    await writeFile(explicit, "stub", "utf8");
    await writeFile(hyperframes, "stub", "utf8");
    await writeFile(join(onPathDir, "ffmpeg.exe"), "stub", "utf8");

    expect(resolveLocalFfmpegBin({
      [LOCAL_FFMPEG_BIN_ENV]: explicit,
      [HYPERFRAMES_FFMPEG_PATH_ENV]: hyperframes,
      PATH: onPathDir,
    }, "win32")).toEqual({ env: LOCAL_FFMPEG_BIN_ENV, kind: "ffmpeg", path: explicit, source: "env" });

    expect(resolveLocalFfmpegBin({
      [HYPERFRAMES_FFMPEG_PATH_ENV]: hyperframes,
      PATH: onPathDir,
    }, "win32")).toEqual({ env: HYPERFRAMES_FFMPEG_PATH_ENV, kind: "ffmpeg", path: hyperframes, source: "env" });

    expect(resolveLocalFfmpegBin({ PATH: onPathDir }, "win32")).toEqual({
      env: "PATH",
      kind: "ffmpeg",
      path: join(onPathDir, "ffmpeg.exe"),
      source: "path",
    });
  });

  it("reports nothing when no ffmpeg exists anywhere", () => {
    expect(resolveLocalFfmpegBin({ PATH: join(root, "empty") }, "win32")).toEqual({
      env: "PATH",
      kind: "ffmpeg",
      path: null,
      source: "unset",
    });
  });

  it("fails closed when a configured ffmpeg path is missing", () => {
    expect(() => resolveLocalFfmpegBin({ [LOCAL_FFMPEG_BIN_ENV]: join(root, "missing.exe") }, "win32"))
      .toThrow(/must point at an existing file/);
  });
});

describe("describeLocalDependencies", () => {
  it("summarises which dependencies came from the environment", async () => {
    const addon = join(root, "better_sqlite3.node");
    await writeFile(join(root, "electron.exe"), "stub", "utf8");
    await writeFile(addon, Buffer.alloc(16), "utf8");

    const report = describeLocalDependencies({
      [LOCAL_ELECTRON_DIST_ENV]: root,
      [LOCAL_BETTER_SQLITE3_PREBUILD_ENV]: addon,
      PATH: "",
    }, { arch: "arm64", platform: "win32" });

    expect(report.map((entry) => [entry.kind, entry.source])).toEqual([
      ["electron-dist", "env"],
      ["better-sqlite3-prebuild", "env"],
      ["ffmpeg", "unset"],
    ]);
  });
});
