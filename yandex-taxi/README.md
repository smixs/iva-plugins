# yandex-taxi

Iva orders Yandex Taxi in a browser from the owner's account: she quotes the price, picks the
tariff and the card, places the order and watches where the car is. Nothing is ordered without
an explicit "yes".

A skills-only plugin: no code inside the agent's process, no MCP. It installs without a restart.

```bash
iva plugin add yandex-taxi
```

Then say «такси до …» in Telegram. The first run walks through the setup: the browser, the QR
login, the card and the saved places.

## Keys

none

## Network

taxi.yandex.uz

The host is the default; another country site of Yandex Taxi is one line in the owner's
`~/.config/yandex-taxi-skill/config.env`. Personal data lives only in that file and in the
browser session, never in the plugin folder.

## Where it comes from

The skill is [smixs/yandex-taxi-skill](https://github.com/smixs/yandex-taxi-skill) 1.1.0, MIT.
That repository also carries the adapters for Claude Code and Codex.
