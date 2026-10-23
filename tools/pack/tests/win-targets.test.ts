import { describe, expect, it } from "vitest";

import {
  resolveElectronBuilderWinTargets,
  resolveWinTargets,
  shouldBuildWinNsisInstaller,
  shouldBuildWinPortableZip,
} from "@/win/report.js";

describe("resolveWinTargets", () => {
  it("builds the installable artifacts for `all` and leaves the portable zip opt-in", () => {
    // The zip is a second full copy of the payload; `all` no longer pays for it.
    expect(resolveWinTargets("all")).toEqual(["dir", "nsis"]);
  });

  it("returns only the requested single target", () => {
    expect(resolveWinTargets("dir")).toEqual(["dir"]);
    expect(resolveWinTargets("nsis")).toEqual(["nsis"]);
    expect(resolveWinTargets("zip")).toEqual(["zip"]);
  });
});

describe("resolveElectronBuilderWinTargets", () => {
  it("hides the portable zip from electron-builder because it is built from the cached unpacked dir", () => {
    expect(resolveElectronBuilderWinTargets("zip")).toEqual(["dir"]);
    expect(resolveElectronBuilderWinTargets("all")).toEqual(["dir", "nsis"]);
    expect(resolveElectronBuilderWinTargets("nsis")).toEqual(["nsis"]);
    expect(resolveElectronBuilderWinTargets("dir")).toEqual(["dir"]);
  });
});

describe("shouldBuildWinNsisInstaller / shouldBuildWinPortableZip", () => {
  it("flags the NSIS installer and portable zip independently", () => {
    expect(shouldBuildWinNsisInstaller("nsis")).toBe(true);
    expect(shouldBuildWinNsisInstaller("all")).toBe(true);
    expect(shouldBuildWinNsisInstaller("zip")).toBe(false);
    expect(shouldBuildWinNsisInstaller("dir")).toBe(false);

    expect(shouldBuildWinPortableZip("zip")).toBe(true);
    expect(shouldBuildWinPortableZip("all")).toBe(false);
    expect(shouldBuildWinPortableZip("nsis")).toBe(false);
    expect(shouldBuildWinPortableZip("dir")).toBe(false);
  });
});
