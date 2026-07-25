/**
 * Lock-free-equivalent counters (single-threaded JS, so plain integers) exported
 * via `snapshot()`. The host reads these to observe SDK health. Port of
 * `ConformanceMetrics.cs`.
 */
export interface ConformanceMetricsSnapshot {
  eventsCaptured: number;
  eventsSampledOut: number;
  eventsDroppedQueueFull: number;
  batchesSent: number;
  batchesFailed: number;
  eventsIngested: number;
  redactionFailures: number;
  configPolls: number;
  configChanges: number;
  configNotModified: number;
  killSwitchActive: boolean;
}

export class ConformanceMetrics {
  private eventsCaptured = 0;
  private eventsSampledOut = 0;
  private eventsDroppedQueueFull = 0;
  private batchesSent = 0;
  private batchesFailed = 0;
  private eventsIngested = 0;
  private redactionFailures = 0;
  private configPolls = 0;
  private configChanges = 0;
  private configNotModified = 0;
  private killSwitchActive = false;

  incCaptured(): void {
    this.eventsCaptured++;
  }
  incSampledOut(): void {
    this.eventsSampledOut++;
  }
  incDroppedQueueFull(): void {
    this.eventsDroppedQueueFull++;
  }
  incBatchSent(count: number): void {
    this.batchesSent++;
    this.eventsIngested += count;
  }
  incBatchFailed(): void {
    this.batchesFailed++;
  }
  incRedactionFailure(): void {
    this.redactionFailures++;
  }
  incConfigPoll(): void {
    this.configPolls++;
  }
  incConfigChange(): void {
    this.configChanges++;
  }
  incConfigNotModified(): void {
    this.configNotModified++;
  }
  setKillSwitch(active: boolean): void {
    this.killSwitchActive = active;
  }

  snapshot(): ConformanceMetricsSnapshot {
    return {
      eventsCaptured: this.eventsCaptured,
      eventsSampledOut: this.eventsSampledOut,
      eventsDroppedQueueFull: this.eventsDroppedQueueFull,
      batchesSent: this.batchesSent,
      batchesFailed: this.batchesFailed,
      eventsIngested: this.eventsIngested,
      redactionFailures: this.redactionFailures,
      configPolls: this.configPolls,
      configChanges: this.configChanges,
      configNotModified: this.configNotModified,
      killSwitchActive: this.killSwitchActive,
    };
  }
}
