---
name: trace
description: Read the Trace journal of a turn and open the viewer. Use when the owner asks what happened in a turn, why an answer was late or missing, what the Gate said, what the model called, how many tokens a turn cost, or asks to see or open the trace, the viewer, the turn journal, the schema, the replay. Also use before answering "why did you do that" about a past turn, and when the owner asks to turn the content of the journal off. Not for service logs (journalctl) and not for memory questions (that is the Vault).
---

# trace — the turn journal and its viewer

The core writes one JSONL line per event of a turn, from the update the Bridge accepts to the
answer the Outbox delivers. The journal is the contract; this plugin only reads it.

Contract: `docs/trace.md` in the Iva repo. Terms: `CONTEXT.md`.

## Where the journal is

```
<data>/trace/YYYY-MM-DD.jsonl      one line per event, append-only, 14 days
```

`<data>` is the data directory of the installation (`ASSISTANT_DATA_DIR`, `./data` by
default). Two processes append to one file: the agent and the Bridge.

## How to read it in the terminal

```bash
iva trace tail                  # live text of the events
iva trace show <turn>           # one turn, from Bridge to Outbox
iva trace open                  # prints the ssh -N -L line and the URL of the viewer
```

By hand, when `iva` is not at hand:

```bash
jq -c 'select(.turn=="turn_7")' data/trace/$(date +%F).jsonl      # one turn
jq -c 'select(.kind=="gate")' data/trace/$(date +%F).jsonl        # every verdict of the day
tail -f data/trace/$(date +%F).jsonl | jq -c '[.ts,.kind+"."+.name]'
```

Each line has exactly seven fields: `ts` (UTC), `turn`, `session`, `source`, `kind`, `name`,
`data`. Sort by `ts` — line order is write order, not turn order.

**Three key spaces of `turn`.** Before the turn exists it is the update key
`tg:<chatId>:<messageId>`; after it starts it is the Eve turnId (`turn_3`, and `turn_3#planner`
for a subagent step); a night turn (Rollup, digest, cron) has no turn key at all — its seam
lines carry an empty `turn` with a session and a source. To stitch a chat turn take
`turn.bound` and collect both keys; to stitch a night turn group by session.

## How to open the viewer

The viewer is a separate service on loopback. Nothing is exposed: the way in is an SSH tunnel.

```bash
iva trace open                                     # prints both lines below
ssh -N -L 8726:127.0.0.1:8726 <user>@<host>        # on the laptop
open http://127.0.0.1:8726                         # then this
```

The page has no input field: you write in Telegram and watch here. It shows equal tiles for
the period (today / 7 / 14 days), the schema of Iva with the nodes and edges lighting up as
events arrive, the list of turns for 14 days, the event feed of the selected turn as chips,
and a Replay button that plays a turn again at real intervals with ×1/×2/×4. Keys: `j`/`k`
move between turns, `r` replays, space pauses.

When the agent is restarting the viewer stays up and says so in the status line — the journal
is a file, not a service.

Run it by hand (no rails, no systemd):

```bash
IVA_SERVICE_PORT=8726 IVA_DATA_DIR=/path/to/data node server.mjs
```

## The content toggle

`data/settings.json`:

```json
{ "captureContent": false }
```

On by default. Turned off, the journal keeps names, timings and sizes — the turn stays fully
visible, only without text. Every content field is capped at 2000 characters anyway, and a
line never exceeds 16 KB: an event that does not fit loses its content and is marked
`data.traceTrimmed: true`.

With content off the viewer still shows every step, every tool call and every verdict; only
the texts and the "cards found" number go missing.

## What the journal does not contain

- **Delta events** (`message.appended`, `reasoning.appended`, `action.partial`). The final
  text arrives in `*.completed`.
- **Eve's own context composition.** CORE, PERSONA and the current time are injected by
  dynamic instructions that cannot report from inside. `context.parts` gives the size of
  those files on disk at the start of the turn, and says so with `approximate: true`.
- **Gate verdicts outside a turn.** A verdict with no turn has nothing to attach to, so it is
  not written. The in-process turn mark expires after 60 seconds: if media handling takes
  longer than a minute, the verdict after it is not journaled.
- **Callback updates** (`⏹ Stop`, `/menu` buttons) reach the Bridge only, so those
  `bridge.*` lines stay orphans with no `turn.bound` and no `inbound.*`.
- **Anything older than 14 days.** Pruning goes by the date in the file name, never by mtime.
- **Secrets that the outbound Gate removed.** `gate.outbound` holds the text after redaction,
  and findings are named (`type:name`) without a preview.

## Reading a turn out loud

A healthy chat turn looks like this, in order:

```
bridge.admitted → inbound.received → gate.inbound → inbound.accepted → turn.bound
context.parts → eve.turn.started → eve.step.started → eve.actions.requested
eve.action.result → eve.step.completed → … → eve.message.completed
eve.turn.completed → gate.outbound → outbox.delivered → bridge.delivered
```

Useful reflexes:

- No `inbound.*` after `bridge.admitted` — the update was a callback or the allowlist refused it.
- `gate.inbound` with `blocked: true` — the input never became a turn; the reply is a service
  message, which is why a `gate.outbound` line stands there alone.
- `gate.outbound` without `outbox.*` — a service reply of the channel, not the answer of the turn.
- `eve.action.result` with `isError: true` — the tool failed, the turn usually goes on.
- `outbox.failed` — the answer existed and did not reach Telegram.
