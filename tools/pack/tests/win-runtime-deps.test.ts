import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { winPrebundleRuntimeDependencies } from "@/win/app.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "open-design-win-runtime-deps-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("winPrebundleRuntimeDependencies", () => {
  it("keeps the ffmpeg installer for x64 payloads", async () => {
    const ffmpeg = join(root, "ffmpeg.exe");
    await writeFile(ffmpeg, "stub", "utf8");

    const dependencies = winPrebundleRuntimeDependencies({ targetArch: "x64" }, { OD_FFMPEG_BIN: ffmpeg, PATH: "" });
    expect(dependencies["@ffmpeg-installer/ffmpeg"]).toBe("1.1.0");
  });

  it("drops the installer for arm64 when the environment supplies an ffmpeg", async () => {
    const ffmpeg = join(root, "ffmpeg.exe");
    await writeFile(ffmpeg, "stub", "utf8");

    const dependencies = winPrebundleRuntimeDependencies({ targetArch: "arm64" }, { OD_FFMPEG_BIN: ffmpeg, PATH: "" });
    expect(dependencies["@ffmpeg-installer/ffmpeg"]).toBeUndefined();
    // Everything else the daemon prebundles stays in place.
    expect(dependencies["better-sqlite3"]).toBe("12.10.0");
    expect(dependencies["node-pty"]).toBe("1.1.0");
  });

  it("drops the installer for arm64 when ffmpeg is only on PATH", async () => {
    const binDir = join(root, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "ffmpeg.exe"), "stub", "utf8");

    const dependencies = winPrebundleRuntimeDependencies({ targetArch: "arm64" }, { PATH: binDir });
    expect(dependencies["@ffmpeg-installer/ffmpeg"]).toBeUndefined();
  });

  it("keeps the installer for arm64 when nothing supplies ffmpeg", () => {
    const dependencies = winPrebundleRuntimeDependencies({ targetArch: "arm64" }, { PATH: "" });
    expect(dependencies["@ffmpeg-installer/ffmpeg"]).toBe("1.1.0");
  });
});
