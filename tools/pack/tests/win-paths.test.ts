import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveToolPackConfig } from "@/config/index.js";
import { resolveWinPaths } from "@/win/paths.js";

const NAMESPACE = "arch-token";

describe("resolveWinPaths target arch token", () => {
  it("keeps x64 artifact names byte-identical to the historical layout", () => {
    const config = resolveToolPackConfig("win", { arch: "x64", namespace: NAMESPACE });
    const paths = resolveWinPaths(config);

    expect(paths.setupPath.endsWith(`${config.namespace}-setup.exe`)).toBe(true);
    expect(paths.setupZipPath.endsWith(`${config.namespace}-portable.zip`)).toBe(true);
    expect(paths.blockmapPath.endsWith(`${config.namespace}-setup.exe.blockmap`)).toBe(true);
    expect(paths.setupPath).not.toContain("arm64");
  });

  it("suffixes arm64 artifacts so both architectures can coexist in one namespace", () => {
    const config = resolveToolPackConfig("win", { arch: "arm64", namespace: NAMESPACE });
    const paths = resolveWinPaths(config);

    expect(paths.setupPath.endsWith(`${config.namespace}-arm64-setup.exe`)).toBe(true);
    expect(paths.setupZipPath.endsWith(`${config.namespace}-arm64-portable.zip`)).toBe(true);
    expect(paths.blockmapPath.endsWith(`${config.namespace}-arm64-setup.exe.blockmap`)).toBe(true);
  });

  it("follows electron-builder's unpacked directory naming per arch", () => {
    const x64 = resolveWinPaths(resolveToolPackConfig("win", { arch: "x64", namespace: NAMESPACE }));
    const arm64 = resolveWinPaths(resolveToolPackConfig("win", { arch: "arm64", namespace: NAMESPACE }));

    // electron-builder writes `win-unpacked` for x64 and `win-<arch>-unpacked`
    // for every other architecture.
    expect(x64.unpackedRoot.endsWith("win-unpacked")).toBe(true);
    expect(arm64.unpackedRoot.endsWith("win-arm64-unpacked")).toBe(true);
    expect(arm64.unpackedExePath).toBe(join(arm64.unpackedRoot, "Open Design.exe"));
  });
});
