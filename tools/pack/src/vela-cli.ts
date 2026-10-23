import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { chmod, cp, mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const VELA_CLI_BIN_ENV = "OPEN_DESIGN_VELA_CLI_BIN";

/**
 * Vela publishes no `win32-arm64` package. Windows 11 on ARM runs x64 binaries
 * under emulation, so an arm64 payload falls back to the x64 CLI when it happens
 * to be installed; `OPEN_DESIGN_VELA_CLI_BIN` is the supported way to supply a
 * local copy explicitly.
 */
const EMULATED_VELA_CLI_PACKAGE_BY_PLATFORM: Partial<Record<string, string>> = {
  "win32-arm64": "@powerformer/vela-cli-win32-x64",
};
const OPEN_CODE_COMPANION_RELATIVE_PATH = ["libexec", "opencode"] as const;
const AUTHORIZED_PULL_HELP_ARGS = ["team-projects", "pull", "--help"] as const;
// The daemon always invokes `pull <projectId> <stageDir> --live-dir …`
// (`stageAuthorizedTeamProjectPull`), so the staging-directory positional is
// part of the capability, not decoration: a CLI whose usage dropped it would
// pass a laxer gate here and then reject the shipped invocation at runtime.
//
// What is NOT part of the capability is whether that positional reads as
// required or optional. Vela made it optional when it added `--authorize-only`
// (a size probe that stages nothing), turning `<stageDir>` into `[stageDir]`
// without removing anything the daemon relies on. Accept both spellings and
// nothing else, so the gate stays fail-closed on a genuinely missing argument.
const AUTHORIZED_PULL_USAGE_PATTERN =
  /pull <projectId> (?:<stageDir>|\[stageDir\])/u;
const AUTHORIZED_PULL_HELP_MARKERS = [
  "--expected-version",
  "--live-dir",
  "--ref",
  "--json",
] as const;
const WORKSPACE_BILLING_SNAPSHOT_HELP_ARGS = [
  "billing",
  "workspace-snapshot",
  "--help",
] as const;
const WORKSPACE_BILLING_SNAPSHOT_HELP_MARKERS = [
  "workspace-snapshot",
  "--workspace-id",
  "--format",
] as const;
const CODING_PLAN_PREFLIGHT_HELP_ARGS = ["billing", "preflight", "--help"] as const;
// The client's Coding Plan progress bar is driven by
// `billing preflight --workspace-id <id> [--model <id>] --format json`
// (`fetchVelaBillingPreflight`). A CLI without the subcommand does not fail
// here on its own: cobra answers an unknown subcommand by printing the parent
// `billing` help and exiting 0, so packaging would happily bundle a binary
// that silently drops the progress bar. Matching the subcommand name plus the
// three flags the daemon passes is what makes this gate fail-closed.
const CODING_PLAN_PREFLIGHT_HELP_MARKERS = [
  "preflight",
  "--workspace-id",
  "--model",
  "--format",
] as const;

type VelaCliPlatform = "linux" | "mac" | "win";
type VelaCliCommandResult = {
  stderr: string;
  stdout: string;
};
type RunVelaCliCommand = (
  binary: string,
  args: readonly string[],
) => Promise<VelaCliCommandResult>;
type VelaCliResolveResult =
  | string
  | null
  | undefined
  | {
      path?: string | null;
      supported?: boolean;
    };
type VelaCliResolverModule = {
  resolveVelaCliBin?: (
    options?: { strict?: boolean },
  ) => VelaCliResolveResult | Promise<VelaCliResolveResult>;
};

function strictResolutionError(message: string, cause?: unknown): Error {
  return new Error(
    `${message}; install @powerformer/vela-cli through pnpm install or set ${VELA_CLI_BIN_ENV}`,
    cause === undefined ? undefined : { cause },
  );
}

function targetBinaryName(platform: VelaCliPlatform): string {
  return platform === "win" ? "vela.exe" : "vela";
}

/** Resolve the x64 Vela package for architectures Vela does not publish. */
export function resolveEmulatedVelaCliBinary(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  const packageName = EMULATED_VELA_CLI_PACKAGE_BY_PLATFORM[`${platform}-${arch}`];
  if (packageName == null) return null;
  try {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const binary = join(dirname(packageJsonPath), "bin", targetBinaryName("win"));
    return statSync(binary).isFile() ? binary : null;
  } catch {
    return null;
  }
}

export async function copyOptionalVelaCliBinary({
  bundleOpenCodeCompanion = true,
  env = process.env,
  importPackage,
  platform,
  requireBundled = false,
  resourceRoot,
  runCommand = runVelaCliCommand,
  targetArch,
}: {
  /** Copy the `libexec/opencode` companion next to the CLI (~170 MB). */
  bundleOpenCodeCompanion?: boolean;
  env?: NodeJS.ProcessEnv;
  importPackage?: (packageName: string) => Promise<VelaCliResolverModule>;
  platform: VelaCliPlatform;
  requireBundled?: boolean;
  resourceRoot: string;
  runCommand?: RunVelaCliCommand;
  targetArch?: NodeJS.Architecture;
}): Promise<{ source: string; target: string } | null> {
  const source = await resolveOptionalVelaCliBinary({ env, importPackage, requireBundled, targetArch });
  if (source == null) return null;
  if (requireBundled) {
    await validateBundledVelaCliBinary(source, runCommand);
  }
  const target = join(resourceRoot, "bin", targetBinaryName(platform));
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
  if (bundleOpenCodeCompanion) {
    await copyBundledOpenCodeTree({ requireBundled, resourceRoot, source });
  }
  if (platform !== "win") {
    await chmod(target, 0o755);
  }
  return { source, target };
}

async function validateBundledVelaCliBinary(
  source: string,
  runCommand: RunVelaCliCommand,
): Promise<void> {
  const expectedVersion = await pinnedVelaCliVersion();
  let versionResult: VelaCliCommandResult;
  try {
    versionResult = await runCommand(source, ["--version"]);
  } catch (error) {
    throw strictResolutionError(
      `unable to validate bundled Vela CLI version against package pin ${expectedVersion}`,
      error,
    );
  }
  const actualVersion = versionResult.stdout.trim();
  if (actualVersion !== expectedVersion) {
    throw strictResolutionError(
      `bundled Vela CLI version ${JSON.stringify(actualVersion)} does not match package pin ${expectedVersion}`,
    );
  }

  let helpResult: VelaCliCommandResult;
  try {
    helpResult = await runCommand(source, AUTHORIZED_PULL_HELP_ARGS);
  } catch (error) {
    throw strictResolutionError(
      "bundled Vela CLI lacks the authorized staged pull capability",
      error,
    );
  }
  const help = `${helpResult.stdout}\n${helpResult.stderr}`;
  if (!AUTHORIZED_PULL_USAGE_PATTERN.test(help)) {
    throw strictResolutionError(
      "bundled Vela CLI lacks the authorized staged pull capability markers: pull <projectId> <stageDir>",
    );
  }
  const missingMarkers = AUTHORIZED_PULL_HELP_MARKERS.filter(
    (marker) => !help.includes(marker),
  );
  if (missingMarkers.length > 0) {
    throw strictResolutionError(
      `bundled Vela CLI lacks the authorized staged pull capability markers: ${missingMarkers.join(", ")}`,
    );
  }

  let billingSnapshotHelpResult: VelaCliCommandResult;
  try {
    billingSnapshotHelpResult = await runCommand(
      source,
      WORKSPACE_BILLING_SNAPSHOT_HELP_ARGS,
    );
  } catch (error) {
    throw strictResolutionError(
      "bundled Vela CLI lacks the workspace billing snapshot capability",
      error,
    );
  }
  const billingSnapshotHelp =
    `${billingSnapshotHelpResult.stdout}\n${billingSnapshotHelpResult.stderr}`;
  const missingBillingSnapshotMarkers =
    WORKSPACE_BILLING_SNAPSHOT_HELP_MARKERS.filter(
      (marker) => !billingSnapshotHelp.includes(marker),
    );
  if (missingBillingSnapshotMarkers.length > 0) {
    throw strictResolutionError(
      `bundled Vela CLI lacks the workspace billing snapshot capability markers: ${missingBillingSnapshotMarkers.join(", ")}`,
    );
  }

  let codingPlanPreflightHelpResult: VelaCliCommandResult;
  try {
    codingPlanPreflightHelpResult = await runCommand(
      source,
      CODING_PLAN_PREFLIGHT_HELP_ARGS,
    );
  } catch (error) {
    throw strictResolutionError(
      "bundled Vela CLI lacks the coding plan preflight capability",
      error,
    );
  }
  const codingPlanPreflightHelp =
    `${codingPlanPreflightHelpResult.stdout}\n${codingPlanPreflightHelpResult.stderr}`;
  const missingCodingPlanPreflightMarkers =
    CODING_PLAN_PREFLIGHT_HELP_MARKERS.filter(
      (marker) => !codingPlanPreflightHelp.includes(marker),
    );
  if (missingCodingPlanPreflightMarkers.length > 0) {
    throw strictResolutionError(
      `bundled Vela CLI lacks the coding plan preflight capability markers: ${missingCodingPlanPreflightMarkers.join(", ")}`,
    );
  }

  // Selected-file publication and explicit visibility moves must not silently
  // fall back to parent help on a CLI that predates the project policy API.
  for (const [command, positional] of [
    ["ensure-private", "<projectId>"],
    ["visibility", "<projectId> <private|team>"],
    ["register-resource", "<projectId> <resourceId>"],
  ] as const) {
    let policyHelp: VelaCliCommandResult;
    try {
      policyHelp = await runCommand(source, ["team-projects", command, "--help"]);
    } catch (error) {
      throw strictResolutionError(`bundled Vela CLI lacks the project policy capability: ${command}`, error);
    }
    if (!`${policyHelp.stdout}\n${policyHelp.stderr}`.includes(`vela team-projects ${command} ${positional}`)) {
      throw strictResolutionError(`bundled Vela CLI lacks the project policy capability: ${command}`);
    }
  }
}

async function pinnedVelaCliVersion(): Promise<string> {
  const rawManifest = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const manifest = JSON.parse(rawManifest) as {
    optionalDependencies?: Record<string, unknown>;
  };
  const version = manifest.optionalDependencies?.["@powerformer/vela-cli"];
  if (typeof version !== "string" || version.trim().length === 0) {
    throw strictResolutionError(
      "unable to validate bundled Vela CLI: tools-pack has no exact @powerformer/vela-cli package pin",
    );
  }
  const normalized = version.trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(normalized)) {
    throw strictResolutionError(
      `unable to validate bundled Vela CLI: package pin must be exact, got ${JSON.stringify(normalized)}`,
    );
  }
  return normalized;
}

