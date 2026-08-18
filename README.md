# iva-plugins

The default Marketplace of [Iva](https://github.com/smixs/iva): a list of plugins in a git
repository, one name and its source. Not a registry — no center, no moderation, nobody's
approval to publish. The list is `.agents/plugins/marketplace.json`, in the convention of
Codex, so other clients can read it too (ADR-0009).

## What is on the list

| Plugin              | What it is                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [trace](./trace)    | Viewer for the turn journal: the schema of Iva with the path of a turn lit across it, the turn feed and a replay.          |
| [hello](./hello)    | The demo for authors: the smallest plugin that carries code — one skill, one tool.                                         |

## Add one to your Iva

This list is the default one, so a plugin on it installs by name:

```bash
iva plugin add trace
iva plugin list --available    # what every marketplace of yours offers
```

A folder installs the same way, which is how you try a plugin before it is listed anywhere:

```bash
iva plugin add ~/dev/iva-plugins/hello
iva plugin list
```

Your own repository works as a source too: `iva plugin add owner/repo`, with `@ref` when you
want a branch or a tag. Iva pins the commit and remembers it, so `iva plugin sync` restores
the plugin later without you.

## Publish your own

A plugin is a folder in the format Agent Plugins 1.0.0. Only `plugin.json` is required:

```
my-plugin/
  plugin.json                  $schema, name, version, description; extensions { "sh.iva": {} } when it carries code
  skills/<name>/SKILL.md       a skill: frontmatter with name and description; direct children of skills/ only
  mcp.json                     optional: MCP servers, stdio or streamable-http
  sh.iva/                      optional: our namespace, where the code and the services live
    package.json               eve.extension { source, dist } and eve in peerDependencies
    tsconfig.json              required with an extension: eve emits declarations with tsc
    extension/extension.ts     defineExtension()
    extension/tools/<tool>.ts  one file, one tool
```

What the client holds you to: a lowercase `name`, no symlinks anywhere in the folder, every
path inside the folder, and a folder of no more than 2000 entries, 50 MB and 16 levels. Do not commit `dist/`:
the code of a plugin is built by the eve of the installation that runs it, at `iva plugin add`
and again at every `iva update`.

Steps:

1. Copy [hello](./hello) and rename it. It builds and greets as it stands.
2. Test it locally: `iva plugin add /path/to/my-plugin`, then talk to Iva.
3. Push it to a git repository of your own, and it is publishable as it is: anybody can
   `iva plugin add owner/repo`.
4. To have it on this list, open a pull request that adds one entry to
   `.agents/plugins/marketplace.json`: `name`, `source` and one line of `description`. A
   `source` that names a folder of this repository is for plugins that live here; your own
   repository is `{ "source": "url", "url": "https://github.com/owner/repo" }`.

## Conventions

The plugins in this repository are TypeScript, and Node 24 runs the files as they are: no build
step, no bundler, and no dependencies unless a plugin declares them itself. Type stripping only
erases, so the code keeps to what erases — no `enum`, no `namespace`, no fields declared in the
constructor — and a relative import names the file it means, `./store.ts`. The `tsconfig.json`
at the root is for the editor and for `--noEmit` alone, and the `package.json` beside it names
the module format and nothing else; the types of the runtime come from an Iva checkout, because
a plugin repository installs nothing of its own:

```bash
IVA_REPO=~/dev/my/assistant
$IVA_REPO/node_modules/.bin/tsgo --noEmit -p tsconfig.json --typeRoots $IVA_REPO/node_modules/@types
```

The viewer page of `trace` is one HTML file on purpose (ADR-0010): a page that needs a build is
a page nobody can read in the folder it ships in. None of this binds anybody else — a plugin
service is any command at all, and the whole contract between Iva and it is `service.json` plus
the environment (`IVA_SERVICE_PORT`, `IVA_DATA_DIR`, `PLUGIN_ROOT`, `PLUGIN_DATA`).

Russian: [README.ru.md](./README.ru.md).
