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
  // Soccer uses Poisson model (not normal CDF) — see soccerWinProb()
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

// ────────────────────────────────────────────────────────────────
// Soccer: Poisson-based win probability
// ────────────────────────────────────────────────────────────────
// Goals are rare discrete events (~1.35/team/90min in top 5 leagues).
// We model "P(rival scores >= margin goals in remaining minutes)"
// using a Poisson distribution.
//
// λ = GOAL_RATE × minutesLeft × (INJURY_TIME_MULTIPLIER if min ≤ 5)
//
// P(catch up) = Σ Poisson(k, λ) for k = margin to margin + MAX_K_OFFSET
// win_prob = 1 - P(catch up)

const SOCCER_PARAMS = {
  goal_rate: 0.015,               // goals/minute/team (~1.35 per 90 min, top 5 leagues avg)
  injury_time_multiplier: 1.5,    // last 5 min have ~50% more goals (pressure, fatigue, desperation)
  injury_time_threshold_min: 5,   // apply multiplier when minutes_left <= this
  max_k_offset: 6,               // sum Poisson PMF from margin to margin + this
};

function logFactorial(n) {
  if (n <= 1) return 0;
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
}

function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - logFactorial(k));
}

/**
 * Estimate win probability for soccer using Poisson model.
 *
 * @param {number} marginForYes  - goal difference (positive = yes team ahead)
 * @param {number} minutesLeft   - minutes remaining (0 = injury time, negative = not valid)
 * @returns {number|null}        - win probability [0, 1], or null if inputs invalid
 */
export function soccerWinProb(marginForYes, minutesLeft) {
  if (typeof marginForYes !== "number" || !Number.isFinite(marginForYes)) return null;
  if (typeof minutesLeft !== "number" || !Number.isFinite(minutesLeft)) return null;
  if (minutesLeft < 0) return null;

  // Not ahead → null (we don't trade losing/tied positions)
  if (marginForYes <= 0) return null;

  const p = SOCCER_PARAMS;

  // λ = expected goals for the rival in remaining time
  let lambda = p.goal_rate * Math.max(minutesLeft, 0.5); // clamp to avoid 0
  if (minutesLeft <= p.injury_time_threshold_min) {
    lambda *= p.injury_time_multiplier;
  }

  // P(rival scores >= margin goals) = catch-up probability
  // In a "Team A wins" market, both draw and loss = lose the bet
  // So rival needs to score >= margin goals to ruin us
  let pCatchUp = 0;
  const kMax = marginForYes + p.max_k_offset;
  for (let k = marginForYes; k <= kMax; k++) {
    pCatchUp += poissonPmf(k, lambda);
  }

  return 1 - pCatchUp;
}

/**
 * Check soccer context entry gate (BLOQUEANTE, not tag-only).
 *
 * @param {object} opts
 * @param {number|null} opts.period           - 1 or 2 (half)
 * @param {number|null} opts.minutesLeft      - minutes remaining in game
 * @param {number|null} opts.marginForYes     - goal difference from yes_outcome perspective
 * @param {string}      opts.confidence       - "high" or "low" (minutes_left reliability)
 * @param {number}      opts.lastScoreChangeAgoSec - seconds since last score change (for stability)
 * @param {number}      opts.minWinProbMargin2 - win_prob threshold for margin=2 (default 0.97)
 * @param {number}      opts.minWinProbMargin3 - win_prob threshold for margin>=3 (default 0.95)
 * @param {number}      opts.maxMinutesMargin2 - max minutes for margin=2 entry (default 15)
 * @param {number}      opts.maxMinutesMargin3 - max minutes for margin>=3 entry (default 20)
 * @param {number}      opts.scoreChangeCooldownSec - cooldown after score change (default 90)
 * @returns {{ allowed: boolean, reason: string, win_prob: number|null }}
 */
export function checkSoccerEntryGate(opts) {
  const {
    period,
    minutesLeft,
    marginForYes,
    confidence = "low",
    lastScoreChangeAgoSec = null,
    minWinProbMargin2 = 0.97,
    minWinProbMargin3 = 0.95,
    maxMinutesMargin2 = 15,
    maxMinutesMargin3 = 20,
    scoreChangeCooldownSec = 90,
  } = opts || {};

  // No context available
  if (period == null || minutesLeft == null || marginForYes == null) {
    return { allowed: false, reason: "no_context", win_prob: null };
  }

  // Confidence check — must be "high" for soccer
  if (confidence !== "high") {
    return { allowed: false, reason: "low_confidence", win_prob: null };
  }

  // Must be in 2nd half (period 2). Block halftime, extra time (period > 2), 1st half.
  if (period !== 2) {
    return { allowed: false, reason: period === 1 ? "first_half" : "extra_time_or_invalid", win_prob: null };
  }

  // Margin >= 2 mandatory (1-goal leads are too risky)
  if (marginForYes < 2) {
    return { allowed: false, reason: "margin_too_small", win_prob: null };
  }

  // Score change cooldown (VAR / goal reversal protection)
  if (lastScoreChangeAgoSec != null && lastScoreChangeAgoSec < scoreChangeCooldownSec) {
    return { allowed: false, reason: "score_change_cooldown", win_prob: null };
  }

  // Time windows by margin
  const isMargin2 = marginForYes === 2;
  const maxMin = isMargin2 ? maxMinutesMargin2 : maxMinutesMargin3;
  const minWP = isMargin2 ? minWinProbMargin2 : minWinProbMargin3;

  if (minutesLeft > maxMin) {
    return { allowed: false, reason: "too_much_time_left", win_prob: null };
  }

  // Win probability (Poisson)
  const wp = soccerWinProb(marginForYes, minutesLeft);
  if (wp == null) {
    return { allowed: false, reason: "winprob_calc_error", win_prob: null };
  }

  if (wp < minWP) {
    return { allowed: false, reason: "winprob_below_threshold", win_prob: wp };
  }

  return { allowed: true, reason: "pass", win_prob: wp };
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
  if (s === "cbb" || s === "cwbb") {
    // Must be in 2nd half or OT
    if (period < 2) return { allowed: false, reason: "not_final_period", win_prob: null };
  } else if (s === "nba") {
    // Must be in Q4 or OT
    if (period < 4) return { allowed: false, reason: "not_final_period", win_prob: null };
  } else if (s === "soccer") {
    // Delegate to soccer-specific gate (BLOQUEANTE)
    return checkSoccerEntryGate(opts);
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
