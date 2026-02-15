// Local win probability estimate from score margin + time remaining.
// Uses normal CDF approximation (Φ(z)) — no API calls needed.
//
// Model: win_prob ≈ Φ(margin_for_yes / (σ * √(max(minutes_left, 0.5) / total_minutes)))
//
// σ calibrated against inpredictable.com NBA win probability calculator
// and empirical CBB data. Effective sigma is ~1.5-1.7× higher than raw
// final-margin std dev because late-game variance is amplified by:
//   - Intentional fouling (trailing team)
//   - 3-point comeback attempts
//   - Faster pace under pressure
//   - Clock management effects
//
// NBA σ=18: +10 at 5min Q4 → 95.7% (inpredictable: ~95.6%)
// CBB σ=19: +10 at 5min H2 → 93.2% (empirical: ~92-94%)

const SPORT_PARAMS = {
  nba:  { sigma: 18, total_minutes: 48 },
  cbb:  { sigma: 19, total_minutes: 40 },
};

// Rational approximation of the standard normal CDF (Abramowitz & Stegun 26.2.17)
// Max error: ~7.5e-8
function normalCdf(x) {
  if (x > 8)  return 1;
  if (x < -8) return 0;

  const neg = x < 0;
  const z = neg ? -x : x;

  const p  = 0.2316419;
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;

  const t = 1 / (1 + p * z);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;

  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * (b1 * t + b2 * t2 + b3 * t3 + b4 * t4 + b5 * t5);

  return neg ? (1 - cdf) : cdf;
}

/**
 * Estimate win probability for the "yes" side.
 *
 * @param {number} marginForYes  - score difference from perspective of yes_outcome
 *                                  (positive = yes team is ahead)
 * @param {number} minutesLeft   - minutes remaining in the game (can be 0)
 * @param {string} sport         - "nba" or "cbb"
 * @returns {number|null}        - win probability [0, 1], or null if inputs invalid
 */
export function estimateWinProb(marginForYes, minutesLeft, sport) {
  const params = SPORT_PARAMS[String(sport || "").toLowerCase()];
  if (!params) return null;

  if (typeof marginForYes !== "number" || !Number.isFinite(marginForYes)) return null;
  if (typeof minutesLeft !== "number" || !Number.isFinite(minutesLeft)) return null;
  if (minutesLeft < 0) return null;

  // Clamp minutes_left to avoid division by near-zero (smooths last-second estimates)
  const clampedMin = Math.max(minutesLeft, 0.5);
  const timeFactor = Math.sqrt(clampedMin / params.total_minutes);
  const z = marginForYes / (params.sigma * timeFactor);

  return normalCdf(z);
}

/**
 * Check whether a market passes the context entry gate.
 *
 * @param {object} opts
 * @param {string} opts.sport          - "nba" or "cbb"
 * @param {number|null} opts.period    - current period (CBB: 1=H1, 2=H2; NBA: 1-4=Q1-Q4, 5+=OT)
 * @param {number|null} opts.minutesLeft - minutes remaining in the game
 * @param {number|null} opts.marginForYes - score diff from yes_outcome perspective
 * @param {number} opts.minWinProb     - minimum win probability threshold (default 0.90)
 * @param {number} opts.maxMinutesLeft - max minutes left for entry (default 5)
 * @param {number} opts.minMargin      - minimum score margin to require (default 1)
 * @returns {{ allowed: boolean, reason: string, win_prob: number|null }}
 */
export function checkContextEntryGate(opts) {
  const {
    sport,
    period,
    minutesLeft,
    marginForYes,
    minWinProb = 0.90,
    maxMinutesLeft = 5,
    minMargin = 1,
  } = opts || {};

  // No context available
  if (period == null || minutesLeft == null || marginForYes == null) {
    return { allowed: false, reason: "no_context", win_prob: null };
  }

  const s = String(sport || "").toLowerCase();

  // Period check
  if (s === "cbb") {
    // Must be in 2nd half or OT
    if (period < 2) return { allowed: false, reason: "not_final_period", win_prob: null };
  } else if (s === "nba") {
    // Must be in Q4 or OT
    if (period < 4) return { allowed: false, reason: "not_final_period", win_prob: null };
  } else {
    return { allowed: false, reason: "unknown_sport", win_prob: null };
  }

  // Time check
  if (minutesLeft > maxMinutesLeft) {
    return { allowed: false, reason: "too_much_time_left", win_prob: null };
  }

  // Must be ahead
  if (marginForYes < minMargin) {
    return { allowed: false, reason: "not_ahead", win_prob: null };
  }

  // Win probability
  const wp = estimateWinProb(marginForYes, minutesLeft, sport);
  if (wp == null) {
    return { allowed: false, reason: "winprob_calc_error", win_prob: null };
  }

  if (wp < minWinProb) {
    return { allowed: false, reason: "winprob_below_threshold", win_prob: wp };
  }

  return { allowed: true, reason: "pass", win_prob: wp };
}
