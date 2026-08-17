// The service over HTTP: the four JSON routes, the SSE stream, the loopback promise and the
// read-only promise. Every case runs against a fixture journal in a temporary directory.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { createViewer, probeAgent, agentHealthUrl } from "../sh.iva/services/viewer/server.mjs";
import { writeFixture, fixturePlan } from "./fixture.mjs";
import { traceDir, dayOf } from "../sh.iva/services/viewer/store.mjs";

const NOW = Date.parse("2026-08-17T12:00:00Z");
const TODAY = dayOf(NOW);
const PLAN = fixturePlan(NOW);
const TURNS = PLAN.chat.length + PLAN.night.length;

function snapshot(dir) {
  const out = [];
  const walk = (at, prefix) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name} ${statSync(full).size} ${statSync(full).mtimeMs}`);
    }
  };
  walk(dir, "");
  return out;
}

/** A viewer on a temporary journal, bound to a free loopback port. */
async function serve({ probe, env } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trace-http-"));
  writeFixture(dir, NOW);
  const viewer = createViewer({
    dataDir: dir,
    now: () => NOW,
    probe: probe ?? (async () => ({ agent: "alive", status: 200 })),
    env: env ?? {},
  });
  await new Promise((resolve) => viewer.server.listen(0, "127.0.0.1", resolve));
  const { port, address } = viewer.server.address();
  return {
    dir,
    port,
    address,
    viewer,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    async json(path) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, body: await res.json() };
    },
    async close() {
      await new Promise((resolve) => viewer.server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("the service listens on loopback only", async () => {
  const app = await serve();
  try {
    assert.equal(app.address, "127.0.0.1");
    const external = Object.values(networkInterfaces())
      .flat()
      .find((nic) => nic !== undefined && nic.family === "IPv4" && !nic.internal);
    if (external === undefined) return; // no other address on this host, nothing to prove
    await assert.rejects(
      fetch(`http://${external.address}:${app.port}/api/turns`, {
        signal: AbortSignal.timeout(2500),
      }),
      (error) => {
        const code = error?.cause?.code ?? error?.code ?? error?.name;
        return code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "TimeoutError";
      },
    );
  } finally {
    await app.close();
  }
});

