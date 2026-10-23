import { open, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ToolPackTargetArch } from "./config/index.js";

/**
 * Runtime architecture audit.
 *
 * Windows ARM64 packaging keeps failing in the same shape: one dependency has no
 * `win32-arm64` build, the packager silently ships an x64 copy (or nothing), and
 * the breakage only surfaces at runtime — a login button that reports
 * "vela binary not found", media rendering that throws on require, a terminal
 * that spawns nothing. Chasing those one package at a time does not scale, so
 * every packaged payload is audited instead: each PE file is read, classified
 * against the target architecture, and the build fails when a native runtime
 * component is the wrong architecture.
 *
 * Classification:
 *  - `native`          matches the target architecture — nothing to do
 *  - `emulated`        x64 inside an arm64 payload, on Windows x64 emulation.
 *                      Allowed only for an explicit allowlist (vendored helpers,
 *                      cross-platform prebuilds that are never loaded).
 *  - `other-platform`  prebuilds for darwin/linux/other win arch kept by the
 *                      dependency's own packing — dead weight, not a defect.
 *  - `foreign`         anything else: the payload cannot run on the target.
 */

const MACHINE_BY_CODE: Record<number, string> = {
  0x014c: "x86",
  0x01c4: "arm",
  0x8664: "x64",
  0xaa64: "arm64",
};

const SCANNED_EXTENSIONS = [".node", ".exe", ".dll"];

export type ArchClassification = "emulated" | "foreign" | "native" | "other-platform";

export type ArchAuditEntry = {
  arch: string;
  classification: ArchClassification;
  relativePath: string;
};

export type ArchAuditReport = {
  counts: Record<ArchClassification, number>;
  entries: ArchAuditEntry[];
  targetArch: ToolPackTargetArch;
  /** Reasons the payload must not ship. Empty means the payload is consistent. */
  failures: string[];
};

/** x64 helpers that Windows ARM64 runs under emulation, so they may ship in an arm64 payload. */
const EMULATION_ALLOWLIST: Array<{ match: (relativePath: string) => boolean; reason: string }> = [
  {
    // Vendored 7-Zip used by the NSIS installer/uninstaller; no arm64 build exists.
    match: (p) => p.startsWith("open-design/bin/7z") || p.includes("resources/open-design/bin/7z"),
    reason: "vendored 7-Zip helper (installer only, runs under x64 emulation)",
  },
  {
    // node-pty ships ConPTY for every Windows arch; the third_party copy is
    // never loaded at runtime (prebuilds/<platform>-<arch> is).
    match: (p) => p.includes("/node_modules/node-pty/third_party/"),
    reason: "node-pty build-time third_party copy (not loaded at runtime)",
  },
  {
    // Vela publishes no win32-arm64 package; the bundled CLI is the x64 build
    // running under Windows ARM emulation (bundled only when the build opted in
    // via OPEN_DESIGN_VELA_CLI_BIN).
    match: (p) => /(?:^|\/)resources\/open-design\/bin\/(?:vela\.exe|libexec\/opencode\/opencode\.exe)$/u.test(p),
    reason: "Vela CLI/OpenCode have no win32-arm64 build (x64 emulation)",
  },
  {
    // ONNX Runtime ships one binary tree per platform/arch and selects at load.
    match: (p) => /\/node_modules\/onnxruntime-node\/bin\/napi-v\d+\/win32\/x64\//u.test(p),
    reason: "onnxruntime non-target arch tree (the arm64 tree is selected at load)",
  },
];

const OTHER_PLATFORM_MARKERS = [
  "/prebuilds/darwin-",
  "/prebuilds/linux-",
  "/prebuilds/win32-ia32/",
];

function otherPlatformMarkerFor(targetArch: ToolPackTargetArch): string {
  return targetArch === "arm64" ? "/prebuilds/win32-x64/" : "/prebuilds/win32-arm64/";
}

