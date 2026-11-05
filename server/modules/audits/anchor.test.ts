import { describe, expect, it } from "vitest";
import { anchorTokens, recoverAnchor } from "./service";

describe("anchorTokens", () => {
  it("prefers quoted tokens with high weight", () => {
    const label =
      "Unchecked reference to 'menubtn' before attaching an onclick handler. If the element with id 'menubtn' does not exist in the DOM, this will throw.";
    expect(anchorTokens(label)).toEqual([{ token: "menubtn", weight: 3 }]);
  });

  it("returns no tokens for label-only prose", () => {
    // Every word is either a stopword or below the length floor.
    const label = "This issue exists in the app and it is bad for users of the site";
    expect(anchorTokens(label)).toEqual([]);
  });

  it("falls back to unquoted identifiers at low weight", () => {
    // 'pointer' is long enough and not a stopword; the rest are.
    expect(anchorTokens("Potential null pointer inside code with issues")).toEqual([
      { token: "pointer", weight: 1 },
    ]);
  });
});

describe("recoverAnchor", () => {
  it("recovers file + line + snippet from a quoted token hit", () => {
    const files = new Map<string, string>([
      ["public/index.html", "<!DOCTYPE html>\n<button id=\"menubtn\">Menu</button>\n"],
      ["src/app.js", "console.log('hello');\n"],
    ]);
    const recovered = recoverAnchor(
      "Unchecked reference to 'menubtn' before attaching an onclick handler.",
      null,
      files,
    );
    expect(recovered).not.toBeNull();
    expect(recovered!.file).toBe("public/index.html");
    expect(recovered!.line).toBe(2);
    expect(recovered!.oldCode).toBe("<button id=\"menubtn\">Menu</button>");
    expect(recovered!.score).toBeGreaterThanOrEqual(6);
  });

  it("returns null when the quoted token appears nowhere (never fabricates)", () => {
    const files = new Map<string, string>([["src/app.js", "console.log('hello');\n"]]);
    const recovered = recoverAnchor("Unchecked reference to 'menubtn' here.", null, files);
    expect(recovered).toBeNull();
  });

  it("returns null for label-only prose with no code-searchable tokens", () => {
    const files = new Map<string, string>([["src/app.js", "const x = 1;\n"]]);
    const recovered = recoverAnchor(
      "This issue exists in the app and it is bad for users of the site",
      null,
      files,
    );
    expect(recovered).toBeNull();
  });

  it("biases toward the hinted file when several files contain the token", () => {
    const files = new Map<string, string>([
      ["src/a.js", "const apikey = 'x';\n"],
      ["src/b.js", "fetch(url, { headers: { apikey } });\n"],
    ]);
    const recovered = recoverAnchor("Hardcoded 'apikey' exposure in code.", "src/b.js", files);
    expect(recovered).not.toBeNull();
    expect(recovered!.file).toBe("src/b.js");
  });

  it("only reaches the threshold with a path bias for generic tokens", () => {
    // Single generic-token line hit scores 2 < 3 — must NOT anchor.
    const plain = new Map<string, string>([["src/app.js", "const pointer = ptr;\n"]]);
    expect(
      recoverAnchor("Uninitialized pointer may be referenced by code.", null, plain),
    ).toBeNull();

    // A path token hit adds +1, pushing the same hit over the floor.
    const biased = new Map<string, string>([["src/pointer.js", "const pointer = ptr;\n"]]);
    const recovered = recoverAnchor("Uninitialized pointer may be referenced by code.", null, biased);
    expect(recovered).not.toBeNull();
    expect(recovered!.file).toBe("src/pointer.js");
    expect(recovered!.line).toBe(1);
  });
});
