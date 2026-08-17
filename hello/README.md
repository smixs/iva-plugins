# hello

The smallest plugin that carries code: one skill and one tool. Copy the folder, rename it,
and you have the whole path of a code plugin already wired.

```
hello/
  plugin.json                    the manifest: Agent Plugins 1.0.0, with our namespace declared
  skills/hello/SKILL.md          when the model should call the tool
  sh.iva/                        our namespace: the code of the plugin
    package.json                 eve.extension.{source,dist}, peerDependencies eve
    tsconfig.json                required — eve emits declarations with tsc, and tsc needs one here
    extension/extension.ts       the extension handle: defineExtension()
    extension/tools/hello.ts     the tool; the file name is the tool name
  test/build.test.mjs            the build check: the real eve builds the folder
```

## What it shows

- **The manifest of a code plugin.** `extensions: { "sh.iva": {} }` is what says "there is code
  here". The folder `sh.iva/` says the same; both are read.
- **The tool.** `sh.iva/extension/tools/hello.ts` takes `{ name?: string }` and returns
  `Hello, <name>!`. The model calls it `hello__hello`: Iva mounts the extension under the name
  of the plugin, and the mount adds that prefix to every contribution.
- **The simplest input schema.** A plain JSON Schema object, so the plugin has no dependencies
  and nothing is installed before the build. A Zod schema works the same way once the plugin
  declares `zod` in `dependencies`.
- **Who builds it.** Nobody commits `dist/`. `iva plugin add` copies the folder into the next
  version, runs `eve extension build` with the eve of that installation, generates the mount and
  restarts — so the plugin is always compatible with the eve that runs it.

## Install

```bash
iva plugin add hello                    # by name, from the default Marketplace
iva plugin add ~/dev/iva-plugins/hello  # or from a folder, which is how you test your own
```

Then ask Iva to say hello to somebody. `iva plugin list` shows it as installed and enabled.

## The build check

```bash
IVA_REPO=~/dev/my/assistant node --test test/build.test.mjs
```

`IVA_REPO` is an Iva checkout with `node_modules`: a plugin is built by the eve of the
installation, never by one of its own. Without it the test skips. The check copies the folder
into a temporary directory, builds `sh.iva/` with that eve, and calls the built tool.
