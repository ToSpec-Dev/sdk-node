import { deserializeCompiledRuleset, type CompiledRuleset } from "@tospec/redact";
import { CONFIG_PATH, INGEST_KEY_HEADER } from "../constants.js";
import { ConformanceFaultKind, type OnFault } from "./fault.js";
import { parseSampling } from "./sampler.js";
import type { CoreOptions } from "../options.js";
import type { ConformanceState } from "./state.js";
import type { ConformanceMetrics } from "./metrics.js";
import type { Transport } from "./transport.js";
import { delay, isAbortError } from "./util.js";

interface SdkConfigResponse {
  ruleset_version?: number;
  compiled?: unknown;
  sampling_rules?: Record<string, number>;
  kill_switch?: boolean;
}

/**
 * Background poller for `GET /v1/sdk/config` (ToSpec-Dev/sdk-protocol §3). Sends the
 * last ETag as `If-None-Match`; a 304 is a no-op (the near-free steady state). On
 * a 200 it atomically swaps the whole snapshot. Any error — network, garbage
 * JSON, or an unknown ruleset schema — is swallowed and the **last-good snapshot
 * is kept**. The kill switch, folded into the ETag, lands within one poll. Port
 * of `ConfigPollService.cs`.
 */
export class ConfigPoller {
  constructor(
    private readonly options: CoreOptions,
    private readonly state: ConformanceState,
    private readonly metrics: ConformanceMetrics,
    private readonly transport: Transport,
    private readonly fault: OnFault,
  ) {}

  async runLoop(signal: AbortSignal): Promise<void> {
    await this.pollOnce(signal); // immediate first poll (never blocks host startup)
    while (!signal.aborted) {
      await delay(this.options.configPollInterval, signal);
      if (signal.aborted) break;
      await this.pollOnce(signal);
    }
  }

  async pollOnce(signal: AbortSignal): Promise<void> {
    this.metrics.incConfigPoll();
    try {
      const headers: Record<string, string> = { [INGEST_KEY_HEADER]: this.options.ingestKey };
      const etag = this.state.current.etag;
      if (etag !== null) headers["If-None-Match"] = etag;

      const res = await this.transport.get(
        this.options.ingestBaseUrl + CONFIG_PATH,
        headers,
        this.options.ingestTimeout,
        signal,
      );

      if (res.status === 304) {
        this.metrics.incConfigNotModified();
        return;
      }
      if (res.status < 200 || res.status >= 300) {
        this.fault({ kind: ConformanceFaultKind.ConfigPoll, message: `config poll returned ${res.status}` });
        return;
      }

      const dto = JSON.parse(await res.text()) as SdkConfigResponse;

      // An unknown schema throws here → caught below → last-good kept.
      let ruleset: CompiledRuleset | null = null;
      if (dto.compiled != null) {
        ruleset = deserializeCompiledRuleset(JSON.stringify(dto.compiled));
      }

      const killSwitch = dto.kill_switch === true;
      this.state.update({
        ruleset,
        rulesetVersion: dto.ruleset_version ?? 0,
        sampling: parseSampling(dto.sampling_rules),
        killSwitch,
        etag: res.etag ?? this.state.current.etag,
      });
      this.metrics.setKillSwitch(killSwitch);
      this.metrics.incConfigChange();
    } catch (e) {
      if (isAbortError(e) || signal.aborted) return;
      // Keep the last-good snapshot; never apply rules we cannot fully honor.
      this.fault({ kind: ConformanceFaultKind.ConfigPoll, message: "config poll failed", error: e });
    }
  }
}
