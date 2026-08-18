// The file side: which day files count, how the tail follows the current one, and the promise
// the whole service makes — it never writes into the data directory of Iva.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Tail, listDays, currentDay, dayOf, traceDir } from "../sh.iva/services/viewer/store.ts";
import { writeFixture } from "./fixture.ts";

const NOW = Date.parse("2026-08-17T12:00:00Z");
const TODAY = dayOf(NOW);
const TOMORROW = dayOf(NOW + 86400000);

const line = (ts: number, kind: string, name: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({
    ts: new Date(ts).toISOString(),
    turn: "turn_0",
    session: "s1",
    source: "telegram",
    kind,
    name,
    data: {},
    ...extra,
  })}\n`;

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "trace-store-"));
  mkdirSync(traceDir(dir), { recursive: true });
  return dir;
}

/** Everything the data directory looks like: names, sizes, mtimes. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else {
        const info = statSync(full);
        out.push(`${prefix}${entry.name} ${info.size} ${info.mtimeMs}`);
      }
    }
  };
  walk(dir, "");
  return out;
}

test("only YYYY-MM-DD.jsonl files count as day files", () => {
  const dir = sandbox();
  try {
    const at = traceDir(dir);
    for (const name of [
      "2026-08-15.jsonl",
      "2026-08-16.jsonl",
      "2026-8-1.jsonl",
      "2026-08-17.jsonl.bak",
      "README.md",
      "notes.jsonl",
    ])
      writeFileSync(join(at, name), "");
    assert.deepEqual(listDays(at), ["2026-08-15", "2026-08-16"]);
    assert.deepEqual(listDays(join(dir, "nowhere")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the current day follows the writer, even when it is a day ahead", () => {
  const dir = sandbox();
  try {
    const at = traceDir(dir);
    assert.equal(currentDay(at, NOW), TODAY);
    writeFileSync(join(at, `${TODAY}.jsonl`), "");
    assert.equal(currentDay(at, NOW), TODAY);
    // the writer names files after the installation timezone: a file dated ahead wins
    writeFileSync(join(at, `${TOMORROW}.jsonl`), "");
    assert.equal(currentDay(at, NOW), TOMORROW);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the window is the retention window and nothing older", () => {
  const dir = sandbox();
  try {
    const at = traceDir(dir);
    for (const day of ["2026-08-01", "2026-08-03", "2026-08-04", "2026-08-16", TODAY])
      writeFileSync(join(at, `${day}.jsonl`), line(NOW, "eve", "turn.started"));
    const store = new Store({ dataDir: dir, now: () => NOW });
    // 14 days back from 2026-08-17 is 2026-08-04
    assert.deepEqual(store.window(), ["2026-08-04", "2026-08-16", TODAY]);
    assert.equal(store.events().length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tail delivers new lines and holds a half-written one", () => {
  const dir = sandbox();
  try {
    const path = join(traceDir(dir), `${TODAY}.jsonl`);
    writeFileSync(path, line(NOW, "bridge", "admitted"));
    const tail = new Tail({ dataDir: dir, now: () => NOW });
    assert.deepEqual(tail.poll().events, []); // starts at the end: no history replay

    appendFileSync(path, line(NOW + 10, "inbound", "received"));
    const first = tail.poll();
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0].event, "inbound.received");
    assert.equal(first.rollover, false);

    // half a line arrives; nothing is emitted until the newline lands
    const whole = line(NOW + 20, "eve", "turn.started");
    appendFileSync(path, whole.slice(0, 25));
    assert.deepEqual(tail.poll().events, []);
    appendFileSync(path, whole.slice(25));
    const second = tail.poll();
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].event, "eve.turn.started");

    // a broken line is skipped, its neighbours are not
    appendFileSync(path, '{"ts":"broken"\n');
    appendFileSync(path, line(NOW + 30, "outbox", "delivered"));
    const third = tail.poll();
    assert.equal(third.events.length, 1);
    assert.equal(third.events[0].event, "outbox.delivered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a multi-byte character split across two reads survives", () => {
  const dir = sandbox();
  try {
    const path = join(traceDir(dir), `${TODAY}.jsonl`);
    writeFileSync(path, "");
    const tail = new Tail({ dataDir: dir, now: () => NOW });
    const text = `${JSON.stringify({
      ts: new Date(NOW).toISOString(),
      turn: "turn_0",
      session: "s",
      source: "telegram",
      kind: "inbound",
      name: "received",
      data: { text: "привет 😀" },
    })}\n`;
    const bytes = Buffer.from(text, "utf8");
    const cut = bytes.indexOf(Buffer.from("😀", "utf8")) + 2; // inside the emoji
    const fd = openSync(path, "a");
    writeSync(fd, bytes.subarray(0, cut));
    closeSync(fd);
    assert.deepEqual(tail.poll().events, []);
    const fd2 = openSync(path, "a");
    writeSync(fd2, bytes.subarray(cut));
    closeSync(fd2);
    const events = tail.poll().events;
    assert.equal(events.length, 1);
    assert.equal(events[0].data.text, "привет 😀");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("midnight rolls the tail over to the new day file", () => {
  const dir = sandbox();
  try {
    const at = traceDir(dir);
    writeFileSync(join(at, `${TODAY}.jsonl`), line(NOW, "bridge", "admitted"));
    let clock = NOW;
    const tail = new Tail({ dataDir: dir, now: () => clock });
    appendFileSync(join(at, `${TODAY}.jsonl`), line(NOW + 5, "inbound", "received"));
    assert.equal(tail.poll().events.length, 1);

    clock = NOW + 86400000; // the clock walks into tomorrow
    const rolled = tail.poll();
    assert.equal(rolled.rollover, true);
    assert.equal(rolled.day, TOMORROW);
    assert.deepEqual(rolled.events, []); // the new file does not exist yet

    writeFileSync(join(at, `${TOMORROW}.jsonl`), line(clock, "eve", "turn.started"));
    const after = tail.poll();
    assert.equal(after.rollover, false);
    assert.equal(after.events.length, 1);
    assert.equal(after.events[0].event, "eve.turn.started");
    assert.equal(after.day, TOMORROW);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that shrank is re-read from the start instead of read as garbage", () => {
  const dir = sandbox();
  try {
    const path = join(traceDir(dir), `${TODAY}.jsonl`);
    writeFileSync(path, line(NOW, "bridge", "admitted") + line(NOW + 1, "inbound", "received"));
    const tail = new Tail({ dataDir: dir, now: () => NOW });
    assert.deepEqual(tail.poll().events, []);
    writeFileSync(path, line(NOW + 2, "outbox", "delivered")); // restored from a backup
    const events = tail.poll().events;
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "outbox.delivered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the fingerprint of the window moves only when a day file moves", () => {
  const dir = sandbox();
  try {
    const at = traceDir(dir);
    const path = join(at, `${TODAY}.jsonl`);
    writeFileSync(path, line(NOW, "bridge", "admitted"));
    const store = new Store({ dataDir: dir, now: () => NOW });
    const first = store.stamp();
    assert.notEqual(first, "");
    assert.equal(store.stamp(), first); // reading changes nothing
    store.events();
    assert.equal(store.stamp(), first);

    appendFileSync(path, line(NOW + 5, "inbound", "received")); // the file grew
    const second = store.stamp();
    assert.notEqual(second, first);

    writeFileSync(join(at, "2026-08-16.jsonl"), line(NOW - 86400000, "eve", "turn.started"));
    assert.notEqual(store.stamp(), second); // a day file appeared

    // a file outside the window is not part of the fingerprint
    const third = store.stamp();
    writeFileSync(join(at, "2026-01-01.jsonl"), line(NOW, "eve", "turn.started"));
    assert.equal(store.stamp(), third);
    assert.equal(new Store({ dataDir: join(dir, "nowhere"), now: () => NOW }).stamp(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reading the journal leaves the data directory byte for byte the same", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-ro-"));
  try {
    writeFixture(dir, NOW);
    writeFileSync(join(dir, "settings.json"), '{"captureContent":true}\n');
    const before = snapshot(dir);
    const store = new Store({ dataDir: dir, now: () => NOW });
    store.events();
    store.window();
    store.events();
    const tail = new Tail({ dataDir: dir, now: () => NOW, fromStart: true });
    tail.poll();
    tail.poll();
    assert.deepEqual(snapshot(dir), before);
    // and nothing new appeared, not even an empty trace directory somewhere else
    assert.deepEqual(readdirSync(dir).sort(), ["settings.json", "trace"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing data directory reads as an empty journal", () => {
  const dir = join(tmpdir(), `trace-absent-${Date.now()}`);
  const store = new Store({ dataDir: dir, now: () => NOW });
  assert.deepEqual(store.window(), []);
  assert.deepEqual(store.events(), []);
  const tail = new Tail({ dataDir: dir, now: () => NOW });
  assert.deepEqual(tail.poll().events, []);
  assert.equal(statSync(dir, { throwIfNoEntry: false }), undefined); // it was not created
});
