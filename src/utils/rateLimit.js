const record = new Map();

export const checkRateLimit = (key, windowMs) => {
  const now = Date.now();
  const hits = record.get(key) || [];
  const recent = hits.filter((ts) => now - ts < windowMs);
  if (recent.length >= 5) {
    const oldest = recent[0];
    const retryAfterMs = windowMs - (now - oldest);
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
  }
  record.set(key, [...recent, now]);
  return { allowed: true };
};

export const formatRateLimitMessage = (retryAfterMs) => {
  const seconds = Math.ceil((retryAfterMs || 0) / 1000);
  return `Too many requests. Please wait ${seconds}s and try again.`;
};
