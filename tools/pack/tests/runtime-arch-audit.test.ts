import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { auditPayloadArchitecture, formatArchAuditReport } from "@/runtime-arch-audit.js";

const ARM64 = 0xaa64;
const X64 = 0x8664;

/** Minimal PE header: DOS magic, PE offset, PE signature, machine field. */
function peHeader(machine: number): Buffer {
  const buffer = Buffer.alloc(512, 0);
  buffer[0] = 0x4d;
  buffer[1] = 0x5a;
  buffer.writeUInt32LE(0x80, 60);
  buffer.writeUInt32LE(0x00004550, 0x80);
  buffer.writeUInt16LE(machine, 0x84);
  return buffer;
}

async function writePe(path: string, machine: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, peHeader(machine));
}

/** The components every Windows payload must contain for the target arch. */
async function writeRequiredComponents(root: string, arch: "arm64" | "x64"): Promise<void> {
  const appModules = join(root, "resources", "app", "node_modules");
  await writePe(join(appModules, "better-sqlite3", "build", "Release", "better_sqlite3.node"), arch === "arm64" ? ARM64 : X64);
  await writePe(join(appModules, "node-pty", "prebuilds", `win32-${arch}`, "pty.node"), arch === "arm64" ? ARM64 : X64);
  await writePe(join(appModules, "@img", `sharp-win32-${arch}`, "lib", `sharp-win32-${arch}-0.35.3.node`), arch === "arm64" ? ARM64 : X64);
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "open-design-arch-audit-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("auditPayloadArchitecture", () => {
  it("accepts an all-arm64 payload", async () => {
    await writeRequiredComponents(root, "arm64");
    await writePe(join(root, "Open Design.exe"), ARM64);
    await writePe(join(root, "resources", "app", "node_modules", "onnxruntime-node", "bin", "napi-v3", "win32", "arm64", "onnxruntime_binding.node"), ARM64);

    const report = await auditPayloadArchitecture(root, "arm64");
    expect(report.failures).toEqual([]);
    expect(report.counts.native).toBe(5);
  });

  it("treats the vendored 7-Zip and cross-arch prebuilds as acceptable", async () => {
    await writeRequiredComponents(root, "arm64");
    await writePe(join(root, "resources", "open-design", "bin", "7z.exe"), X64);
    await writePe(join(root, "resources", "app", "node_modules", "node-pty", "prebuilds", "win32-x64", "pty.node"), X64);

    const report = await auditPayloadArchitecture(root, "arm64");
    expect(report.failures).toEqual([]);
    expect(report.counts.emulated).toBe(1);
    expect(report.counts["other-platform"]).toBe(1);
  });

  it("treats a deliberately bundled x64 Vela CLI as emulated", async () => {
    await writeRequiredComponents(root, "arm64");
    await writePe(join(root, "resources", "open-design", "bin", "vela.exe"), X64);
    await writePe(join(root, "resources", "open-design", "bin", "libexec", "opencode", "opencode.exe"), X64);

    const report = await auditPayloadArchitecture(root, "arm64");
    expect(report.failures).toEqual([]);
    expect(report.counts.emulated).toBe(2);
  });

  it("fails when a runtime component is still x64 in an arm64 payload", async () => {
    await writeRequiredComponents(root, "arm64");
    // The exact shape of the vela/ffmpeg class of bug: an x64 native addon that
    // is actually loaded at runtime and is not on the emulation allowlist.
    await writePe(join(root, "resources", "app", "node_modules", "some-native-addon", "build", "Release", "addon.node"), X64);

    const report = await auditPayloadArchitecture(root, "arm64");
    expect(report.counts.foreign).toBe(1);
    expect(report.failures.join("\n")).toContain(
      "x64 binary in a arm64 payload: resources/app/node_modules/some-native-addon/build/Release/addon.node",
    );
    expect(formatArchAuditReport(report)).toContain("FAIL");
  });

  it("fails when a required arm64 component is missing", async () => {
    await writeRequiredComponents(root, "arm64");
    await rm(join(root, "resources", "app", "node_modules", "better-sqlite3"), { force: true, recursive: true });

    const report = await auditPayloadArchitecture(root, "arm64");
    expect(report.failures.join("\n")).toContain("better-sqlite3 addon is missing");
  });

  it("keeps the x64 target free of the NSIS 32-bit uninstaller false positive", async () => {
    await writeRequiredComponents(root, "x64");
    await writePe(join(root, "Open Design.exe"), X64);
    await writePe(join(root, "Uninstall Open Design.exe"), 0x014c);

    const report = await auditPayloadArchitecture(root, "x64");
    expect(report.failures).toEqual([]);
    expect(report.counts.emulated).toBe(1);
  });
});
