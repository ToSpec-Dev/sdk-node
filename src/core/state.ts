import type { CompiledRuleset } from "@tospec/redact";
import { FULL_SAMPLING, type SamplingRule } from "./sampler.js";

/**
 * The current config snapshot the middleware reads on every request. Swapped
 * atomically (single reference assignment) by the config poller, so a request
 * always reads a coherent snapshot. Port of `ConformanceState.cs`.
 */
export interface ConformanceSnapshot {
  readonly ruleset: CompiledRuleset | null;
  readonly rulesetVersion: number;
  readonly sampling: SamplingRule;
  readonly killSwitch: boolean;
  readonly etag: string | null;
}

export const INITIAL_SNAPSHOT: ConformanceSnapshot = {
  ruleset: null,
  rulesetVersion: 0,
  sampling: FULL_SAMPLING,
  killSwitch: false,
  etag: null,
};

export class ConformanceState {
  private snapshot: ConformanceSnapshot;
  private readonly listeners = new Set<(snapshot: ConformanceSnapshot) => void>();

  constructor(initial: ConformanceSnapshot = INITIAL_SNAPSHOT) {
    this.snapshot = initial;
  }

  get current(): ConformanceSnapshot {
    return this.snapshot;
  }

  update(next: ConformanceSnapshot): void {
    this.snapshot = next; // single atomic reference swap
    for (const listener of this.listeners) listener(next);
  }

  subscribe(listener: (snapshot: ConformanceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
