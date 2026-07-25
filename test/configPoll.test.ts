import { describe, it, expect } from "vitest";
import { serializeCompiledRuleset, compileRuleset } from "@tospec/redact";
import { ConfigPoller } from "../src/core/configPoll.js";
import { ConformanceState } from "../src/core/state.js";
import { ConformanceMetrics } from "../src/core/metrics.js";
import { resolveOptions } from "../src/options.js";
import type { Transport, TransportResponse } from "../src/core/transport.js";
import { testOptions } from "./support.js";

/** Programmable transport for the poller: get() returns queued responses in order. */
class QueuedTransport implements Transport {
  queue: TransportResponse[] = [];
  lastGetHeaders: Record<string, string> = {};
  async post(): Promise<TransportResponse> {
    throw new Error("not used");
  }
  async get(_url: string, headers: Record<string, string>): Promise<TransportResponse> {
    this.lastGetHeaders = headers;
    return this.queue.shift() ?? { status: 304, etag: null, text: async () => "" };
  }
}

function compiledJson(yaml: string): unknown {
  const c = compileRuleset(yaml);
  return JSON.parse(serializeCompiledRuleset(c.ruleset!));
}

function makePoller(transport: Transport): {
  poller: ConfigPoller;
  state: ConformanceState;
  metrics: ConformanceMetrics;
} {
  const o = resolveOptions(testOptions());
  const state = new ConformanceState();
  const metrics = new ConformanceMetrics();
  const poller = new ConfigPoller(o, state, metrics, transport, () => {});
  return { poller, state, metrics };
}

const never = new AbortController().signal;

describe("ConfigPoller", () => {
  it("200 loads the ruleset, version, and ETag", async () => {
    const t = new QueuedTransport();
    t.queue.push({
      status: 200,
      etag: '"v1"',
      text: async () =>
        JSON.stringify({
          ruleset_version: 5,
          compiled: compiledJson('body:\n  - { path: "$.a", action: hash }\n'),
          sampling_rules: { errors: 100, success: 5 },
          kill_switch: false,
        }),
    });
    const { poller, state } = makePoller(t);
    await poller.pollOnce(never);
    expect(state.current.ruleset).not.toBeNull();
    expect(state.current.rulesetVersion).toBe(5);
    expect(state.current.etag).toBe('"v1"');
    expect(state.current.sampling.success).toBe(5);
  });

  it("sends If-None-Match and treats 304 as unchanged", async () => {
    const t = new QueuedTransport();
    t.queue.push({ status: 200, etag: '"v1"', text: async () => JSON.stringify({ ruleset_version: 1 }) });
    t.queue.push({ status: 304, etag: '"v1"', text: async () => "" });
    const { poller, state, metrics } = makePoller(t);
    await poller.pollOnce(never);
    await poller.pollOnce(never);
    expect(t.lastGetHeaders["If-None-Match"]).toBe('"v1"');
    expect(metrics.snapshot().configNotModified).toBe(1);
    expect(state.current.rulesetVersion).toBe(1);
  });

  it("refuses an unknown ruleset schema and keeps the last-good snapshot", async () => {
    const t = new QueuedTransport();
    t.queue.push({
      status: 200,
      etag: '"v1"',
      text: async () =>
        JSON.stringify({ ruleset_version: 1, compiled: compiledJson('body:\n  - { path: "$.a", action: hash }\n') }),
    });
    t.queue.push({
      status: 200,
      etag: '"v2"',
      text: async () => JSON.stringify({ ruleset_version: 2, compiled: { schema: 999, trie: {} } }),
    });
    const { poller, state } = makePoller(t);
    await poller.pollOnce(never);
    await poller.pollOnce(never);
    // The bad-schema poll is rejected; version stays at the last-good 1.
    expect(state.current.rulesetVersion).toBe(1);
    expect(state.current.ruleset).not.toBeNull();
  });

  it("kill switch in a 200 lands on the snapshot", async () => {
    const t = new QueuedTransport();
    t.queue.push({
      status: 200,
      etag: '"v1"',
      text: async () => JSON.stringify({ ruleset_version: 1, kill_switch: true }),
    });
    const { poller, state, metrics } = makePoller(t);
    await poller.pollOnce(never);
    expect(state.current.killSwitch).toBe(true);
    expect(metrics.snapshot().killSwitchActive).toBe(true);
  });
});