function runVelaCliCommand(
  binary: string,
  args: readonly string[],
): Promise<VelaCliCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 5000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stderr, stdout });
      },
    );
  });
}

export function resolveVelaCliOpenCodeCompanionTree(source: string): string {
  return join(dirname(source), ...OPEN_CODE_COMPANION_RELATIVE_PATH);
}

export async function resolveOptionalVelaCliOpenCodeCompanionTree(
  source: string,
): Promise<string | null> {
  const sourceTree = resolveVelaCliOpenCodeCompanionTree(source);
  return (await isDirectory(sourceTree)) ? sourceTree : null;
}

async function copyBundledOpenCodeTree({
  requireBundled,
  resourceRoot,
  source,
}: {
  requireBundled: boolean;
  resourceRoot: string;
  source: string;
}): Promise<void> {
  const sourceTree = resolveVelaCliOpenCodeCompanionTree(source);
  const targetTree = join(resourceRoot, "bin", ...OPEN_CODE_COMPANION_RELATIVE_PATH);
  if (!(await isDirectory(sourceTree))) {
    if (requireBundled) {
      throw strictResolutionError(
        `unable to resolve bundled Vela CLI: OpenCode companion directory is missing at ${sourceTree}`,
      );
    }
    return;
  }
  await cp(sourceTree, targetTree, { force: true, recursive: true });
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function resolveOptionalVelaCliBinary({
  env = process.env,
  importPackage = async (packageName: string) =>
    import(packageName) as Promise<VelaCliResolverModule>,
  requireBundled = false,
  targetArch,
}: {
  env?: NodeJS.ProcessEnv;
  importPackage?: (packageName: string) => Promise<VelaCliResolverModule>;
  requireBundled?: boolean;
  /**
   * Payload architecture. Packaging passes the `--arch` target; leaving it
   * undefined keeps the plain resolver semantics (no emulation fallback).
   */
  targetArch?: NodeJS.Architecture;
} = {}): Promise<string | null> {
  const envSource = env[VELA_CLI_BIN_ENV]?.trim();
  if (envSource) return envSource;

  // Order matters: env > the installed package resolver > the x64 emulation
  // fallback. The fallback only runs when the resolver has nothing for this
  // platform (Vela publishes no win32-arm64 package), so mocks, x64 payloads and
  // older CLIs keep the plain resolver path.
  let resolver: VelaCliResolverModule | null = null;
  let importError: unknown = null;
  try {
    resolver = await importPackage("@powerformer/vela-cli");
  } catch (error) {
    importError = error;
  }

  if (resolver != null && typeof resolver.resolveVelaCliBin === "function") {
    // Never strict here: a strict resolver throws for an unsupported platform,
    // which is exactly the case the emulation fallback below handles.
    const resolved = await resolver.resolveVelaCliBin({ strict: false });
    if (typeof resolved === "string") {
      const normalized = resolved.trim();
      if (normalized.length > 0) return normalized;
    }
    if (resolved && typeof resolved === "object" && typeof resolved.path === "string") {
      const normalized = resolved.path.trim();
      if (normalized.length > 0) return normalized;
    }
  }

  // Vela has no win32-arm64 package: for an arm64 payload, bundle the x64 CLI
  // (Windows ARM runs it under emulation) instead of dropping the binary. Keyed
  // on the payload target, not the host, so a win-x64 payload built on an ARM64
  // host still resolves its own binary through the resolver above.
  const emulatedTarget = targetArch;
  const emulated = emulatedTarget == null ? null : resolveEmulatedVelaCliBinary("win32", emulatedTarget);
  if (emulated != null) {
    process.stderr.write(
      `[tools-pack] vela-cli has no native win32-${emulatedTarget} package; bundling ${EMULATED_VELA_CLI_PACKAGE_BY_PLATFORM[`win32-${emulatedTarget}`]} (x64 emulation): ${emulated}
`,
    );
    return emulated;
  }

  if (requireBundled) {
    if (importError != null) {
      throw strictResolutionError(
        "unable to resolve bundled Vela CLI: package @powerformer/vela-cli is unavailable",
        importError,
      );
    }
    if (resolver == null || typeof resolver.resolveVelaCliBin !== "function") {
      throw strictResolutionError(
        "unable to resolve bundled Vela CLI: @powerformer/vela-cli must export resolveVelaCliBin",
      );
    }
    throw strictResolutionError(
      "unable to resolve bundled Vela CLI: @powerformer/vela-cli returned no binary path",
    );
  }
  return null;
}
