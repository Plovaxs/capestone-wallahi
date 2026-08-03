/**
 * Classifies a euclidean descriptor distance against the match threshold
 * into three tiers instead of a single pass/fail cut. Distances just
 * under the threshold ("borderline") shouldn't be trusted off a single
 * frame — the caller should require a second confirming frame before
 * accepting a borderline match, rather than clock someone in (or reject
 * them) off one noisy reading.
 */
export function classifyMatch(distance, threshold, { borderlineMargin = 0.08 } = {}) {
    if (distance <= threshold - borderlineMargin) return 'confident-match';
    if (distance <= threshold) return 'borderline-match';
    return 'no-match';
}
