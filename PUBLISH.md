# Publish a plugin to the Marketplace of Iva

For the owner of an Iva and for the agent that works for them: Iva herself, Codex, Claude Code.
Follow the steps in order. Each one ends with a check; do not go on until it passes.

Russian: [PUBLISH.ru.md](./PUBLISH.ru.md).

## What gets listed

A plugin in the format [Agent Plugins 1.0.0](https://agent-plugins.org) that installs with
`iva plugin add`, lives in a public GitHub repository of its author and carries an open
licence. A skill on its own is wrapped in a plugin: `plugin.json` and `skills/<name>/SKILL.md`.

The list is reviewed. An entry names one commit of your repository, and that commit is what
people install; a new version is a new pull request.

## 1. Build it and try it

In Iva, ask for the capability in your own words: the skill `make-plugin` builds the folder and
installs it. By hand, copy [hello](./hello) and follow "Write your own" in
[the plugin guide](https://github.com/smixs/iva-agent/blob/main/docs/plugins.md).

Check: `iva plugin add /path/to/my-plugin` installs it, and one real request to Iva uses it.

## 2. Clean it

Remove everything personal: keys, tokens, names, chat ids, e-mail addresses, home paths, default
values that point at your own machine. A key is read from `.env` or from
`data/plugin-data/<name>/`, and the README names it.

Check: `grep -rnE "/home/|/Users/|@gmail|[0-9]{8,}:[A-Za-z0-9_-]{30,}" .` finds nothing of yours.

## 3. Write the README

In the plugin root: what it does, what it needs, how to set it up, how to remove it. Two
sections are read by Iva when she proposes the install, so keep their form:

```markdown
## Keys

OPENROUTER_API_KEY

## Network

openrouter.ai, api.telegram.org
```

Names only, never values; `none` when there is nothing. Add a `LICENSE` file.

## 4. Put it in a repository of your own

```bash
cd my-plugin
git init -b main && git add -A && git commit -m "my-plugin 0.1.0"
gh repo create <you>/iva-my-plugin --public --source . --push
gh repo edit <you>/iva-my-plugin --add-topic iva-plugin
```

The topic is how people find plugins that are not on the list yet:
[github.com/topics/iva-plugin](https://github.com/topics/iva-plugin). The plugin may sit in a
subfolder of a larger repository; the entry then says which.

Check: on a machine that has never seen the folder, `iva plugin add <you>/iva-my-plugin`
installs it.

## 5. Write the entry

Fork [smixs/iva-plugins](https://github.com/smixs/iva-plugins) and change two files.

`.agents/plugins/marketplace.json` is what an installed Iva reads: the name, the source and one
line in English of at most 140 characters. The name is the `name` of your `plugin.json`. The
`sha` is the full commit you want listed.

```json
{
  "name": "my-plugin",
  "source": {
    "source": "url",
    "url": "https://github.com/<you>/iva-my-plugin",
    "sha": "<40 characters>"
  },
  "description": "What it does, in one line."
}
```

A plugin in a subfolder is `"source": "git-subdir"` with `"path": "<folder>"` beside `url`.

`cards.json` is the card the site shows at [iva-agent.com/plugins](https://iva-agent.com/plugins):

```json
"my-plugin": {
  "title": "My Plugin",
  "category": "tools",
  "author": { "name": "Your Name", "github": "<you>" },
  "repository": "https://github.com/<you>/iva-my-plugin",
  "added": "2026-11-22",
  "summary": { "en": "Two or three sentences for a person.", "ru": "Два-три предложения для человека." },
  "runs": { "en": "What starts on the machine.", "ru": "Что запускается на машине." },
  "keys": ["OPENROUTER_API_KEY"],
  "network": ["openrouter.ai"]
}
```

`category` is one of the ids at the top of `cards.json`; propose a new one in the same pull
request when none fits. `runs` says in plain words what the install starts: skills only, code
inside the agent's process, a service, an MCP server, a script that asks for `sudo`.

Check: `node scripts/check.ts` prints `ok`.

## 6. Open the pull request

One plugin, one pull request, titled `Plugin: my-plugin`. The template asks what the review
needs.

No `gh` and no fork: open the issue
[Submit a plugin](https://github.com/smixs/iva-plugins/issues/new?template=plugin.yml) with the
address of your repository, and the maintainer writes the entry.

## What the review reads

The code at the commit you named, not the description:

- what starts on the machine and with which rights;
- which keys it reads and where it connects, against `## Keys` and `## Network`;
- that nothing personal and no secret is in the repository;
- that the description says what the code does, risks included;
- that it installs on a clean Iva and survives `iva update`.

A plugin is refused when it hides what it runs, sends the owner's data somewhere the README
does not name, installs itself outside `iva plugin add`, or cannot be read: minified code,
binaries, downloads that run.

Being listed means somebody read that commit. It does not make the plugin safe for every
machine: read "What you risk" in the plugin guide before you install code.

## Update it, remove it

A new version is a pull request that moves `sha`; the review reads the difference between the
two commits. To take a plugin off the list, open a pull request or an issue.

## How installs are counted

`iva plugin add <name>` from this list tells iva-agent.com the name of the plugin, and nothing
else: no identifier of the installation, no account. The site shows the total on the card.
`IVA_PLUGIN_STATS=off` in the `.env` of an Iva turns it off.
