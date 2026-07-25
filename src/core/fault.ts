/**
 * Every fault the SDK swallows is routed to `onFault` — nothing throws into the
 * host request path (the "zero user-visible failures" guarantee, S5.3 §9). Port
 * of `ConformanceFault.cs`.
 */
export enum ConformanceFaultKind {
  ConfigPoll = "config_poll",
  BatchSend = "batch_send",
  Redaction = "redaction",
  Capture = "capture",
}

export interface ConformanceFault {
  readonly kind: ConformanceFaultKind;
  readonly message: string;
  readonly error?: unknown;
}

export type OnFault = (fault: ConformanceFault) => void;
