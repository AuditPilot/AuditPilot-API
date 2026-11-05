import { describe, expect, it } from "vitest";
import { resolveFilePath } from "./service";

describe("resolveFilePath", () => {
  const tree = [
    "README.md",
    "package.json",
    "client/src/App.tsx",
    "client/src/hooks/use-audits.ts",
    "server/config/settings.js",
    "src/screens/RootScreen.tsx",
  ];

  it("resolves an exact (case-insensitive) path", () => {
    expect(resolveFilePath("client/src/App.tsx", tree)).toBe("client/src/App.tsx");
    expect(resolveFilePath("CLIENT\\SRC\\APP.TSX", tree)).toBe("client/src/App.tsx");
  });

  it("never accepts the bogus 'Root' placeholder the AI used to emit", () => {
    expect(resolveFilePath("Root", tree)).toBeNull();
    expect(resolveFilePath("root", tree)).toBeNull();
    expect(resolveFilePath("", tree)).toBeNull();
    expect(resolveFilePath(null, tree)).toBeNull();
  });

  it("maps a bare basename to a unique tree file", () => {
    expect(resolveFilePath("use-audits.ts", tree)).toBe("client/src/hooks/use-audits.ts");
  });

  it("ranks same-basename candidates by longest shared path suffix", () => {
    const deeper = ["app/config.js", "app/server/config.js"];
    expect(resolveFilePath("server/config.js", deeper)).toBe("app/server/config.js");
  });

  it("uses token overlap when the basename does not match", () => {
    expect(resolveFilePath("settings config", tree)).toBe("server/config/settings.js");
  });

  it("returns null when nothing plausible matches", () => {
    expect(resolveFilePath("definitely/missing/thing.go", tree)).toBeNull();
  });
});