/** Native runtime components that must exist for the target arch. */
function requiredRuntimeComponents(targetArch: ToolPackTargetArch): Array<{ label: string; relativePath: string }> {
  return [
    {
      label: "better-sqlite3 addon",
      relativePath: "resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    },
    {
      label: `node-pty ${targetArch} prebuild`,
      relativePath: `resources/app/node_modules/node-pty/prebuilds/win32-${targetArch}/pty.node`,
    },
  ];
}

/**
 * sharp names its addon after the package version (`lib/sharp-win32-arm64-0.35.3.node`),
 * so it cannot be pinned to a literal path.
 */
async function findSharpAddon(root: string, targetArch: ToolPackTargetArch): Promise<string | null> {
  const libDir = join(root, "resources", "app", "node_modules", "@img", `sharp-win32-${targetArch}`, "lib");
  try {
    const entries = await readdir(libDir);
    return entries.find((name) => name.startsWith(`sharp-win32-${targetArch}`) && name.endsWith(".node")) ?? null;
  } catch {
    return null;
  }
}

async function readPeMachine(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, "r");
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 64 || header[0] !== 0x4d || header[1] !== 0x5a) return null;
    const peOffset = header.readUInt32LE(60);
    if (peOffset + 6 > bytesRead) {
      const tail = Buffer.alloc(8);
      await handle.read(tail, 0, tail.length, peOffset);
      if (tail[0] !== 0x50 || tail[1] !== 0x45) return null;
      return MACHINE_BY_CODE[tail.readUInt16LE(4)] ?? `unknown:0x${tail.readUInt16LE(4).toString(16)}`;
    }
    if (header.readUInt32LE(peOffset) !== 0x00004550) return null;
    return MACHINE_BY_CODE[header.readUInt16LE(peOffset + 4)]
      ?? `unknown:0x${header.readUInt16LE(peOffset + 4).toString(16)}`;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function listPeFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SCANNED_EXTENSIONS.some((extension) => entry.name.toLowerCase().endsWith(extension))) continue;
      found.push(full);
    }
  };
  await walk(root);
  return found;
}

export async function auditPayloadArchitecture(
  root: string,
  targetArch: ToolPackTargetArch,
): Promise<ArchAuditReport> {
  const entries: ArchAuditEntry[] = [];
  const failures: string[] = [];
  const counts: Record<ArchClassification, number> = { emulated: 0, foreign: 0, native: 0, "other-platform": 0 };
  const emulationMarker = otherPlatformMarkerFor(targetArch);

  for (const file of await listPeFiles(root)) {
    const arch = await readPeMachine(file);
    if (arch == null) continue;
    const relativePath = relative(root, file).replace(/\\/g, "/");

    let classification: ArchClassification;
    if (OTHER_PLATFORM_MARKERS.some((marker) => relativePath.includes(marker))
      || relativePath.includes(emulationMarker)) {
      classification = "other-platform";
    } else if (arch === targetArch) {
      classification = "native";
    } else if (arch === "x64" && targetArch === "arm64"
      && EMULATION_ALLOWLIST.some((rule) => rule.match(relativePath))) {
      classification = "emulated";
    } else if (targetArch === "x64" && arch === "x86" && relativePath.startsWith("Uninstall ")) {
      // NSIS always produces a 32-bit uninstaller, even for x64/arm64 installs.
      classification = "emulated";
    } else if (arch === "x86" && /(?:^|\/)Uninstall [^/]*\.exe$/u.test(relativePath)) {
      // NSIS always produces a 32-bit uninstaller, even for x64/arm64 installs.
      classification = "emulated";
    } else {
      classification = "foreign";
      failures.push(`${arch} binary in a ${targetArch} payload: ${relativePath}`);
    }

    counts[classification] += 1;
    entries.push({ arch, classification, relativePath });
  }

  for (const component of requiredRuntimeComponents(targetArch)) {
    const path = join(root, ...component.relativePath.split("/"));
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size === 0) {
        failures.push(`${component.label} is missing or empty: ${component.relativePath}`);
      }
    } catch {
      failures.push(`${component.label} is missing: ${component.relativePath}`);
    }
  }

  if (await findSharpAddon(root, targetArch) == null) {
    failures.push(`sharp ${targetArch} addon is missing: resources/app/node_modules/@img/sharp-win32-${targetArch}/lib/`);
  }

  return { counts, entries, failures, targetArch };
}

export function formatArchAuditReport(report: ArchAuditReport): string {
  const { counts } = report;
  const summary = [
    `[tools-pack] runtime architecture audit (target ${report.targetArch})`,
    `  native=${counts.native} emulated=${counts.emulated} other-platform=${counts["other-platform"]} foreign=${counts.foreign}`,
  ];
  for (const entry of report.entries) {
    if (entry.classification === "emulated" || entry.classification === "foreign") {
      summary.push(`  ${entry.classification}: ${entry.arch} ${entry.relativePath}`);
    }
  }
  for (const failure of report.failures) {
    summary.push(`  FAIL ${failure}`);
  }
  return summary.join("\n");
}
