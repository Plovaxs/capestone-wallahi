import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = [
  "https://capstone-final-mxbr-git-final-form-mannltc19s-projects.vercel.app",
  "https://capestone-wallahi.vercel.app",
  "https://www.djbc-oms-portal.com",
  "https://djbc-oms-portal.com",
  "http://localhost:5173",
];

// Every Vercel preview deployment gets its own unique hash subdomain
// (e.g. capestone-wallahi-1bc0r72cc-tenzin2115-2811s-projects.vercel.app)
// on top of the stable project alias above — an exact-match list would
// need a redeploy every single push. This matches any preview URL under
// either known Vercel project instead.
const allowedOriginPatterns = [
  /^https:\/\/capestone-wallahi-[a-z0-9]+-tenzin2115-2811s-projects\.vercel\.app$/,
  /^https:\/\/capstone-final-[a-z0-9]+-mannltc19s-projects\.vercel\.app$/,
];

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;
  return allowedOriginPatterns.some((pattern) => pattern.test(origin));
}

function corsHeadersFor(origin: string | null) {
  const allowOrigin = isAllowedOrigin(origin) ? origin! : allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

const MATCH_THRESHOLD = 0.42;
// A real, completed 2-step liveness challenge (see vision/livenessDetector.js)
// takes at least a few seconds even at the fastest polling interval this app
// uses -- this floor is deliberately conservative (well under that) so it
// never rejects a genuine user, while still closing off "capture a valid
// request and instantly replay it" and "call this function directly, zero
// interaction" attacks, which would otherwise complete in single-digit
// milliseconds.
const MIN_CHALLENGE_ELAPSED_MS = 1500;
const CHALLENGE_TTL_SECONDS = 35;

Deno.serve(async (req) => {
  const corsHeaders = corsHeadersFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  try {
    const body = await req.json();

    // 🟩 SECURITY: issues a fresh, single-use, short-lived nonce the client
    // must hold onto for the DURATION of its liveness challenge and send
    // back with the actual login attempt below. This is what makes the
    // client-side liveness checks (however hardened -- see
    // vision/livenessDetector.js, livenessFusion.js) actually matter to
    // this endpoint at all: without it, a captured/replayed request or a
    // script calling this function directly with a leaked descriptor had
    // zero obligation to have gone through any camera check whatsoever.
    if (body?.action === "challenge") {
      const { data: rl, error: rlError } = await admin.rpc("check_rate_limit_internal", {
        p_key: `biometric-challenge:${ip}`,
        p_max_requests: 20,
        p_window_seconds: 60,
      });
      if (rlError) throw rlError;
      if (!rl.allowed) {
        return new Response(
          JSON.stringify({ error: "rate_limited", retry_after_ms: rl.retry_after_ms }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { data: challenge, error: insertError } = await admin
        .from("login_challenges")
        .insert({ ip, expires_at: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString() })
        .select("nonce, expires_at")
        .single();
      if (insertError) throw insertError;

      // Opportunistic cleanup -- keeps this table from growing forever
      // without needing a separate cron job for what's a tiny amount of data.
      admin.from("login_challenges").delete().lt("expires_at", new Date(Date.now() - 3600_000).toISOString())
        .then(() => {}, (err) => console.error("login_challenges cleanup failed:", err));

      return new Response(
        JSON.stringify({ nonce: challenge.nonce, expiresAt: challenge.expires_at }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Rate limit by IP before doing any work — brute-forcing face
    // matches (replaying descriptors, trying many faces) gets slowed here.
    const { data: rl, error: rlError } = await admin.rpc("check_rate_limit_internal", {
      p_key: `biometric-login:${ip}`,
      p_max_requests: 10,
      p_window_seconds: 60,
    });
    if (rlError) throw rlError;
    if (!rl.allowed) {
      return new Response(
        JSON.stringify({ error: "rate_limited", retry_after_ms: rl.retry_after_ms }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { descriptor, nonce } = body;
    if (!Array.isArray(descriptor) || descriptor.length !== 128) {
      return new Response(JSON.stringify({ error: "Invalid descriptor" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (typeof nonce !== "string" || !nonce) {
      return new Response(JSON.stringify({ error: "invalid_or_expired_challenge" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Atomically consume the nonce: only succeeds once, only before expiry.
    // The UPDATE's WHERE clause is the actual single-use enforcement (a
    // second concurrent attempt with the same nonce updates 0 rows and
    // gets nothing back) -- reading the row first and checking in
    // application code would leave a race window between the check and
    // the consume.
    const { data: consumedChallenge, error: consumeError } = await admin
      .from("login_challenges")
      .update({ consumed_at: new Date().toISOString() })
      .eq("nonce", nonce)
      .is("consumed_at", null)
      .gt("expires_at", new Date().toISOString())
      .select("issued_at")
      .maybeSingle();
    if (consumeError) throw consumeError;

    if (!consumedChallenge) {
      return new Response(JSON.stringify({ error: "invalid_or_expired_challenge" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const elapsedMs = Date.now() - new Date(consumedChallenge.issued_at).getTime();
    if (elapsedMs < MIN_CHALLENGE_ELAPSED_MS) {
      return new Response(JSON.stringify({ error: "challenge_too_fast" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Service role bypasses RLS/column revokes — this is the only place
    // face_descriptor is ever read.
    const { data: profiles, error: fetchError } = await admin
      .from("profiles")
      .select("id, email, face_descriptor")
      .not("face_descriptor", "is", null);
    if (fetchError) throw fetchError;

    let bestMatch: { id: string; email: string | null } | null = null;
    let lowestDistance = MATCH_THRESHOLD;

    for (const profile of profiles) {
      const stored = typeof profile.face_descriptor === "string"
        ? JSON.parse(profile.face_descriptor)
        : profile.face_descriptor;
      const dist = euclideanDistance(descriptor, stored);
      if (dist < lowestDistance) {
        lowestDistance = dist;
        bestMatch = profile;
      }
    }

    await admin.from("biometric_login_attempts").insert({
      matched_profile_id: bestMatch?.id ?? null,
      success: !!bestMatch,
      distance: bestMatch ? lowestDistance : null,
      ip,
    });

    if (!bestMatch) {
      return new Response(JSON.stringify({ error: "no_match" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 🟩 FIX: this check ran AFTER generateLink() already attempted to use
    // bestMatch.email -- a matched profile missing an email (shouldn't
    // normally happen, but nothing enforced it at the DB level) would hit
    // generateLink with email: undefined first and fail there instead,
    // surfacing as an opaque "Internal error" rather than this specific,
    // easier-to-debug message. Validate before attempting the call.
    if (!bestMatch.email) {
      return new Response(JSON.stringify({ error: "Matched profile has no email on file" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Mint a real, verifiable session for the matched user without a
    // password. generateLink + client-side verifyOtp is the documented
    // pattern for custom (non-password) auth flows in Supabase.
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: bestMatch.email,
    });
    if (linkError) throw linkError;
    return new Response(
      JSON.stringify({ token_hash: linkData.properties.hashed_token }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("biometric-login error:", err);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
