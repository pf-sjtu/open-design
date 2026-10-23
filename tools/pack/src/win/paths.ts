import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ToolPackConfig, ToolPackTargetArch } from "../config/index.js";
import {
  WIN_PREBUNDLE_ENTRYPOINTS_DIR_NAME,
  WIN_PREBUNDLE_META_DIR_NAME,
  WIN_PREBUNDLED_APP_DIR_NAME,
  WIN_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH,
  WIN_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH,
  WIN_PREBUNDLED_PACKAGED_MAIN_RELATIVE_PATH,
  WIN_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH,
} from "./prebundle.js";
import { PRODUCT_NAME } from "./constants.js";
import { pathExists } from "./fs.js";
import { resolveWinInstallIdentity } from "./identity.js";
import type { WinPaths, WinRemovalTarget } from "./types.js";

export function sanitizeNamespace(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * electron-builder names the x64 output `win-unpacked` and every other
 * architecture `win-<arch>-unpacked` (see app-builder-lib's
 * `computeAppOutDir`). Every tools-pack path that points into the builder
 * output must follow that naming, otherwise the arm64 checks look into a
 * directory electron-builder never created.
 */
export function winUnpackedDirName(arch: ToolPackTargetArch): string {
  return arch === "x64" ? "win-unpacked" : `win-${arch}-unpacked`;
}

export function resolveWinPaths(config: ToolPackConfig): WinPaths {
  const namespaceToken = sanitizeNamespace(config.namespace);
  // Artifact names stay byte-identical for x64; arm64 gets a suffix so the two
  // architectures never overwrite each other in the same output namespace.
  const archToken = config.targetArch === "x64" ? "" : `-${config.targetArch}`;
  const unpackedDirName = winUnpackedDirName(config.targetArch);
  const namespaceRoot = config.roots.output.namespaceRoot;
  const installDir = join(config.roots.runtime.namespaceRoot, "install", PRODUCT_NAME);
  const identity = resolveWinInstallIdentity(config);
  return {
    appBuilderConfigPath: join(namespaceRoot, "builder-config.json"),
    appBuilderOutputRoot: join(namespaceRoot, "builder"),
    assembledAppRoot: join(namespaceRoot, "assembled", "app"),
    assembledMainEntryPath: join(namespaceRoot, "assembled", "app", "main.cjs"),
    assembledPackageJsonPath: join(namespaceRoot, "assembled", "app", "package.json"),
    assembledPrebundledRoot: join(namespaceRoot, "assembled", "app", WIN_PREBUNDLED_APP_DIR_NAME),
    blockmapPath: join(namespaceRoot, "builder", `${PRODUCT_NAME}-${namespaceToken}${archToken}-setup.exe.blockmap`),
    builtManifestPath: join(namespaceRoot, "built-app.json"),
    daemonCliPrebundleEntrypointPath: join(namespaceRoot, WIN_PREBUNDLE_ENTRYPOINTS_DIR_NAME, "daemon-cli.js"),
    daemonCliPrebundlePath: join(namespaceRoot, "assembled", WIN_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH),
    daemonPrebundleMetaPath: join(namespaceRoot, WIN_PREBUNDLE_META_DIR_NAME, "daemon.meta.json"),
    daemonPrebundleRoot: join(namespaceRoot, "assembled", "app", WIN_PREBUNDLED_APP_DIR_NAME, "daemon"),
    daemonSidecarPrebundleEntrypointPath: join(namespaceRoot, WIN_PREBUNDLE_ENTRYPOINTS_DIR_NAME, "daemon-sidecar.js"),
    daemonSidecarPrebundlePath: join(namespaceRoot, "assembled", WIN_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH),
    exePath: join(namespaceRoot, "builder", `${PRODUCT_NAME}-${namespaceToken}.exe`),
    installDir,
    installedExePath: join(installDir, `${PRODUCT_NAME}.exe`),
    installerBasePayloadPath: join(namespaceRoot, "installer", "payload-base.7z"),
    installerOverlayPayloadPath: join(namespaceRoot, "installer", "payload-overlay.7z"),
    installerScriptPath: join(namespaceRoot, "installer", "installer.nsi"),
    launcherPayloadPath: join(namespaceRoot, "payload", `${PRODUCT_NAME}-${namespaceToken}-payload.7z`),
    publicDesktopShortcutPath: join(process.env.PUBLIC ?? join(dirname(homedir()), "Public"), "Desktop", identity.shortcutName),
    installMarkerPath: join(namespaceRoot, "logs", "install.marker.json"),
    installTimingPath: join(namespaceRoot, "logs", "install.timing.json"),
    latestYmlPath: join(namespaceRoot, "builder", "latest.yml"),
    nsisLogPath: join(namespaceRoot, "logs", "nsis.log"),
    nsisIncludePath: join(namespaceRoot, "nsis", "installer.nsh"),
    packagedConfigPath: join(namespaceRoot, "open-design-config.json"),
    packagedMainPrebundleMetaPath: join(namespaceRoot, WIN_PREBUNDLE_META_DIR_NAME, "packaged-main.meta.json"),
    packagedMainPrebundlePath: join(namespaceRoot, "assembled", WIN_PREBUNDLED_PACKAGED_MAIN_RELATIVE_PATH),
    resourceRoot: join(namespaceRoot, "resources", "open-design"),
    setupPath: join(namespaceRoot, "builder", `${PRODUCT_NAME}-${namespaceToken}${archToken}-setup.exe`),
    setupZipPath: join(namespaceRoot, "builder", `${PRODUCT_NAME}-${namespaceToken}${archToken}-portable.zip`),
    startMenuShortcutPath: join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", identity.shortcutName),
    tarballsRoot: join(namespaceRoot, "tarballs"),
    userDesktopShortcutPath: join(homedir(), "Desktop", identity.shortcutName),
    uninstallMarkerPath: join(namespaceRoot, "logs", "uninstall.marker.json"),
    uninstallTimingPath: join(namespaceRoot, "logs", "uninstall.timing.json"),
    uninstallerPath: join(installDir, identity.uninstallerName),
    webStandaloneHookAuditPath: join(namespaceRoot, "web-standalone-after-pack-audit.json"),
    webStandaloneHookConfigPath: join(namespaceRoot, "web-standalone-after-pack-config.json"),
    webSidecarPrebundleMetaPath: join(namespaceRoot, WIN_PREBUNDLE_META_DIR_NAME, "web-sidecar.meta.json"),
    webSidecarPrebundlePath: join(namespaceRoot, "assembled", WIN_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH),
    winIconPath: join(namespaceRoot, "resources", "win", "icon.ico"),
    unpackedExePath: join(namespaceRoot, "builder", unpackedDirName, `${PRODUCT_NAME}.exe`),
    unpackedRoot: join(namespaceRoot, "builder", unpackedDirName),
  };
}

export function resolveWinProductUserDataRoot(): string {
  return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), PRODUCT_NAME);
}