test("a request for another host name is refused", async () => {
  const app = await serve();
  // fetch() refuses to set Host, so this one goes over node:http on purpose
  const ask = (host) =>
    new Promise((resolve, reject) => {
      const request = get(
        { host: "127.0.0.1", port: app.port, path: "/api/turns", headers: { host } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      request.on("error", reject);
    });
  try {
    assert.equal(await ask("trace.example.com"), 403);
    assert.equal(await ask(`localhost:${app.port}`), 200);
    assert.equal(await ask(`127.0.0.1:${app.port}`), 200);
  } finally {
    await app.close();
  }
});

test("only GET and HEAD are served", async () => {
  const app = await serve();
  try {
    const res = await fetch(app.url("/api/turns"), { method: "POST" });
    assert.equal(res.status, 405);
    const head = await fetch(app.url("/"), { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.match(head.headers.get("content-type"), /text\/html/u);
  } finally {
    await app.close();
  }
});

test("the page comes back as one HTML file", async () => {
  const app = await serve();
  try {
    const res = await fetch(app.url("/"));
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /<title>Trace — Iva<\/title>/u);
    assert.match(text, /overscroll-behavior-y: none/u);
    assert.doesNotMatch(text, /<script src=|https?:\/\/(?!www\.w3\.org)/u); // no build, no CDN
  } finally {
    await app.close();
  }
});

test("the turns route stitches the fixture and hides nothing", async () => {
  const app = await serve();
  try {
    const { status, body } = await app.json("/api/turns");
    assert.equal(status, 200);
    assert.equal(body.turns.length, TURNS);
    assert.equal(body.unattached, 1);
    assert.equal(body.today, TODAY);
    assert.equal(body.days.length, 14); // the whole retention window
    // newest first, and the payload of a summary stays a summary
    assert.ok(body.turns[0].at >= body.turns[1].at);
    assert.equal(body.turns[0].events, undefined);
    assert.ok(body.turns.some((turn) => turn.kind === "night"));
  } finally {
    await app.close();
  }
});

test("one turn comes back with its events in time order", async () => {
  const app = await serve();
  try {
    const list = await app.json("/api/turns");
    const target = list.body.turns.find((turn) => turn.counts.subagents > 0);
    const { status, body } = await app.json(`/api/turn?id=${encodeURIComponent(target.id)}`);
    assert.equal(status, 200);
    assert.equal(body.turn.id, target.id);
    assert.equal(body.events.length, target.counts.events);
    const times = body.events.map((event) => Date.parse(event.ts));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    assert.ok(body.events.every((event) => Array.isArray(event.nodes)));
    assert.ok(body.events.some((event) => event.depth === 1 && event.subagent === "planner"));

    const missing = await app.json("/api/turn?id=nope");
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});

test("the tiles route answers for the three periods and refuses the rest", async () => {
  const app = await serve();
  try {
    const today = await app.json("/api/stats?days=1");
    assert.equal(today.body.period, 1);
    assert.equal(today.body.from, TODAY);
    const week = await app.json("/api/stats?days=7");
    assert.equal(week.body.period, 7);
    const all = await app.json("/api/stats?days=14");
    assert.equal(all.body.turns, TURNS);
    assert.ok(all.body.nodes.model > 0);
    assert.ok(week.body.turns < all.body.turns); // the periods really differ on this journal
    // an unknown period falls back to today instead of inventing one
    const odd = await app.json("/api/stats?days=999");
    assert.equal(odd.body.period, 1);
    const missing = await app.json("/api/stats");
    assert.equal(missing.body.period, 1);
  } finally {
    await app.close();
  }
});

test("the status route says whether the agent answers", async () => {
  const alive = await serve({ probe: async () => ({ agent: "alive", status: 200 }) });
  try {
    const { body } = await alive.json("/api/status");
    assert.equal(body.agent, "alive");
    assert.equal(body.day, TODAY);
    assert.equal(body.path, join(traceDir(alive.dir), `${TODAY}.jsonl`));
    assert.ok(body.bytes > 0);
  } finally {
    await alive.close();
  }

  const down = await serve({ probe: async () => ({ agent: "unreachable", status: 0 }) });
  try {
    const { body } = await down.json("/api/status");
    assert.equal(body.agent, "unreachable");
  } finally {
    await down.close();
  }
});

test("the health probe reads a refused connection as a restarting agent", async () => {
  const refused = await probeAgent("http://127.0.0.1:8799/eve/v1/health");
  assert.equal(refused.agent, "unreachable");
  // a request that never even leaves (a blocked port) is not a verdict about the agent
  const blocked = await probeAgent("http://127.0.0.1:1/eve/v1/health");
  assert.equal(blocked.agent, "unknown");
  // any HTTP answer means the process listens, even when it says no
  const answered = await probeAgent("http://127.0.0.1:1/eve/v1/health", async () => ({
    status: 401,
  }));
  assert.equal(answered.agent, "alive");
  const strange = await probeAgent("http://127.0.0.1:1/eve/v1/health", async () => {
    throw new Error("something else");
  });
  assert.equal(strange.agent, "unknown");
  assert.equal(agentHealthUrl({}), "http://127.0.0.1:8723/eve/v1/health");
  assert.equal(agentHealthUrl({ IVA_PORT: "9001" }), "http://127.0.0.1:9001/eve/v1/health");
});

test("the stream delivers a line appended after the client connected", async () => {
  const app = await serve();
  try {
    const frames = [];
    const request = get(app.url("/api/stream"), (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => frames.push(chunk));
    });
    const waitFor = async (match, timeoutMs) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const text = frames.join("");
        if (match(text)) return text;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    };
    const hello = await waitFor((text) => text.includes("event: hello"), 3000);
    assert.ok(hello !== null, "no hello frame");
    assert.match(hello, /"day":"2026-08-17"/u);

    appendFileSync(
      join(traceDir(app.dir), `${TODAY}.jsonl`),
      `${JSON.stringify({
        ts: new Date(NOW).toISOString(),
        turn: "tg:88123456:6001",
        session: "",
        source: "bridge",
        kind: "bridge",
        name: "admitted",
        data: { chatId: 88123456, messageId: 6001, kind: "message", decision: "owned" },
      })}\n`,
    );
    // a broken line right behind it must not stop the stream
    appendFileSync(join(traceDir(app.dir), `${TODAY}.jsonl`), '{"ts":"half\n');
    const line = await waitFor((text) => text.includes("event: line"), 4000);
    assert.ok(line !== null, "no line frame");
    const payload = JSON.parse(/event: line\ndata: (.*)\n/u.exec(line)[1]);
    assert.equal(payload.event, "bridge.admitted");
    assert.deepEqual(payload.nodes, ["bridge", "telegram_in"]);
    request.destroy();
  } finally {
    await app.close();
  }
});

test("serving every route writes nothing into the data directory", async () => {
  const app = await serve();
  try {
    const before = snapshot(app.dir);
    const list = await app.json("/api/turns");
    await app.json(`/api/turn?id=${encodeURIComponent(list.body.turns[0].id)}`);
    await app.json("/api/stats?days=14");
    await app.json("/api/status");
    await fetch(app.url("/"));
    await fetch(app.url("/nope"));
    const request = get(app.url("/api/stream"), (res) => res.resume());
    await new Promise((resolve) => setTimeout(resolve, 1200));
    request.destroy();
    assert.deepEqual(snapshot(app.dir), before);
  } finally {
    await app.close();
  }
});

test("the stitched window is kept until a day file moves", async () => {
  const app = await serve();
  try {
    const first = app.viewer.model();
    // Nothing moved, so the second call must be the very same work, not the same numbers again.
    assert.equal(app.viewer.model(), first);
    const stats = app.viewer.stats(14, TODAY);
    assert.equal(app.viewer.stats(14, TODAY), stats);
    assert.notEqual(app.viewer.stats(7, TODAY), stats); // a different period is its own answer

    appendFileSync(
      join(traceDir(app.dir), `${TODAY}.jsonl`),
      `${JSON.stringify({
        ts: new Date(NOW).toISOString(),
        turn: "tg:88123456:6100",
        session: "",
        source: "bridge",
        kind: "bridge",
        name: "admitted",
        data: { chatId: 88123456, messageId: 6100, kind: "message", decision: "owned" },
      })}\n`,
    );
    const second = app.viewer.model();
    assert.notEqual(second, first); // the line landed: the window was stitched again
    assert.equal(second.turns.length, first.turns.length + 1);
    assert.equal(app.viewer.stats(14, TODAY).turns, TURNS + 1);
    // and the route agrees with it
    const { body } = await app.json("/api/turns");
    assert.equal(body.turns.length, TURNS + 1);
  } finally {
    await app.close();
  }
});

test("an unknown route is a plain 404", async () => {
  const app = await serve();
  try {
    const { status, body } = await app.json("/api/whatever");
    assert.equal(status, 404);
    assert.equal(body.error, "no such route");
  } finally {
    await app.close();
  }
});
