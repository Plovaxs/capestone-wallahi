import { supabase } from '../supabaseClient';
import { getBucket } from './tokenBucket';

/**
 Server-side rate limit check. Atomic, keyed by the caller's verified
 auth.uid() (read inside the Postgres function, not passed by the
 client), so it can't be bypassed by clearing local state or supplying
 a different key.

 A client-side token bucket runs first purely as a pre-throttle: it gives
 instant feedback and skips the network round trip when the user is
 obviously over the limit (e.g. mashing a button), but it is NOT the
 security boundary — it's trivially bypassable client-side. The server RPC
 below still runs on every call that passes the bucket and remains the
 sole authoritative check.
 */
export const checkRateLimit = async (action, { maxRequests = 5, windowSeconds = 30 } = {}) => {
  const bucket = getBucket(action, { capacity: maxRequests, refillRatePerSec: maxRequests / windowSeconds });
  if (!bucket.tryConsume()) {
    return { allowed: false, retryAfterMs: bucket.msUntilNextToken() };
  }

  const { data, error } = await supabase.rpc('check_rate_limit', {
    p_action: action,
    p_max_requests: maxRequests,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    console.error('Rate limit check failed:', error.message);
    // Fail closed: if we can't verify the limit server-side, block the
    // action rather than silently letting it through.
    return { allowed: false, retryAfterMs: windowSeconds * 1000, error: true };
  }

  return { allowed: data.allowed, retryAfterMs: data.retry_after_ms ?? 0 };
};

export const formatRateLimitMessage = (retryAfterMs) => {
  const seconds = Math.ceil((retryAfterMs || 0) / 1000);
  return `Too many requests. Please wait ${seconds}s and try again.`;
};