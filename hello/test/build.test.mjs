// The code of the plugin, built by the real eve.
//
// A plugin's code is never built by an eve of its own: `iva plugin add` copies the folder
// into the next version and builds it with the eve of that installation (ADR-0009). This
// check does the same in a temporary directory - copy, build, then call the built tool -
// so the answer is the one the installation would get.
//
// `IVA_REPO` is an Iva checkout with `node_modules`; without it the test skips, because a
// plugin repository is not required to have one at hand.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IVA = process.env.IVA_REPO ? resolve(process.env.IVA_REPO) : "";
const EVE = IVA ? join(IVA, "node_modules/.bin/eve") : "";
const SKIP = EVE && existsSync(EVE) ? false : "set IVA_REPO to an Iva checkout with node_modules";

/** The plugin as it is published: no build output, no installed dependencies. */
function stage(t) {
  const dir = mkdtempSync(join(tmpdir(), "iva-hello-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(PLUGIN, join(dir, "hello"), {
    recursive: true,
    filter: (source) => !/(^|[\\/])(node_modules|dist)$/u.test(source),
  });
  // One node_modules above the copy: `eve` resolves by walking up, as it does in a version.
  symlinkSync(join(IVA, "node_modules"), join(dir, "node_modules"));
  return join(dir, "hello/sh.iva");
}

test("the real eve builds the plugin and the built tool greets", { skip: SKIP }, async (t) => {
  const code = stage(t);
  execFileSync(EVE, ["extension", "build"], { cwd: code, stdio: "pipe" });

  // What the build must leave: the package, the compatibility manifest and the tool itself.
  for (const path of [
    "dist/index.mjs",
    "dist/extension/_manifest.json",
    "dist/extension/tools/hello.mjs",
  ])
    assert.ok(existsSync(join(code, path)), `${path} is missing`);

  // The package entry: Iva writes `main` from it in the copy inside a version, and without
  // an existing file the agent build dies on the generated mount.
  const manifest = JSON.parse(readFileSync(join(code, "package.json"), "utf8"));
  const entry = manifest.exports?.["."]?.default;
  assert.equal(typeof entry, "string");
  assert.ok(existsSync(join(code, entry)), `${entry} is missing`);

  // The build carried OUR tool, not an empty package.
  const tool = await import(join(code, "dist/extension/tools/hello.mjs"));
  assert.equal(tool.default.description.startsWith("Greet somebody by name"), true);
  assert.equal(await tool.default.execute({ name: "Sergey" }), "Hello, Sergey!");
  assert.equal(await tool.default.execute({}), "Hello, world!");
  // Junk input: the tool answers instead of crashing from its insides.
  assert.equal(await tool.default.execute({ name: "   " }), "Hello, world!");
  assert.equal(await tool.default.execute({ name: 42 }), "Hello, world!");
});
