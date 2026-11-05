import test from "node:test";
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { registerHooks } from "node:module";

// Sources import siblings without an extension, as Vite resolves them.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith("."))
        throw error;
      return next(`${specifier}.ts`, context);
    }
  },
});

// A scripted host: setup calls answer at once, everything else goes to `host`.
const handlers = new Map();
const reported = [];
let peer;
let host = () => {};
const parent = {
  postMessage() {
    const channel = new MessageChannel();
    peer = channel.port1;
    peer.on("message", (request) => {
      const reply = (message) => peer.postMessage({ id: request.id, ...message });
      if (request.method === "preferences.read") return reply({ value: {} });
      if (request.method === "player.state")
        return reply({ value: { transport: "idle" } });
      if (request.method === "host.capabilities")
        return reply({
          value: {
            bridgeVersion: 2,
            methods: [
              "music.library",
              "radio.list",
              "podcasts.list",
              "network.profiles",
              "stats.read",
              "player.sleep",
            ],
          },
        });
      host(request, reply);
    });
    queueMicrotask(() =>
      handlers.get("message")({
        source: parent,
        data: { type: "twilight-experience-connect", bridgeVersion: 2 },
        ports: [channel.port2],
      }),
    );
  },
};
globalThis.window = {
  parent,
  addEventListener: (name, fn) => handlers.set(name, fn),
  removeEventListener: (name) => handlers.delete(name),
  dispatchEvent: (event) => reported.push(event.detail),
};
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
};
globalThis.Audio = class {
  paused = true;
  volume = 1;
  addEventListener() {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  load() {}
};
const bridge = await import("../src/host/bridge.ts");
const { TwilightMusicPlayer } = await import("../src/host/player.ts");
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("requests beyond the host limit wait in call order and all complete", async () => {
  await bridge.connectHost();
  const held = [];
  let outstanding = 0;
  let peak = 0;
  host = (request, reply) => {
    outstanding++;
    peak = Math.max(peak, outstanding);
    held.push({ n: request.args.n, reply });
  };
  const calls = Promise.allSettled(
    Array.from({ length: 30 }, (_, n) => bridge.callHost("test.slow", { n })),
  );
  await settle();
  assert.equal(held.length, 12);
  const order = [];
  while (held.length || order.length < 30) {
    const next = held.shift();
    if (!next) {
      await settle(5);
      continue;
    }
    order.push(next.n);
    outstanding--;
    if (next.n === 3) next.reply({ error: "boom" });
    else next.reply({ value: next.n * 10 });
    await settle(2);
  }
  const results = await calls;
  assert.deepEqual(order, [...Array(30).keys()]);
  assert.ok(peak <= 12, `peak ${peak}`);
  assert.equal(results[3].status, "rejected");
  assert.match(results[3].reason.message, /boom/);
  results.forEach((result, n) => {
    if (n !== 3) assert.equal(result.value, n * 10);
  });
});

test("queue notices are coalesced and a stale revision is retried quietly", async () => {
  const replies = [];
  host = (request, reply) => {
    if (request.method === "player.queue") replies.push(reply);
  };
  const player = new TwilightMusicPlayer();
  await settle();
  assert.equal(replies.length, 1);
  // Several revisions arrive while the first read is still open.
  for (let i = 0; i < 10; i++) peer.postMessage({ event: "queue" });
  await settle();
  assert.equal(replies.length, 1);
  replies[0]({ error: "Library queue changed concurrently; refresh its revision" });
  await settle(400);
  assert.equal(replies.length, 2);
  replies[1]({ value: [{ id: "a" }] });
  await settle();
  assert.deepEqual(player.state.queue, [{ id: "a" }]);
  // Notices during a successful read cause exactly one more read.
  peer.postMessage({ event: "queue" });
  await settle();
  assert.equal(replies.length, 3);
  for (let i = 0; i < 5; i++) peer.postMessage({ event: "queue" });
  await settle();
  replies[2]({ value: [{ id: "a" }, { id: "b" }] });
  await settle();
  assert.equal(replies.length, 4);
  replies[3]({ value: [{ id: "b" }] });
  await settle();
  assert.equal(replies.length, 4);
  assert.deepEqual(player.state.queue, [{ id: "b" }]);
  assert.deepEqual(reported, []);
  // Other errors are still reported.
  peer.postMessage({ event: "queue" });
  await settle();
  replies[4]({ error: "disk unavailable" });
  await settle();
  assert.deepEqual(reported, ["disk unavailable"]);
  player.dispose();
});

test("closing the page rejects sent and waiting requests", async () => {
  host = () => {};
  const calls = Promise.allSettled(
    Array.from({ length: 15 }, () => bridge.callHost("test.slow")),
  );
  await settle();
  handlers.get("pagehide")();
  const results = await calls;
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(results.filter((r) => /界面已关闭/.test(r.reason.message)).length, 12);
  assert.equal(results.filter((r) => /尚未连接/.test(r.reason.message)).length, 3);
  peer.close();
});
