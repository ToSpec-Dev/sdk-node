/**
 * Response sampling by status class (ToSpec-Dev/sdk-protocol §3 `sampling_rules`):
 * `{errors, success}` are percentages — keep `errors`% of responses with status
 * ≥ 400, `success`% of the rest. A missing field ⇒ 100%. The SDK enforces this;
 * the server does not. Port of `Sampler.cs` / `SamplingRule.cs`.
 */
export interface SamplingRule {
  readonly errors: number;
  readonly success: number;
}

export const FULL_SAMPLING: SamplingRule = { errors: 100, success: 100 };

export function parseSampling(raw: Record<string, number> | null | undefined): SamplingRule {
  if (raw == null) return FULL_SAMPLING;
  return {
    errors: typeof raw["errors"] === "number" ? raw["errors"] : 100,
    success: typeof raw["success"] === "number" ? raw["success"] : 100,
  };
}

/**
 * Deterministic-free sampling: a per-event random draw against the class
 * percentage. Injectable RNG keeps tests deterministic.
 */
export function shouldEmit(rule: SamplingRule, status: number, rng: () => number = Math.random): boolean {
  const pct = status >= 400 ? rule.errors : rule.success;
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  return rng() * 100 < pct;
}
