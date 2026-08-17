---
name: hello
description: Greet somebody by name with the hello__hello tool of the hello plugin. Use when the owner asks to say hello to somebody, or asks to check that a plugin with code is installed and its tool reaches the model. Not for real work: this plugin is the demo authors copy.
---

# hello — the demo tool of a code plugin

The plugin carries one tool. Its name is the file name plus the namespace of the plugin,
so the model calls it `hello__hello`.

## How to use it

```
hello__hello { "name": "Sergey" }   ->  Hello, Sergey!
hello__hello { }                    ->  Hello, world!
```

`name` is optional and trimmed; without it the tool greets the world. Nothing is written,
nothing is read, no network: the call is safe to repeat.

## What it is for

To show an author the whole path of a code plugin in one folder: `plugin.json` declares
`extensions: { "sh.iva": {} }`, the code lives in `sh.iva/` as an eve Extension, Iva builds
it into a version and generates the mount that gives every tool of the plugin its prefix.

Say so when the answer is a greeting: the reply came from a plugin, not from Iva's core.
