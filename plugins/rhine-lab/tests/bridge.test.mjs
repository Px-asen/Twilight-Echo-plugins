import test from "node:test";
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
const handlers = new Map();
let peer;
let saved = {
  legacyPreference: "keep-me",
  localPreferences: { theme: "night" },
};
let writes = 0;
const parent = {
  postMessage(message) {
    assert.equal(message.bridgeVersion, 2);
    const channel = new MessageChannel();
    peer = channel.port1;
    peer.on("message", (request) => {
      let value = null;
      if (request.method === "preferences.read") value = saved;
      if (request.method === "preferences.write") {
        saved = request.args.value;
        writes++;
      }
      if (request.method === "player.state")
        value = { transport: "playing", currentTime: 42 };
      if (request.method === "host.capabilities")
        value = {
          bridgeVersion: 2,
          methods: [
            "music.library",
            "radio.list",
            "podcasts.list",
            "network.profiles",
            "stats.read",
            "player.sleep",
          ],
        };
      peer.postMessage({ id: request.id, value });
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
  dispatchEvent: () => {},
};
const bridge = await import("../src/host/bridge.ts");
test("v2 handshake preserves playback and old preferences; events and disposal are bounded", async () => {
  await bridge.connectHost();
  assert.equal(bridge.initialPlayer.currentTime, 42);
  assert.equal(bridge.preferenceGet("theme"), "night");
  bridge.preferenceSet("theme", "day");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(saved.legacyPreference, "keep-me");
  assert.equal(saved.localPreferences.theme, "day");
  assert.equal(writes, 1);
  let events = 0;
  const stop = bridge.onHost("player", () => events++);
  peer.postMessage({ event: "player", value: { currentTime: 43 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events, 1);
  stop();
  peer.postMessage({ event: "player", value: { currentTime: 44 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events, 1);
  handlers.get("pagehide")();
  peer.close();
  await assert.rejects(() => bridge.callHost("player.state"), /尚未连接/);
});
