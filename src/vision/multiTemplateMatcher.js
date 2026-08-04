const DESCRIPTOR_LENGTH = 128;

/**
 * Normalizes whatever shape is stored in profiles.face_descriptor into a
 * flat array of templates (each a 128-number array) — no schema change
 * needed, the column already stores arbitrary JSON text. Handles both:
 *  - legacy single-template enrollment: a flat array of 128 numbers
 *  - multi-angle enrollment: an array of several 128-number arrays
 * so accounts enrolled before multi-angle capture existed keep working
 * unchanged.
 */
export function normalizeStoredTemplates(parsed) {
    if (!parsed) return [];

    const raw = Array.isArray(parsed) ? parsed : parsed.data;
    if (!Array.isArray(raw) || raw.length === 0) return [];

    const isMultiTemplate = Array.isArray(raw[0]);
    const templates = isMultiTemplate ? raw : [raw];

    return templates
        .map((t) => (Array.isArray(t) ? t.map(Number) : null))
        .filter((t) => t && t.length === DESCRIPTOR_LENGTH && t.every(Number.isFinite));
}

/**
 * Compares a live descriptor against every stored template and returns
 * the best (lowest-distance) match — the standard multi-template
 * matching approach: a person's face doesn't look identical every day
 * (lighting, angle, expression), so matching against several reference
 * angles captured at enrollment is meaningfully more robust than a
 * single frontal snapshot.
 */
export function matchAgainstTemplates(liveDescriptor, templates, euclideanDistanceFn) {
    if (!templates || templates.length === 0) return { distance: Infinity, templateIndex: -1 };

    let bestDistance = Infinity;
    let bestIndex = -1;

    templates.forEach((template, index) => {
        const distance = euclideanDistanceFn(liveDescriptor, template);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    });

    return { distance: bestDistance, templateIndex: bestIndex };
}
