import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { changedPaths, fingerprint } from "../src/tree.ts";
import { commit, workspace, write } from "./helpers.ts";

const gitAs = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "ignore",
  });

describe("a git submodule", () => {
  it("shows a change to a file inside it", () => {
    const library = mkdtempSync(join(tmpdir(), "compose-test-lib-"));
    write(library, "src/main/java/l/Greeter.kt", 'package l\nfun hello() = "Hello"\n');
    gitAs(library, "init", "-q");
    gitAs(library, "add", "-A");
    gitAs(library, "commit", "-qm", "library");
    const root = workspace();
    gitAs(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "core");
    commit(root, "submodule");
    const before = fingerprint(root);
    write(root, "core/src/main/java/l/Greeter.kt", 'package l\nfun hello() = "Bye"\n');
    expect(changedPaths(root, before, fingerprint(root))).toEqual(["core"]);
  });
});

describe("a module whose build directory git does not ignore", () => {
  it("keeps build output out of the fingerprint, but not a source package named build", () => {
    const root = workspace();
    write(root, ".gitignore", "");
    commit(root, "track everything");
    const before = fingerprint(root);
    write(root, "app/build/test-results/testDebugUnitTest/TEST-a.FooTest.xml", "<testsuite/>");
    const pkg = "app/src/main/java/a/build/Thing.kt";
    write(root, pkg, "package a.build");
    expect(changedPaths(root, before, fingerprint(root))).toEqual([pkg]);
  });
});
