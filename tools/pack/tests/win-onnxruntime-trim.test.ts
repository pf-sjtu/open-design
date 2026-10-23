import { describe, expect, it } from "vitest";

import {
  ELECTRON_BUILDER_FILE_PATTERNS,
  onnxRuntimeArchExcludes,
} from "@/win/constants.js";

// onnxruntime-node ships one native binding per platform+arch, but
// `dist/binding.js` only ever requires `../bin/napi-v3/${process.platform}/${process.arch}`.
// Everything else is dead weight in the payload (measured: 208 MB shipped vs
// 34 MB that the arm64 Windows build actually loads).
describe("onnxruntime payload trimming", () => {
  it("drops every non-Windows platform tree", () => {
    expect(ELECTRON_BUILDER_FILE_PATTERNS).toContain("!**/node_modules/onnxruntime-node/bin/napi-v*/darwin{,/**/*}");
    expect(ELECTRON_BUILDER_FILE_PATTERNS).toContain("!**/node_modules/onnxruntime-node/bin/napi-v*/linux{,/**/*}");
  });

  it("keeps only the target Windows architecture", () => {
    expect(onnxRuntimeArchExcludes("arm64")).toEqual([
      "!**/node_modules/onnxruntime-node/bin/napi-v*/win32/x64{,/**/*}",
    ]);
    expect(onnxRuntimeArchExcludes("x64")).toEqual([
      "!**/node_modules/onnxruntime-node/bin/napi-v*/win32/arm64{,/**/*}",
    ]);
  });

  it("never excludes the target architecture itself", () => {
    const excludes = [...ELECTRON_BUILDER_FILE_PATTERNS, ...onnxRuntimeArchExcludes("arm64")];
    const dropsArm64 = excludes.some((pattern) => /win32\/arm64/u.test(pattern));
    expect(dropsArm64).toBe(false);
  });
});