export function resolveWinUninstallLocalDataRoot(config: ToolPackConfig): string {
  return config.portable ? `$APPDATA\\${PRODUCT_NAME}` : config.roots.runtime.namespaceRoot;
}

export function resolveWinProductNamespaceRoot(config: ToolPackConfig): string {
  return join(resolveWinProductUserDataRoot(), "namespaces", config.namespace);
}

export function resolveWinLocalDataRoot(config: ToolPackConfig): string {
  return resolveWinProductNamespaceRoot(config);
}

export async function createWinRemovalPlan(config: ToolPackConfig): Promise<WinRemovalTarget[]> {
  const runtimeRoot = config.roots.runtime.namespaceRoot;
  const targets: Array<Omit<WinRemovalTarget, "exists">> = [
    { path: join(runtimeRoot, "cache"), scope: "cache", willRemove: config.removeCache === true },
    { path: join(runtimeRoot, "updates", "downloads"), scope: "cache", willRemove: config.removeCache === true },
    { path: join(runtimeRoot, "updates", "releases"), scope: "cache", willRemove: config.removeCache === true },
    { path: join(runtimeRoot, "updates", "staging"), scope: "cache", willRemove: config.removeCache === true },
    { path: join(runtimeRoot, "data"), scope: "data", willRemove: config.removeData },
    { path: join(runtimeRoot, "logs"), scope: "logs", willRemove: config.removeLogs },
    { path: join(runtimeRoot, "runtime"), scope: "sidecars", willRemove: config.removeSidecars },
    {
      path: resolveWinLocalDataRoot(config),
      scope: "product-user-data",
      willRemove: config.removeProductUserData,
    },
  ];
  return await Promise.all(targets.map(async (target) => ({ ...target, exists: await pathExists(target.path) })));
}
