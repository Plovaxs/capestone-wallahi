import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { supabase } from '../supabaseClient';
import LoginLogo from '../assets/customs-logo.jpg';
import { Icons } from '../components/Icons';
import { checkFraming, checkOcclusion, checkBrightness, checkSingleFace } from '../vision/faceQuality';
import { validateLoaFile } from '../utils/validateMime';
import { sanitizeLoaExtension } from '../utils/sanitize';
import { calculateFrameReadiness } from '../vision/scanReadiness';
import ScanReadinessBar from '../components/ScanReadinessBar';
import { selectPrimaryFace } from '../vision/primaryFaceSelector';
import { checkReplaySuspicion } from '../vision/antiReplayHeuristic';
import { checkColorLiveness } from '../vision/colorLivenessHeuristic';
import { checkTextureSharpness } from '../vision/textureSharpnessHeuristic';
import { evaluatePassiveLiveness } from '../vision/livenessFusion';
import { createMicroMotionTracker } from '../vision/microMotionTracker';
import { calculateBoxShiftRatio, createBoxMotionTracker, toFaceRelativeBox } from '../vision/boxMotionHeuristic';
import { checkHandInFrame, checkHandNearFrameEdges } from '../vision/handRegionHeuristic';
import { checkScreenGlare } from '../vision/screenGlareHeuristic';
import { checkDeviceEdges } from '../vision/deviceEdgeHeuristic';
import { RandomLivenessChallenge, CHALLENGE_TYPES, CHALLENGE_INSTRUCTION_SUFFIX, CHALLENGE_DIRECTION_GLYPH, calculateEyeBoxes, calculateMouthBox, calculateNoseBox, isEyeClosed } from '../vision/livenessDetector';
import { createPulseDetector, calculateAverageGreenChannel } from '../vision/pulseDetector';
import { markFaceVerifiedLogin } from '../domain/faceLoginClockInFlag';
import { detectAutomation } from '../vision/automationDetector';
import { checkVirtualCamera } from '../vision/virtualCameraDetector';
import { isVirtualCameraCheckEnabled } from '../utils/systemSettings';
import { calculateFaceOverlayStyle } from '../vision/faceOverlayGeometry';

// 🟩 LAZY-LOADED: face-api.js is multi-MB and was previously a static
// import, so just opening the login page downloaded it up front even
// before the camera/scan started. Shared module-level cache (same pattern
// as AttendanceView.jsx) means navigating between this page and Attendance
// doesn't re-fetch it, and a failed load clears the cache so "Retry
// loading scanner" actually retries instead of re-throwing forever.
let faceApiModulePromise = null;
const loadFaceApiModule = () => {
    if (!faceApiModulePromise) {
        faceApiModulePromise = import('face-api.js').catch((err) => {
            faceApiModulePromise = null;
            throw err;
        });
    }
    return faceApiModulePromise;
};

// 🟩 Maps a failed quality/liveness gate to the specific hint shown to the
// user, same pattern as AttendanceView's QUALITY_HINT_KEYS -- "no face" and
// "face blocked by someone else" need different guidance than "too dark".
const QUALITY_HINT_KEYS = {
  'no-face': 'login.statusNoFace',
  'multiple-faces': 'login.statusMultipleFaces',
  'too-far': 'login.statusTooFar',
  'too-close': 'login.statusTooClose',
  'off-center': 'login.statusFaceLocked',
  'too-dark': 'login.statusTooDark',
  'too-bright': 'login.statusTooBright',
  'low-confidence': 'login.statusLowConfidence',
};

// 🟩 Same specific-cause-to-message mapping AttendanceView's camera fallback
// uses -- "permission denied", "no camera found", and "camera already in
// use by another app" all need different instructions, and lumping them
// into one generic "webcam unreachable" message left the user with no idea
// what to actually do about it.
const CAMERA_ERROR_I18N_KEYS = {
  denied: { title: 'login.cameraErrorDeniedTitle', body: 'login.cameraErrorDeniedBody' },
  'not-found': { title: 'login.cameraErrorNotFoundTitle', body: 'login.cameraErrorNotFoundBody' },
  busy: { title: 'login.cameraErrorBusyTitle', body: 'login.cameraErrorBusyBody' },
  unsupported: { title: 'login.cameraErrorUnsupportedTitle', body: 'login.cameraErrorUnsupportedBody' },
  unknown: { title: 'login.cameraErrorUnknownTitle', body: 'login.cameraErrorUnknownBody' },
};

export default function LoginPage() {
  const { t } = useTranslation();
  const [authMode, setAuthMode] = useState('login');
  // 🟩 NEW: remembers the last-used email locally (never the password) so
  // a returning user doesn't have to retype it every session -- purely a
  // convenience, opt-out via the checkbox below the password field.
  const [email, setEmail] = useState(() => localStorage.getItem('login_rememberedEmail') || '');
  const [password, setPassword] = useState('');
  const [rememberEmail, setRememberEmail] = useState(() => localStorage.getItem('login_rememberedEmail') !== null);
  const [showPassword, setShowPassword] = useState(false); // 🟩 NEW: password visibility toggle
  const [capsLockOn, setCapsLockOn] = useState(false); // 🟩 NEW: warns before a mistyped-looking-right password fails silently
  // 🟩 NEW: "forgot password" -- previously entirely absent; the only
  // recovery path for a lost password was asking a supervisor to reset it
  // manually via the Supabase dashboard. Deliberately a separate boolean
  // (not a third authMode value) so it can't interact with any of the
  // authMode-gated camera/liveness effects below -- this is purely a left-
  // panel form swap, the camera side is completely unaffected either way.
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotMessage, setForgotMessage] = useState('');
  const [name, setName] = useState('');
  const [initials, setInitials] = useState('');
  // 🟩 NEW: onboarding fields collected at self-registration -- previously
  // only a supervisor could set institution/position/department/contract
  // dates after the fact (Settings > Manage Staff Assignments), leaving a
  // brand-new account with none of it until someone remembered to fill it
  // in. Self-reported here as a starting point; a supervisor can still
  // correct any of it later (see Settings/Outsource Directory), matching
  // how they'd cross-check it against the uploaded LOA anyway.
  const [institution, setInstitution] = useState('');
  const [position, setPosition] = useState('');
  const [department, setDepartment] = useState('');
  const [contractStartDate, setContractStartDate] = useState('');
  const [contractEndDate, setContractEndDate] = useState('');
  const [loaFile, setLoaFile] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [biometricStatus, setBiometricStatus] = useState(t('login.statusInitializing'));
  // 🟩 UI: the directional challenge glyph (⬅️➡️⬆️⬇️👁️) used to be prefixed
  // directly into biometricStatus and rendered as one overlay pill cramped
  // inside the circular camera frame -- kept separate so the layout can
  // show the arrow prominently ABOVE the readiness bar and the instruction
  // text BELOW it, without the frame overlay getting crowded.
  const [challengeGlyph, setChallengeGlyph] = useState(null);
  // 🟩 PASSWORD FALLBACK: the zero-touch face login silently retries forever
  // on every blink — a legitimate user with a stale/no-longer-matching
  // descriptor (lighting, new glasses, re-enrollment needed) gets stuck in
  // an invisible retry loop with no signal to just use the password fields
  // that are already on screen. After a few consecutive failures, stop
  // auto-retrying and point them at the password form instead.
  const [biometricFailCount, setBiometricFailCount] = useState(0);
  const MAX_BIOMETRIC_FAILURES = 3;
  const suggestPasswordFallback = biometricFailCount >= MAX_BIOMETRIC_FAILURES;

  const videoRef = useRef(null);
  const isRedirectingRef = useRef(false);
  const lastAttemptRef = useRef(0);
  const ATTEMPT_COOLDOWN_MS = 4000;
  const scanBusyRef = useRef(false); // 🟩 NEW: guards against an interval tick overlapping a still-running detection (throttled loop, see below)
  const detectionFailureStreakRef = useRef(0); // 🟩 NEW: consecutive detectTick exceptions (WebGL context lost, out-of-memory, etc.) -- previously only ever logged to console with zero user-facing feedback
  const nonceFailureStreakRef = useRef(0); // 🟩 BUG FIX: see executeBiometricLogin's invalid_or_expired_challenge branch -- was silently retried forever with zero visible feedback if the server keeps rejecting every nonce
  const isLowLightRef = useRef(false); // 🟩 NEW: sustained-dark-read streak flips this on to boost brightness/contrast on the capture canvas
  const lowLightStreakRef = useRef(0);
  const qualityIssueStreakRef = useRef(0); // 🟩 BUG FIX: see the qualityIssue block below -- debounces a single bad-quality tick so it doesn't wipe blink progress
  const passiveSuspicionStreakRef = useRef(0); // 🟩 BUG FIX: see the passiveVote block below -- a blink's eyelid/eyelash edge can trip deviceEdgeSuspicious for exactly one frame
  const microMotionTrackerRef = useRef(createMicroMotionTracker()); // 🟩 NEW: same pixel-variance liveness signal used on Attendance's clock-in scan
  // 🟩 SECURITY: active liveness challenge, reinstated after a printed photo
  // defeated the previous passive-only liveness check during the capstone
  // defense — a static photo literally cannot blink or turn its head on
  // request, closing the gap that passive heuristics alone (even
  // fixed/voted) can't fully close on their own.
  // 🟩 SIMPLIFIED (2026-08-12): single blink instead of double, per explicit
  // design call -- the mandatory rPPG pulse gate that used to be the other
  // hard backstop is now advisory-only (see the passive-vote fold-in
  // further down), so this app now leans on: 1) a live, deliberate blink
  // (a static photo cannot produce), and 2) mandatory frame-to-frame face-
  // box motion (vision/boxMotionHeuristic.js -- a rigidly mounted image
  // cannot produce). Both together, not either alone -- see that module's
  // own comment for the known "hand-held photo also wobbles" limitation
  // and why box-motion is a SUPPLEMENT to the blink, never a replacement.
  const livenessChallengeRef = useRef(new RandomLivenessChallenge({
    challengeType: CHALLENGE_TYPES.BLINK,
    steps: 1,
  }));
  const boxMotionTrackerRef = useRef(createBoxMotionTracker());
  const prevFaceBoxForMotionRef = useRef(null);
  // 🟩 NEW: same frame-to-frame box-motion tracking as the face box above,
  // applied to the mouth and nose -- see calculateMouthBox/calculateNoseBox's
  // own comment.
  const mouthMotionTrackerRef = useRef(createBoxMotionTracker());
  const prevMouthBoxForMotionRef = useRef(null);
  const noseMotionTrackerRef = useRef(createBoxMotionTracker());
  const prevNoseBoxForMotionRef = useRef(null);
  // 🟩 rPPG PULSE LIVENESS: same additional biometric vote as Attendance --
  // see vision/pulseDetector.js. Fed by a separate ~20Hz sampling loop
  // (decoupled from this page's 350ms detectTick, too slow by Nyquist for
  // a 42-210 BPM signal); latestFaceBoxRef mirrors faceOverlayBox state
  // into a ref so that loop always reads the current box without
  // restarting itself on every (much more frequent) state update.
  const pulseDetectorRef = useRef(createPulseDetector());
  const latestFaceBoxRef = useRef(null);
  const pulseCanvasRef = useRef(null);
  const faceapiRef = useRef(null); // 🟩 NEW: holds the dynamically-imported face-api.js module once loadNeuralModels finishes

  // 🟩 SECURITY: server-issued, single-use liveness nonce -- closes the gap
  // every purely client-side liveness check above (however hardened) can
  // never close on its own: the biometric-login Edge Function used to
  // accept a bare descriptor with zero awareness of whether any liveness
  // check ran at all, so a captured/replayed network request, or a script
  // calling the function directly with a leaked descriptor, could skip the
  // camera UI entirely. The server now requires a fresh, single-use nonce
  // (fetched before the challenge starts) and enforces a minimum elapsed
  // time between issuing it and the login attempt using it -- a real
  // replay-prevention/rate control, NOT a cryptographic proof that a human
  // blinked. See supabase/functions/biometric-login/index.ts.
  const loginNonceRef = useRef(null);
  const loginNonceIssuedAtRef = useRef(0);
  const NONCE_REFRESH_MARGIN_MS = 10000; // refresh proactively before the server-side ~35s expiry

  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false); // 🟩 NEW: drives a retry button -- a failed model load used to leave the user permanently stuck with only a status-pill message and no way forward but a full page reload
  const [modelLoadAttempt, setModelLoadAttempt] = useState(0); // 🟩 NEW: bumping this re-runs the model-load effect, giving the retry button something to trigger
  const [cameraError, setCameraError] = useState(null); // 🟩 NEW: null | 'denied' | 'not-found' | 'busy' | 'unsupported' | 'unknown'
  // 🟩 ANTI-AUTOMATION: computed once at mount (navigator.webdriver doesn't
  // change mid-session) -- see vision/automationDetector.js. Blocks the
  // face-scan gate entirely rather than folding into the liveness fusion,
  // since this asks a different question (is the browser itself remote-
  // controlled?) with a near-zero false-positive signal, unlike the noisier
  // per-frame heuristics that fusion combines.
  const [automationDetected] = useState(() => detectAutomation().suspicious);
  // 🟩 SECURITY: virtual/software camera driver (OBS Virtual Camera,
  // ManyCam, etc.) supplying the feed instead of a real webcam -- the
  // dominant real-world technique for beating browser liveness checks
  // (see vision/virtualCameraDetector.js). Device labels only populate
  // once camera permission is actually granted, so this can't be checked
  // up front like automationDetected -- it's set once getUserMedia
  // resolves, below.
  const [virtualCameraDetected, setVirtualCameraDetected] = useState(false);
  const [scanReadiness, setScanReadiness] = useState(0); // 🟩 NEW: 0-100 "how close to a good capture" score driving the readiness bar
  const [faceOverlayBox, setFaceOverlayBox] = useState(null); // 🟩 NEW: bounding box drawn around the detected face, same visual language as AttendanceView
  // 🟩 NEW: per-eye boxes + closed/open read, so a blink is visibly
  // confirmed on screen (the box flashes) instead of only being inferred
  // from the status text -- real-user feedback that blinking felt
  // undetectable even when it was actually registering correctly.
  const [eyeBoxes, setEyeBoxes] = useState(null); // { left: {x,y,width,height}, right: {...}, leftClosed, rightClosed } | null
  // 🟩 NEW: mouth/nose boxes -- a photo/screen literally cannot move its
  // own lips or nostrils, so real movement in EITHER region is strong,
  // independent proof of a live face (see its use as a passive-suspicion
  // override further below).
  const [mouthBox, setMouthBox] = useState(null);
  const [noseBox, setNoseBox] = useState(null);

  useEffect(() => {
    let isCurrent = true;
    async function loadNeuralModels() {
      try {
        setModelsLoadFailed(false);
        setBiometricStatus(t('login.statusLoadingModels'));
        const faceapi = await loadFaceApiModule();
        if (!isCurrent) return;
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
          faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
          faceapi.nets.faceRecognitionNet.loadFromUri('/models')
        ]);
        if (!isCurrent) return;
        faceapiRef.current = faceapi;
        setModelsLoaded(true);
        setBiometricStatus(t('login.statusPositionFace'));
      } catch (err) {
        console.error('Failed to load neural models:', err);
        if (!isCurrent) return;
        // 🟩 MITIGATION: previously a dead end -- this status text was the
        // only feedback, with no button, no retry, nothing actionable. A
        // flaky connection loading ~6MB of model weights is exactly the
        // kind of transient failure a manual retry (network's back now)
        // should be able to recover from without a full page reload.
        setModelsLoadFailed(true);
        setBiometricStatus(t('login.statusModelsUnreachable'));
      }
    }
    loadNeuralModels();
    return () => { isCurrent = false; };
    // Intentional: `t` isn't listed -- i18next's translate function isn't
    // guaranteed stable across every parent re-render, and this effect
    // must only actually restart the (slow, ~6MB) model download when the
    // retry button bumps modelLoadAttempt, not on unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelLoadAttempt]);

  useEffect(() => {
    let localStream = null;
    let isCurrent = true;

    async function startVideo() {
      setCameraError(null);

      if (automationDetected) {
        // Don't even request camera access for a WebDriver-controlled
        // session -- there's no legitimate reason for an automated browser
        // to need the live feed, and not asking avoids an unnecessary
        // permission prompt on top of the block itself.
        setBiometricStatus(t('login.statusAutomationBlocked'));
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        // Very old browser, or a non-secure (http, non-localhost) context —
        // getUserMedia is unavailable entirely rather than throwing.
        setCameraError('unsupported');
        setBiometricStatus(t('login.statusWebcamUnreachable'));
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' }
        });

        if (!isCurrent) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        // 🟩 SECURITY: device labels only populate once permission is
        // granted, so this is the earliest point it can run. A match stops
        // the stream immediately -- same hard-block treatment as
        // automationDetected, not one more vote in the passive fusion.
        const [virtualCameraCheck, virtualCameraCheckEnabled] = await Promise.all([
          checkVirtualCamera(),
          isVirtualCameraCheckEnabled(),
        ]);
        if (!isCurrent) { stream.getTracks().forEach(track => track.stop()); return; }
        if (virtualCameraCheck.suspicious && virtualCameraCheckEnabled) {
          console.warn('[login] virtual camera driver detected:', virtualCameraCheck.matchedLabel);
          stream.getTracks().forEach(track => track.stop());
          setVirtualCameraDetected(true);
          setBiometricStatus(t('login.statusVirtualCameraBlocked'));
          return;
        }
        // 🟩 A supervisor can disable this check globally (Debug Center >
        // Camera & Face) -- still worth a console note when it would have
        // blocked, so the bypass isn't silent to anyone debugging.
        if (virtualCameraCheck.suspicious && !virtualCameraCheckEnabled) {
          console.info('[login] virtual camera driver detected but the check is disabled:', virtualCameraCheck.matchedLabel);
        }

        localStream = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(e => console.error(e));
        }
      } catch (error) {
        if (!isCurrent) return;
        // 🟩 MITIGATION: same specific-cause differentiation AttendanceView
        // already has -- "permission denied" needs different instructions
        // (check browser settings) than "camera in use by another app"
        // (close Zoom/Teams/etc.) or "no camera found" (plug one in).
        console.error('[login] getUserMedia failed:', error);
        if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
          setCameraError('denied');
        } else if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') {
          setCameraError('not-found');
        } else if (error?.name === 'NotReadableError') {
          setCameraError('busy');
        } else {
          setCameraError('unknown');
        }
        setBiometricStatus(t('login.statusWebcamUnreachable'));
      }
    }

    if (modelsLoaded) {
      startVideo();
    }

    return () => {
      isCurrent = false;
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
      }
    };
    // Intentional: `t` isn't listed, same reasoning as the model-load effect
    // above -- this must only re-request the camera when modelsLoaded flips,
    // not on every unrelated re-render (which would tear down and re-open
    // the webcam stream, flickering the camera indicator/permission state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsLoaded]);

  // 🟩 BUG FIX: these two must be declared BEFORE the detectTick effect
  // below, which lists both in its dependency array -- they used to live
  // much further down the file (after that effect), which is a genuine
  // temporal-dead-zone violation (`const` isn't hoisted the way `function`
  // declarations are). It didn't always surface in dev, but broke outright
  // under production minification: "Cannot access '...' before
  // initialization" as soon as LoginPage rendered.
  // 🟩 useCallback so the detectTick effect below can correctly list this
  // (and executeBiometricLogin, which calls it) as a dependency without
  // tearing down/rebuilding its setInterval on every render -- this
  // function only ever reads/writes refs and calls the stable
  // supabase.functions.invoke, so it has no real reactive dependencies.
  const refreshLoginNonce = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke('biometric-login', { body: { action: 'challenge' } });
      if (error) {
        // 🟩 DIAGNOSTIC: supabase-js resolves (not rejects) on a non-2xx
        // response, so this previously failed completely silently --
        // loginNonceRef just stayed null/stale with no console trace at
        // all, making "every login attempt gets rejected" hard to
        // distinguish from an actual liveness/match failure.
        console.error('[login] challenge request returned an error:', error);
        return;
      }
      if (data?.nonce) {
        loginNonceRef.current = data.nonce;
        loginNonceIssuedAtRef.current = Date.now();
      }
    } catch (err) {
      // Non-fatal: executeBiometricLogin will just get rejected server-side
      // (missing/invalid nonce) and fall into the existing retry path below.
      console.error('[login] failed to fetch a fresh login nonce:', err);
    }
  }, []);

  // 🟩 useCallback for the same reason as refreshLoginNonce above -- its
  // only reactive dependency is `t` (for the status/error messages it
  // sets), so wrapping it lets detectTick's effect list it correctly
  // without restarting its setInterval on every unrelated render.
  const executeBiometricLogin = useCallback(async (liveDescriptor) => {
   isRedirectingRef.current = true;
   setBiometricStatus(t('login.statusVerifyingServer'));

   // The nonce proves SOME real time elapsed since it was issued (the
   // server enforces a minimum, MIN_CHALLENGE_ELAPSED_MS below) -- only
   // refresh proactively if the current one is getting old enough to risk
   // server-side expiry while the user was still mid-challenge.
   if (!loginNonceRef.current || Date.now() - loginNonceIssuedAtRef.current > NONCE_REFRESH_MARGIN_MS * 2.5) {
     await refreshLoginNonce();
   }

   // 🟩 BUG FIX: the comment above already warned "fetching a replacement
   // right here, an instant before submitting, would defeat [the min-
   // elapsed check] entirely" -- and then the code did exactly that
   // anyway. If the challenge happened to take long enough for the
   // proactive refresh just above to actually fire, the freshly-issued
   // nonce gets consumed within milliseconds, reliably failing the
   // server's own MIN_CHALLENGE_ELAPSED_MS (1500ms) floor as
   // "challenge_too_fast" -- a real, reported server-visible failure that
   // had nothing to do with the user's face or blink at all, just this
   // race between two different nonce-freshness safeguards. Explicitly
   // wait out whatever's left before sending, so a request is never sent
   // with a nonce younger than the server will accept.
   const MIN_CHALLENGE_ELAPSED_MS = 1500;
   const nonceAgeMs = Date.now() - loginNonceIssuedAtRef.current;
   if (nonceAgeMs < MIN_CHALLENGE_ELAPSED_MS) {
     await new Promise((resolve) => setTimeout(resolve, MIN_CHALLENGE_ELAPSED_MS - nonceAgeMs));
   }

   const { data, error } = await supabase.functions.invoke('biometric-login', {
     body: { descriptor: Array.from(liveDescriptor), nonce: loginNonceRef.current },
   });

   if (error || !data?.token_hash) {
     isRedirectingRef.current = false;

     // 🟩 MITIGATION: previously every failure mode here -- an actual "no
     // match found", a 429 rate-limit, and a network/server error where the
     // request never even reached the matching logic -- all showed the
     // exact same "face not recognized" message and counted the same
     // toward the password-fallback threshold. That's actively misleading
     // when the real cause is "your connection dropped" or "you've hit the
     // server's rate limit", neither of which the user can fix by
     // re-scanning their face. Reads the edge function's actual JSON error
     // body (Supabase wraps a non-2xx response in a FunctionsHttpError
     // whose .context is the raw Response) to tell them apart.
     let reason = null;
     if (error?.context?.json) {
       try {
         const body = await error.context.json();
         reason = body?.error ?? null;
       } catch (_parseErr) {
         // Response wasn't JSON (or was already consumed) -- fall through to the generic network/server message below.
       }
     }

     if (reason === 'no_match') {
       setError(t('login.errorFaceNotRecognized'));
       setBiometricFailCount((prev) => prev + 1);
       nonceFailureStreakRef.current = 0;
     } else if (reason === 'rate_limited') {
       setError(t('login.errorRateLimited'));
       // Doesn't count toward biometricFailCount -- being rate-limited says
       // nothing about whether this user's face actually matches, so it
       // shouldn't push them toward "give up and use a password" any faster.
       nonceFailureStreakRef.current = 0;
     } else if (reason === 'invalid_or_expired_challenge' || reason === 'challenge_too_fast') {
       // 🟩 A legitimate timing edge case (nonce expired while lighting/
       // positioning took a while, or a clock skew quirk) was the original
       // assumption here -- silently line up a fresh nonce and let the
       // next completed challenge retry, no scary message. But if the
       // SERVER keeps rejecting every nonce (a real deployment/clock-skew
       // problem, not a one-off timing fluke), that silence meant the
       // user just watched the challenge reset forever with zero
       // indication anything was actually wrong -- reported as "sudah
       // kedip 2x hijau tapi nggak masuk-masuk." Still silent for the
       // first couple of occurrences (the original rare-fluke case), but
       // surfaces a real, actionable message once it's clearly not a fluke.
       console.error('[login] biometric-login rejected the nonce:', reason);
       nonceFailureStreakRef.current += 1;
       if (nonceFailureStreakRef.current >= 3) {
         setError(t('login.errorChallengeSyncFailing'));
       }
       refreshLoginNonce();
     } else {
       // Network failure (offline, DNS, CORS) or an unexpected 5xx -- the
       // request may not have reached the matching logic at all.
       console.error('[login] biometric-login request failed:', error);
       setError(t('login.errorNetworkOrServer'));
       nonceFailureStreakRef.current = 0;
     }
     return;
   }

   // Exchange the server-issued token for a real, verified session.
   const { error: verifyError } = await supabase.auth.verifyOtp({
     token_hash: data.token_hash,
     type: 'magiclink',
   });

   if (verifyError) {
     isRedirectingRef.current = false;
     console.error('[login] session verification failed:', verifyError);
     setError(t('login.errorSessionVerification'));
     setBiometricFailCount((prev) => prev + 1);
     return;
   }
   // supabase.auth.onAuthStateChange in App.jsx now picks this up naturally.

   // 🟩 CLOCK-IN-ON-LOGIN: signals to App.jsx that this session came from a
   // live, just-verified face scan (not a restored session or a password
   // login), so it can auto clock the employee in for today without a
   // separate trip to Attendance -- see domain/faceLoginClockInFlag.js and
   // App.jsx's attemptAutoClockInAfterLogin.
   markFaceVerifiedLogin();
  }, [t, refreshLoginNonce]);

  useEffect(() => {
    let intervalId = null;
    let cancelled = false;
    // 🟩 these ref objects are created once via useRef(...) and never
    // reassigned anywhere in this component -- copying them to locals here
    // just satisfies the "ref value may have changed by cleanup time" lint
    // rule; the object identity is stable for the component's whole lifetime.
    const microMotionTracker = microMotionTrackerRef.current;
    const livenessChallenge = livenessChallengeRef.current;
    const pulseDetector = pulseDetectorRef.current;
    const boxMotionTracker = boxMotionTrackerRef.current;

    // 🟩 PERFORMANCE: this used to run full face detection + landmarks +
    // descriptor inference on every requestAnimationFrame -- up to ~60
    // times a second, each one a real CNN forward pass. Throttled to a
    // fixed interval instead (like AttendanceView's scan loop already
    // does): status feedback doesn't need to update faster than a human
    // can perceive, and this alone cuts the CPU/battery cost by roughly
    // an order of magnitude with no visible difference in responsiveness.
    const DETECT_INTERVAL_MS = 350;

    const detectTick = async () => {
      if (cancelled || scanBusyRef.current || isRedirectingRef.current || !modelsLoaded) return;
      const videoEl = videoRef.current;
      if (!videoEl || videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return;
      scanBusyRef.current = true;

      try {
        // Any tick that completes without throwing -- regardless of which
        // branch it takes below (no face, bad quality, successful login
        // trigger) -- means detection itself is healthy again.
        detectionFailureStreakRef.current = 0;

        const width = videoEl.videoWidth;
        const height = videoEl.videoHeight;

        // 🟩 LOW-LIGHT SUPPORT: draw through a canvas (instead of handing
        // the raw <video> straight to face-api) so a sustained run of dark
        // reads can boost brightness/contrast on the way in -- same
        // technique AttendanceView uses. This is also what makes the pixel
        // data available below for the framing/brightness/liveness checks
        // without a second capture.
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = width;
        sourceCanvas.height = height;
        // 🟩 PERF: this context now does multiple getImageData reads per
        // tick (face-box region, border region for device-edge detection,
        // full-frame for hand detection) -- willReadFrequently tells the
        // browser to optimize for that access pattern instead of GPU-
        // accelerated drawing, avoiding the "Multiple readback operations"
        // console warning and the readback slowdown it's warning about.
        const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.filter = isLowLightRef.current ? 'brightness(1.6) contrast(1.15)' : 'none';
        ctx.drawImage(videoEl, 0, 0, width, height);
        ctx.filter = 'none';

        // 🟩 FINE-TUNING (2026-08-11): bumped inputSize 416 -> 512 to match
        // both this page's own registration capture and AttendanceView's
        // continuous scan -- a higher detector input resolution produces
        // meaningfully more precise landmark coordinates, which directly
        // improves BOTH face-match accuracy (a sharper descriptor) and the
        // blink/smile/mouth-open challenge readings (their EAR/ratio math
        // is only as good as the landmark points it's computed from).
        const allDetections = await faceapiRef.current
          .detectAllFaces(sourceCanvas, new faceapiRef.current.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.3 }))
          .withFaceLandmarks()
          .withFaceDescriptors();

        if (cancelled || !videoRef.current) return;

        // 🟩 CROWD ROBUSTNESS: in a busy room this picks the largest +
        // most-centered face (the person actually in front of the camera)
        // instead of whichever detection face-api happened to return
        // first -- a bystander walking past shouldn't be able to hijack
        // the scan. isAmbiguous only fires for the specific "second face
        // is a similar size AND right next to the primary" shape (the
        // real spoofing pattern), not just "someone else is in frame".
        const candidates = allDetections.map((d) => ({ box: d.detection.box, raw: d })).filter((d) => d.box);
        const { primary, isAmbiguous } = selectPrimaryFace(candidates, width, height);

        if (!primary) {
          setScanReadiness(0);
          setFaceOverlayBox(null);
          setEyeBoxes(null);
          setMouthBox(null);
          setNoseBox(null);
          microMotionTrackerRef.current.reset();
          boxMotionTrackerRef.current.reset();
          prevFaceBoxForMotionRef.current = null;
          mouthMotionTrackerRef.current.reset();
          prevMouthBoxForMotionRef.current = null;
          noseMotionTrackerRef.current.reset();
          prevNoseBoxForMotionRef.current = null;
          livenessChallengeRef.current.reset();
          pulseDetectorRef.current.reset();
          setBiometricStatus(t('login.statusNoFace'));
          setChallengeGlyph(null);
          return;
        }

        const detection = primary.raw;
        const box = primary.box;

        const region = ctx.getImageData(
          Math.max(0, Math.round(box.x)),
          Math.max(0, Math.round(box.y)),
          Math.max(1, Math.min(Math.round(box.width), width - Math.round(box.x))),
          Math.max(1, Math.min(Math.round(box.height), height - Math.round(box.y)))
        );
        const brightness = checkBrightness(region.data);

        const LOW_LIGHT_STREAK_THRESHOLD = 3;
        if (brightness.reason === 'too-dark') {
          lowLightStreakRef.current += 1;
          if (lowLightStreakRef.current >= LOW_LIGHT_STREAK_THRESHOLD) isLowLightRef.current = true;
        } else {
          lowLightStreakRef.current = 0;
          isLowLightRef.current = false;
        }

        const framing = checkFraming(box, width, height);
        const singleFace = checkSingleFace(allDetections.length, isAmbiguous);
        const occlusion = checkOcclusion(detection.detection.score);

        const qualityIssue = !singleFace.ok ? singleFace : !framing.ok ? framing : !brightness.ok ? brightness : !occlusion.ok ? occlusion : null;
        // 🟩 BUG FIX: closing your eyes mid-blink is itself a transient
        // partial-occlusion pattern -- face-api's detection confidence
        // score can dip below checkOcclusion's threshold for exactly the
        // one frame that matters, right as the closed-eye state would
        // otherwise register. Wiping the whole liveness challenge (and
        // micro-motion/pulse buffers) on a SINGLE bad-quality tick meant a
        // real blink could reset its own progress before it ever counted,
        // producing an endless "reset, retry, reset" loop that never
        // advances. Debounced like the low-light streak just above --
        // a genuine "face is really gone/badly framed" condition still
        // resets after a few consecutive bad ticks, but one blink-shaped
        // blip doesn't undo everything.
        const QUALITY_ISSUE_STREAK_THRESHOLD = 3;
        let qualityIssueTolerated = false;
        if (qualityIssue) {
          qualityIssueStreakRef.current += 1;
          qualityIssueTolerated = qualityIssue.reason === 'low-confidence' && qualityIssueStreakRef.current < QUALITY_ISSUE_STREAK_THRESHOLD;
        }

        // 🟩 BUG FIX: the readiness bar used to reflect raw occlusion.ok
        // every single tick, so it visibly jittered on the exact same
        // blink-shaped dip the tolerance above already exists to ignore --
        // smoothed so the bar doesn't flicker for a blip nothing else
        // reacts to either.
        setScanReadiness(calculateFrameReadiness({
          singleFace: singleFace.ok,
          framing: framing.ok,
          brightness: brightness.ok,
          occlusion: occlusion.ok || qualityIssueTolerated,
        }));
        setFaceOverlayBox({ x: box.x, y: box.y, width: box.width, height: box.height, imageWidth: width, imageHeight: height });

        // 🟩 NEW: mandatory frame-to-frame face-box motion signal -- see
        // vision/boxMotionHeuristic.js for the full rationale and its
        // documented limitation. Updates every tick regardless of the
        // quality/liveness gates below, same "always feed the tracker"
        // pattern already used for eye boxes and micro-motion.
        boxMotionTrackerRef.current.addSample(calculateBoxShiftRatio(prevFaceBoxForMotionRef.current, box));
        prevFaceBoxForMotionRef.current = box;

        // 🟩 NEW: eye boxes update every tick regardless of the quality/
        // liveness gates below -- the point is to show the user their
        // blink is being SEEN in real time, not just once the challenge
        // logic has already accepted it.
        const eyeGeometry = calculateEyeBoxes(detection.landmarks);
        if (eyeGeometry) {
          setEyeBoxes({
            left: { ...eyeGeometry.left, imageWidth: width, imageHeight: height },
            right: { ...eyeGeometry.right, imageWidth: width, imageHeight: height },
            leftClosed: isEyeClosed(detection.landmarks.getLeftEye()),
            rightClosed: isEyeClosed(detection.landmarks.getRightEye()),
          });
        } else {
          setEyeBoxes(null);
        }

        // 🟩 NEW: same "update every tick regardless of gates" treatment as
        // the eye boxes above -- a photo/screen literally cannot move its
        // own lips or nostrils, so real movement in EITHER region is
        // strong, independent proof of a live face. Read further below to
        // override a false suspicious vote (e.g. an odd-lighting hand/color
        // misread) instead of a lone motionless tick silently blocking a
        // genuinely live user.
        // 🟩 SECURITY FIX: tracked in FACE-RELATIVE coordinates
        // (toFaceRelativeBox), not raw frame position -- a rigidly-held
        // photo/phone wobbles too, moving the face box AND the mouth/nose
        // boxes together in lockstep (the exact same limitation
        // boxMotionHeuristic.js's own comment documents for the face box
        // itself), so raw absolute motion couldn't actually tell "the
        // whole photo wobbled" from "the mouth really moved." Relative
        // position cancels out a whole-object wobble while still catching
        // genuine internal movement.
        const mouthGeometry = calculateMouthBox(detection.landmarks);
        const noseGeometry = calculateNoseBox(detection.landmarks);
        const relativeMouthGeometry = mouthGeometry ? toFaceRelativeBox(mouthGeometry, box) : null;
        const relativeNoseGeometry = noseGeometry ? toFaceRelativeBox(noseGeometry, box) : null;
        if (mouthGeometry) {
          setMouthBox({ ...mouthGeometry, imageWidth: width, imageHeight: height });
        } else {
          setMouthBox(null);
        }
        if (relativeMouthGeometry) {
          mouthMotionTrackerRef.current.addSample(calculateBoxShiftRatio(prevMouthBoxForMotionRef.current, relativeMouthGeometry));
          prevMouthBoxForMotionRef.current = relativeMouthGeometry;
        }
        if (noseGeometry) {
          setNoseBox({ ...noseGeometry, imageWidth: width, imageHeight: height });
        } else {
          setNoseBox(null);
        }
        if (relativeNoseGeometry) {
          noseMotionTrackerRef.current.addSample(calculateBoxShiftRatio(prevNoseBoxForMotionRef.current, relativeNoseGeometry));
          prevNoseBoxForMotionRef.current = relativeNoseGeometry;
        }
        const mouthMotionStats = mouthMotionTrackerRef.current.getStats();
        const noseMotionStats = noseMotionTrackerRef.current.getStats();
        const landmarkMotionDetected = (mouthMotionStats.ready && mouthMotionStats.hasNaturalMovement && !mouthMotionStats.isErratic)
          || (noseMotionStats.ready && noseMotionStats.hasNaturalMovement && !noseMotionStats.isErratic);

        if (qualityIssue) {
          if (!qualityIssueTolerated) {
            microMotionTrackerRef.current.reset();
            livenessChallengeRef.current.reset();
            pulseDetectorRef.current.reset();
            setBiometricStatus(t(QUALITY_HINT_KEYS[qualityIssue.reason] || 'login.statusPositionFace'));
            setChallengeGlyph(null);
          }
          return;
        }
        qualityIssueStreakRef.current = 0;

        microMotionTrackerRef.current.addFrame(region.data, region.width, region.height);
        const colorLiveness = checkColorLiveness(region.data, region.width, region.height);

        // 🟩 REGISTRATION: just needs a clear, well-framed, single face so
        // the user can hit "Save" -- the actual capture happens there, not
        // here, so no auto-login/liveness gating applies in this mode.
        if (authMode !== 'login') {
          setBiometricStatus(t('login.statusMatrixVerified'));
          return;
        }

        if (suggestPasswordFallback) {
          setBiometricStatus(t('login.statusUsePasswordInstead'));
          return;
        }

        const now = Date.now();
        if (now - lastAttemptRef.current < ATTEMPT_COOLDOWN_MS) {
          setBiometricStatus(t('login.statusPleaseWait'));
          return;
        }

        const microMotionStats = microMotionTrackerRef.current.getStats();
        if (!microMotionStats.ready) {
          // Rolling window still warming up (a couple seconds at this
          // interval) -- keep showing progress, don't fire early on an
          // incomplete read.
          setBiometricStatus(t('login.statusMatrixVerified'));
          return;
        }

        if (livenessChallengeRef.current.isExpired()) {
          livenessChallengeRef.current.reset();
          setBiometricStatus(t('login.statusChallengeExpired'));
          setChallengeGlyph(null);
          return;
        }

        // 🟩 SIMPLIFIED (2026-08-12): the deliberate, on-demand blink
        // challenge (now visibly confirmed on screen via the green eye
        // boxes) is evaluated FIRST and is the PRIMARY liveness signal --
        // a static photo/screen literally cannot blink on request, which
        // is a much stronger, more direct proof of life than any of the
        // passive pixel-statistics votes below. Those passive checks
        // (border uniformity, pixel motion, color/texture, device-edge,
        // hand-in-frame, pulse) are still useful for catching a spoofing
        // attempt BEFORE it ever blinks, but real-user reports showed them
        // repeatedly false-tripping mid-blink on completely genuine users
        // (occlusion, device-edge, and "suspiciously static" each
        // independently reported) -- once the deliberate challenge is
        // actually confirmed, they no longer gate the login attempt at
        // all. The second, still-mandatory backstop is
        // vision/boxMotionHeuristic.js further below -- frame-to-frame
        // face-box motion a rigidly mounted image can't produce -- not
        // the rPPG pulse check, which is now advisory-only like the rest
        // of the passive votes (see livenessFusion.js's own comment).
        const challengeConfirmed = livenessChallengeRef.current.registerFrame(detection.landmarks);

        // 🟩 SECURITY FIX (reported live): this whole vote used to live
        // inside `if (!challengeConfirmed)`, so the exact tick where the
        // blink challenge FINALLY confirms was never checked for a hand/
        // phone/device-edge in frame at all -- precisely the tick someone
        // spoofing would still be holding the thing up. Now computed every
        // tick regardless of confirmation state; only the "awaiting blink"
        // UI/early-return below stays confirmation-gated. The existing
        // debounce (passiveSuspicionStreakRef, unchanged) still tolerates a
        // single blink-transition false trip the same as before -- this
        // only closes the "never even looked" gap on a SUSTAINED signal.
        {
          const marginX = Math.round(box.width * 0.15);
          const marginY = Math.round(box.height * 0.15);
          const borderRegion = ctx.getImageData(
            Math.max(0, Math.round(box.x - marginX)),
            Math.max(0, Math.round(box.y - marginY)),
            Math.min(Math.round(box.width + marginX * 2), width),
            Math.min(Math.round(box.height + marginY * 2), height)
          );
          const textureCheck = checkTextureSharpness(borderRegion.data, borderRegion.width, borderRegion.height);
          const pulseStatsForVote = pulseDetectorRef.current.getStats();
          // 🟩 SECURITY: hand/device-edge checks -- see vision/handRegionHeuristic.js
          // and vision/deviceEdgeHeuristic.js. deviceEdges reuses the already-
          // computed borderRegion crop (a phone/photo edge held near the face
          // shows up right at that margin); hand detection needs the FULL
          // frame since fingers holding a device can extend well past it.
          const deviceEdgeCheck = checkDeviceEdges(borderRegion.data, borderRegion.width, borderRegion.height);
          const fullFrame = ctx.getImageData(0, 0, width, height);
          const handCheck = checkHandInFrame(fullFrame.data, width, height, box);
          // 🟩 SECURITY FIX (reported live): checkHandInFrame's surround
          // band only reaches a modest margin past the face box itself --
          // misses fingers gripping a phone/photo near the outer edges of
          // the whole camera frame. See handRegionHeuristic.js's own
          // comment on why this samples a DIFFERENT region.
          const handEdgeCheck = checkHandNearFrameEdges(fullFrame.data, width, height, box);
          // 🟩 SECURITY: a phone/tablet screen displaying a photo EMITS its
          // own backlight, unlike real skin (or a printed photo) which only
          // ever reflects ambient room light -- see vision/screenGlareHeuristic.js.
          const screenGlareCheck = checkScreenGlare(fullFrame.data, width, height, box);
          const passiveVote = evaluatePassiveLiveness({
            borderUniform: checkReplaySuspicion(borderRegion.data).suspicious,
            pixelFlat: microMotionStats.isSuspiciouslyFlat,
            colorSuspicious: colorLiveness.suspicious,
            textureFlat: textureCheck.suspicious,
            deviceEdgeSuspicious: deviceEdgeCheck.suspicious,
            handSuspicious: handCheck.suspicious,
            handEdgeSuspicious: handEdgeCheck.suspicious,
            screenGlareSuspicious: screenGlareCheck.suspicious,
            pulseSuspicious: pulseStatsForVote.ready ? !pulseStatsForVote.hasPlausiblePulse : null,
          });

          // 🟩 NEW: real, natural mouth/nose movement this tick is strong,
          // independent evidence of a live face -- a photo/screen literally
          // cannot move its own lips or nostrils, unlike the other passive
          // votes (hand/color/border), which can all misread under odd
          // lighting or incidental scene conditions. Overrides a suspicious
          // verdict entirely rather than just adding another tolerated
          // tick, so a confirmed-live user isn't stuck waiting out someone
          // else's false positive.
          if (passiveVote.suspicious && landmarkMotionDetected) {
            passiveSuspicionStreakRef.current = 0;
          } else if (passiveVote.suspicious) {
            // 🟩 BUG FIX: a blink's closing eyelid/eyelash creates a brief,
            // real luminance edge right in the border region this samples --
            // easily mistaken for deviceEdgeSuspicious (or nudging color/
            // texture past their own thresholds) for exactly the one frame a
            // blink transition needed.
            // 🟩 LOOSENED FURTHER (2026-08-12, real-user report): holding
            // still to blink deliberately on request -- the exact thing this
            // challenge asks for -- reads as "suspiciously static" to the
            // pixel-motion/border-uniformity checks, which want to see
            // incidental fidgety motion as their own liveness signal. Those
            // two asks are in direct tension for a real person concentrating
            // on blinking on cue, and it kept getting reported as "diam
            // sebentar buat kedip malah dituduh foto." Since the deliberate
            // blink challenge is already the PRIMARY liveness proof (a photo
            // literally cannot blink on request), a much longer tolerance
            // window here costs little real security -- a genuine photo/
            // replay still can never blink at all regardless of how long
            // this tolerates, so it can never progress past the challenge
            // anyway. Pulse is no longer authoritative here either (see
            // livenessFusion.js) -- every vote, including pulse, now shares
            // the same debounce tolerance.
            if (passiveSuspicionStreakRef.current < 8) {
              passiveSuspicionStreakRef.current += 1;
            } else {
              passiveSuspicionStreakRef.current = 0;
              livenessChallengeRef.current.reset();
              setBiometricStatus(t((handCheck.suspicious || handEdgeCheck.suspicious) ? 'login.statusHandDetected' : deviceEdgeCheck.suspicious ? 'login.statusDeviceDetected' : screenGlareCheck.suspicious ? 'login.statusScreenDetected' : 'login.statusLivenessSuspicious'));
              setChallengeGlyph(null);
            }
            return;
          }
          passiveSuspicionStreakRef.current = 0;
        }

        if (!challengeConfirmed) {
          const suffix = CHALLENGE_INSTRUCTION_SUFFIX[livenessChallengeRef.current.challengeType];
          setChallengeGlyph(CHALLENGE_DIRECTION_GLYPH[livenessChallengeRef.current.challengeType]);
          setBiometricStatus(t(`login.statusAwaiting${suffix}`, {
            step: livenessChallengeRef.current.stepIndex + 1,
            totalSteps: livenessChallengeRef.current.totalSteps,
          }));
          return;
        }

        // 🟩 SECURITY (2026-08-12): mandatory frame-to-frame face-box motion
        // gate, replacing the old mandatory rPPG pulse gate -- see
        // vision/boxMotionHeuristic.js for the full rationale and its
        // documented limitation (a hand-held photo also wobbles; this is a
        // SUPPLEMENT to the blink challenge above, not a replacement for
        // it). If the window hasn't filled yet or looks frozen/erratic,
        // the challenge stays confirmed (won't reset/re-prompt) and this
        // tick just waits for the next one.
        const motionStats = boxMotionTrackerRef.current.getStats();
        if (!motionStats.ready || !motionStats.hasNaturalMovement || motionStats.isErratic) {
          setBiometricStatus(t('login.statusAwaitingMotion'));
          return;
        }

        lastAttemptRef.current = now;
        setChallengeGlyph(null);
        setBiometricStatus(t('login.statusLivenessVerified'));
        await executeBiometricLogin(detection.descriptor);
        livenessChallengeRef.current.reset();
        pulseDetectorRef.current.reset();
        boxMotionTrackerRef.current.reset();
        prevFaceBoxForMotionRef.current = null;
        refreshLoginNonce(); // the nonce just used is now consumed server-side either way -- line up a fresh one for the next attempt
      } catch (err) {
        console.error('Face detection error:', err);
        // 🟩 MITIGATION: a repeatedly-throwing detection loop (WebGL context
        // lost, browser tab backgrounded then restored in a bad state, an
        // out-of-memory condition) previously failed completely silently --
        // console-only, nothing shown to the user, who'd just see the scan
        // circle sitting frozen with no explanation. After a sustained run
        // of failures (not a single blip), surface it and point at the
        // password fallback that's already on screen.
        detectionFailureStreakRef.current += 1;
        if (detectionFailureStreakRef.current >= 10) {
          setBiometricStatus(t('login.statusScanRepeatedlyFailing'));
        }
      } finally {
        scanBusyRef.current = false;
      }
    };

    if (modelsLoaded) {
      if (authMode === 'login') refreshLoginNonce();
      intervalId = setInterval(detectTick, DETECT_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      microMotionTracker.reset();
      livenessChallenge.reset();
      pulseDetector.reset();
      boxMotionTracker.reset();
    };
  }, [authMode, modelsLoaded, suggestPasswordFallback, executeBiometricLogin, refreshLoginNonce, t]);

  // Keeps latestFaceBoxRef in sync with the box the detectTick loop above
  // just computed, so the fast pulse sampling loop below always reads a
  // current box without restarting itself every 350ms.
  useEffect(() => {
    latestFaceBoxRef.current = faceOverlayBox;
  }, [faceOverlayBox]);

  // rPPG PULSE SAMPLING LOOP (~20Hz) -- see AttendanceView.jsx's identical
  // effect for the full rationale; only runs in login mode (register mode's
  // capture-on-submit doesn't need continuous liveness).
  useEffect(() => {
    if (!modelsLoaded || authMode !== 'login') return;

    const PULSE_SAMPLE_INTERVAL_MS = 50;
    const timer = setInterval(() => {
      const box = latestFaceBoxRef.current;
      const video = videoRef.current;
      if (!box || !video || video.readyState < 2) return;

      try {
        if (!pulseCanvasRef.current) {
          pulseCanvasRef.current = document.createElement('canvas');
          pulseCanvasRef.current.width = 24;
          pulseCanvasRef.current.height = 24;
        }
        const canvas = pulseCanvasRef.current;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const sx = box.x + box.width * 0.25;
        const sy = box.y + box.height * 0.15;
        const sw = box.width * 0.5;
        const sh = box.height * 0.3;
        if (sw <= 0 || sh <= 0) return;
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, 24, 24);
        const region = ctx.getImageData(0, 0, 24, 24);
        pulseDetectorRef.current.addSample(calculateAverageGreenChannel(region.data), Date.now());
      } catch (_err) {
        // getImageData can throw on a tainted canvas in some browsers -- non-critical signal, skip this tick.
      }
    }, PULSE_SAMPLE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [modelsLoaded, authMode]);

  // Video is `object-cover`-scaled into the circular viewport and mirrored
  // via CSS -- shared with AttendanceView (vision/faceOverlayGeometry.js)
  // instead of each page keeping its own copy of the same math.
  const getFaceOverlayStyle = () => calculateFaceOverlayStyle({ box: faceOverlayBox, videoEl: videoRef.current });
  const getEyeOverlayStyle = (eyeBox) => calculateFaceOverlayStyle({ box: eyeBox, videoEl: videoRef.current });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (authMode === 'register') {
        // 🟩 REQUIRED ONBOARDING FIELDS: checked before touching the camera/
        // face capture at all -- no point running an expensive detection
        // pass just to then reject the submission for a missing text field.
        if (!institution.trim() || !position.trim() || !department.trim() || !contractStartDate || !contractEndDate) {
          throw new Error(t('login.errorMissingOnboardingFields'));
        }
        if (contractEndDate < contractStartDate) {
          throw new Error(t('login.errorContractDatesInvalid'));
        }
        if (!loaFile) {
          throw new Error(t('login.errorLoaRequired'));
        }
        const loaValidation = validateLoaFile(loaFile);
        if (!loaValidation.valid) {
          throw new Error(t('login.errorLoaInvalid'));
        }

        if (!videoRef.current || videoRef.current.readyState < 2) {
          throw new Error(t('login.errorCameraNotReady'));
        }

        setBiometricStatus(t('login.statusCapturing'));

        // 🟩 CROWD + LOW-LIGHT ROBUSTNESS: same canvas-with-brightness-boost
        // + detectAllFaces/selectPrimaryFace approach as the live scan loop,
        // so registering in a busy room reliably captures the person
        // actually sitting at the camera (not a bystander) even in a dim
        // room, instead of silently grabbing whichever face came first.
        const regWidth = videoRef.current.videoWidth;
        const regHeight = videoRef.current.videoHeight;
        const regCanvas = document.createElement('canvas');
        regCanvas.width = regWidth;
        regCanvas.height = regHeight;
        const regCtx = regCanvas.getContext('2d');
        regCtx.filter = isLowLightRef.current ? 'brightness(1.6) contrast(1.15)' : 'none';
        regCtx.drawImage(videoRef.current, 0, 0, regWidth, regHeight);
        regCtx.filter = 'none';

        const regDetections = await faceapiRef.current
          .detectAllFaces(
            regCanvas,
            // 🟩 STRICT REGISTRATION SCORE: 0.6 prevents the camera from
            // saving a blurry or poorly-lit face scan as the permanent
            // reference descriptor.
            new faceapiRef.current.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.6 })
          )
          .withFaceLandmarks()
          .withFaceDescriptors();

        const regCandidates = regDetections.map((d) => ({ box: d.detection.box, raw: d })).filter((d) => d.box);
        const { primary: regPrimary, isAmbiguous: regAmbiguous } = selectPrimaryFace(regCandidates, regWidth, regHeight);

        if (!regPrimary || regAmbiguous) {
          throw new Error(t('login.errorFaceUnclear'));
        }

        const detection = regPrimary.raw;
        const stringifiedDescriptor = JSON.stringify(Array.from(detection.descriptor));

        setBiometricStatus(t('login.statusCreatingAccount'));
        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { name, initials: initials.toUpperCase() } }
        });

        if (signUpError) throw signUpError;
        const newUser = signUpData?.user;
        if (!newUser) throw new Error(t('login.errorNoUuid'));

        setBiometricStatus(t('login.statusUploadingLoa'));
        // 🟩 LOA UPLOAD: signUp() above already establishes an authenticated
        // session for the new user (no email-confirmation gate on this
        // project), so auth.uid() resolves correctly for the storage RLS
        // check (own-folder-only) by the time this runs. Uploaded before
        // the profile upsert so a failure here doesn't leave a profile
        // row claiming a document that was never actually saved.
        const loaExt = sanitizeLoaExtension(loaFile.name);
        const loaFilePath = `${newUser.id}/loa_${Date.now()}.${loaExt}`;
        const { error: loaUploadError } = await supabase.storage.from('loa_documents').upload(loaFilePath, loaFile);
        if (loaUploadError) throw loaUploadError;

        setBiometricStatus(t('login.statusSavingProfile'));
        // 🟩 RELIABILITY: this upsert is keyed by id (onConflict: 'id'), so
        // retrying it is always safe — re-applying it with the same id
        // converges to the same row, it can never create a duplicate. A
        // short retry-with-backoff loop is more robust against the
        // auth-user -> profile-row-visibility propagation delay varying
        // under load than a single blind fixed-length wait, which can be
        // too short sometimes and is unconditionally slow always.
        let profileError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
          const result = await supabase
            .from('profiles')
            .upsert([{
              id: newUser.id,
              name,
              email,
              role: 'employee',
              initials: initials.toUpperCase(),
              face_descriptor: stringifiedDescriptor,
              source: institution.trim(),
              position: position.trim(),
              department: department.trim(),
              contract_start_date: contractStartDate,
              contract_end_date: contractEndDate,
              loa_file_path: loaFilePath,
            }], { onConflict: 'id' });
          profileError = result.error;
          if (!profileError) break;
        }

        if (profileError) throw profileError;

        setBiometricStatus(t('login.statusRegisterSuccess'));
        toast.success(t('login.faceSyncSuccessAlert'));

        setMessage(t('login.faceRegisteredMessage'));

      } else {
        const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
        if (loginError) throw loginError;
        // 🟩 NEW: only ever stores the email, never the password.
        if (rememberEmail) localStorage.setItem('login_rememberedEmail', email);
        else localStorage.removeItem('login_rememberedEmail');
      }
    } catch (err) {
      // Our own `new Error(t('login.error...'))` throws are already safe,
      // user-facing i18n strings. Anything else (raw Supabase auth/Postgres
      // errors — e.g. "duplicate key value violates unique constraint...")
      // carries a `code`/`status` and must not be shown verbatim, since it
      // can expose table/column/constraint names to the end user.
      console.error('[login] auth flow failed:', err);
      const isRawBackendError = err && (err.code !== undefined || err.status !== undefined);
      setError(isRawBackendError ? t('login.errorGenericAuthFailed') : err.message);
      setBiometricStatus(t('login.statusFailed'));
    } finally {
      setLoading(false);
    }
  };

  // 🟩 NEW: sends a real Supabase password-reset email -- the standard
  // "generate a reset link, user follows it, sets a new password on
  // Supabase's own hosted page" flow, no custom token handling needed on
  // this app's side. Doesn't reveal whether the email actually matches an
  // account (Supabase's own behavior) -- same "don't leak which emails
  // are registered" principle as everywhere else auth-adjacent in this app.
  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setForgotSubmitting(true);
    setForgotMessage('');
    setError('');
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(forgotEmail, {
        redirectTo: window.location.origin,
      });
      if (resetError) throw resetError;
      setForgotMessage(t('login.forgotPasswordSuccess'));
    } catch (err) {
      console.error('[login] password reset request failed:', err);
      setError(t('login.forgotPasswordError'));
    } finally {
      setForgotSubmitting(false);
    }
  };

  return (
    <div className="relative min-h-screen w-full flex flex-col md:flex-row font-sans">
      <div className="w-full md:w-1/2 bg-slate-900 flex items-center justify-center p-6 sm:p-8">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <img src={LoginLogo} alt="Logo" className="h-14 sm:h-16 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-white mb-1">{t('login.companyName')}</h2>
            <p className="text-blue-200 text-xs uppercase tracking-wider">{t('login.systemSubtitle')}</p>
          </div>

          {showForgotPassword ? (
            <form onSubmit={handleForgotPassword} className="space-y-4">
              <p className="text-blue-200 text-xs">{t('login.forgotPasswordHint')}</p>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40">{Icons.Mail}</span>
                <input
                  type="email"
                  placeholder={t('login.officialEmail')}
                  aria-label={t('login.officialEmail')}
                  value={forgotEmail}
                  onChange={e => setForgotEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500/70 focus:border-yellow-500/70 transition-colors"
                  required
                />
              </div>

              {forgotMessage && (
                <div role="status" className="text-emerald-300 text-xs bg-emerald-500/20 p-2 rounded flex items-center gap-2">
                  <span className="h-4 w-4 shrink-0 inline-flex">{Icons.CheckCircle}</span>
                  {forgotMessage}
                </div>
              )}
              {error && <div role="alert" className="text-red-300 text-xs bg-red-500/20 p-2 rounded">{error}</div>}

              <button
                type="submit"
                disabled={forgotSubmitting}
                className="w-full py-3 bg-gradient-to-r from-yellow-500 to-yellow-600 text-slate-900 font-bold rounded-lg uppercase text-sm tracking-wider shadow-md disabled:opacity-50 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:ring-offset-2 focus:ring-offset-slate-900"
              >
                {forgotSubmitting && <span className="animate-spin h-4 w-4 inline-flex">{Icons.Spinner}</span>}
                {t('login.sendResetLink')}
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowForgotPassword(false);
                  setForgotMessage('');
                  setError('');
                }}
                className="w-full flex items-center justify-center gap-1.5 text-blue-200 text-sm hover:text-white bg-transparent border-none cursor-pointer"
              >
                <span className="h-4 w-4 inline-flex">{Icons.ArrowLeft}</span>
                {t('login.backToLogin')}
              </button>
            </form>
          ) : (
          <>
          {authMode === 'login' && suggestPasswordFallback && (
            <div role="status" className="mb-4 text-xs bg-amber-500/15 border border-amber-500/30 text-amber-200 p-3 rounded-lg flex items-center justify-between gap-2">
              <span>{t('login.faceLoginStrugglingUsePassword')}</span>
              <button
                type="button"
                onClick={() => setBiometricFailCount(0)}
                className="shrink-0 underline hover:text-white bg-transparent border-none cursor-pointer font-bold"
              >
                {t('login.retryFaceLogin')}
              </button>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {authMode === 'register' && (
              <>
                <input
                  type="text"
                  placeholder={t('login.fullName')}
                  aria-label={t('login.fullName')}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500/70 focus:border-yellow-500/70 transition-colors"
                  required
                />
                <input
                  type="text"
                  placeholder={t('login.initials')}
                  aria-label={t('login.initials')}
                  value={initials}
                  onChange={e => setInitials(e.target.value)}
                  className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm uppercase focus:outline-none focus:ring-2 focus:ring-yellow-500/70 focus:border-yellow-500/70 transition-colors"
                  required
                  maxLength="2"
                />
                <input
                  type="text"
                  placeholder={t('login.institution')}
                  aria-label={t('login.institution')}
                  value={institution}
                  onChange={e => setInstitution(e.target.value)}
                  className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500/70 focus:border-yellow-500/70 transition-colors"
                  required
                />
                <input
                  type="text"
                  placeholder={t('login.position')}
                  aria-label={t('login.position')}
                  value={position}
                  onChange={e => setPosition(e.target.value)}
                  className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500/70 focus:border-yellow-500/70 transition-colors"
                  required
                />
                <input
                  type="text"
                  placeholder={t('login.department')}
                  aria-label={t('login.department')}
                  value={department}
                  onChange={e => setDepartment(e.target.value)}
                  className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500/70 focus:border-yellow-500/70 transition-colors"
                  required
                />
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="reg-contract-start" className="block text-[10px] font-bold text-blue-200 uppercase tracking-wider mb-1">{t('login.contractStart')}</label>
                    <input
                      id="reg-contract-start"
                      type="date"
                      value={contractStartDate}
                      onChange={e => setContractStartDate(e.target.value)}
                      className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500/70 focus:border-yellow-500/70 transition-colors"
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="reg-contract-end" className="block text-[10px] font-bold text-blue-200 uppercase tracking-wider mb-1">{t('login.contractEnd')}</label>
                    <input
                      id="reg-contract-end"
                      type="date"
                      value={contractEndDate}
                      onChange={e => setContractEndDate(e.target.value)}
                      className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500/70 focus:border-yellow-500/70 transition-colors"
                      required
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="reg-loa-file" className="block text-[10px] font-bold text-blue-200 uppercase tracking-wider mb-1">{t('login.loaDocument')}</label>
                  <input
                    id="reg-loa-file"
                    type="file"
                    accept=".pdf,.doc,.docx"
                    onChange={e => setLoaFile(e.target.files?.[0] || null)}
                    aria-label={t('login.loaDocument')}
                    className="w-full text-xs text-blue-200 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-blue-600 file:text-white hover:file:bg-blue-700 file:cursor-pointer cursor-pointer"
                    required
                  />
                  <p className="text-[9px] text-blue-200/70 mt-1">{t('login.loaDocumentHint')}</p>
                </div>
              </>
            )}

            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40">{Icons.Mail}</span>
              <input
                type="email"
                placeholder={t('login.officialEmail')}
                aria-label={t('login.officialEmail')}
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500/70 focus:border-yellow-500/70 transition-colors"
                required
              />
            </div>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/40">{Icons.Lock}</span>
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder={t('login.password')}
                aria-label={t('login.password')}
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyUp={e => setCapsLockOn(e.getModifierState && e.getModifierState('CapsLock'))}
                className="w-full pl-10 pr-10 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-500/70 focus:border-yellow-500/70 transition-colors"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(s => !s)}
                aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white bg-transparent border-none cursor-pointer p-0.5"
              >
                {showPassword ? Icons.EyeOff : Icons.Eye}
              </button>
            </div>
            {capsLockOn && (
              <p role="status" className="text-amber-300 text-xs -mt-2">{t('login.capsLockWarning')}</p>
            )}

            {authMode === 'login' && (
              <div className="flex items-center justify-between -mt-1">
                <label className="flex items-center gap-2 text-xs text-blue-200 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rememberEmail}
                    onChange={e => setRememberEmail(e.target.checked)}
                    className="rounded border-white/30 bg-white/10 text-yellow-500 focus:ring-yellow-500/70 focus:ring-offset-0"
                  />
                  {t('login.rememberEmail')}
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setShowForgotPassword(true);
                    setForgotEmail(email);
                    setForgotMessage('');
                    setError('');
                  }}
                  className="text-xs text-blue-200 hover:text-white underline bg-transparent border-none cursor-pointer"
                >
                  {t('login.forgotPassword')}
                </button>
              </div>
            )}

            {error && <div role="alert" className="text-red-300 text-xs bg-red-500/20 p-2 rounded">{error}</div>}
            {message && <div role="status" className="text-emerald-300 text-xs bg-emerald-500/20 p-2 rounded">{message}</div>}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-yellow-500 to-yellow-600 text-slate-900 font-bold rounded-lg uppercase text-sm tracking-wider shadow-md disabled:opacity-50 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:ring-offset-2 focus:ring-offset-slate-900"
            >
              {loading && <span className="animate-spin h-4 w-4 inline-flex">{Icons.Spinner}</span>}
              {loading ? t('login.processing') : authMode === 'register' ? t('login.registerAndScan') : t('login.signIn')}
            </button>
          </form>

          <div className="text-center mt-4">
            <button
              type="button"
              onClick={() => {
                setAuthMode(authMode === 'login' ? 'register' : 'login');
                setError('');
                setBiometricFailCount(0);
              }}
              className="text-blue-200 text-sm hover:text-white underline bg-transparent border-none cursor-pointer"
            >
              {authMode === 'login' ? t('login.noAccountYet') : t('login.haveAccount')}
            </button>
          </div>
          </>
          )}
        </div>
      </div>

      <div className="relative w-full md:w-1/2 bg-gradient-to-br from-blue-900 via-slate-950 to-indigo-950 flex flex-col items-center p-6 sm:p-8 py-10 justify-center">
        <div className="hidden md:block absolute top-4 right-4">
          <img src={LoginLogo} alt="Logo" className="h-10 w-auto opacity-60" />
        </div>

        <div className="relative w-64 h-64 sm:w-80 sm:h-80 md:w-96 md:h-96 bg-black rounded-3xl border-4 border-dashed border-blue-400 overflow-hidden flex items-center justify-center mb-4 shadow-[0_0_35px_rgba(59,130,246,0.2)]">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover rounded-3xl z-10"
            style={{ transform: 'scaleX(-1)' }}
          />

          {/* 🟩 ANTI-AUTOMATION: a WebDriver-controlled session gets a clear,
              specific block instead of a stuck/confusing camera prompt --
              the fix (use the password fields already on screen) is stated
              directly since there's nothing to retry here. */}
          {automationDetected && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-slate-950/95 text-center p-4 rounded-3xl">
              <span className="text-2xl" aria-hidden="true">🤖🚫</span>
              <h4 className="text-[11px] font-bold text-white leading-tight">{t('login.automationBlockedTitle')}</h4>
              <p className="text-[9px] text-slate-400 leading-relaxed">{t('login.automationBlockedBody')}</p>
            </div>
          )}

          {/* 🟩 SECURITY: a virtual/software camera driver (OBS Virtual
              Camera, ManyCam, etc.) supplying the feed instead of a real
              webcam -- see vision/virtualCameraDetector.js. */}
          {virtualCameraDetected && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-slate-950/95 text-center p-4 rounded-3xl">
              <span className="text-2xl" aria-hidden="true">📹🚫</span>
              <h4 className="text-[11px] font-bold text-white leading-tight">{t('login.virtualCameraBlockedTitle')}</h4>
              <p className="text-[9px] text-slate-400 leading-relaxed">{t('login.virtualCameraBlockedBody')}</p>
            </div>
          )}

          {/* 🟩 CAMERA FALLBACK: covers the (black/empty) video frame with an
              actionable, specific message instead of leaving it silently
              stuck on a generic "webcam unreachable" status pill. */}
          {cameraError && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-slate-950/95 text-center p-4 rounded-3xl">
              <span className="text-2xl" aria-hidden="true">📷🚫</span>
              <h4 className="text-[11px] font-bold text-white leading-tight">{t(CAMERA_ERROR_I18N_KEYS[cameraError].title)}</h4>
              <p className="text-[9px] text-slate-400 leading-relaxed">
                {t(CAMERA_ERROR_I18N_KEYS[cameraError].body)}
              </p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="mt-1 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[9px] font-bold text-slate-200 uppercase tracking-wider transition-colors"
              >
                {t('login.cameraErrorReload')}
              </button>
            </div>
          )}

          {faceOverlayBox && (
            <div
              className={`absolute border-2 rounded-xl z-[15] pointer-events-none transition-all duration-75 ${
                scanReadiness >= 100 ? 'border-emerald-400 bg-emerald-500/10 shadow-[0_0_15px_rgba(52,211,153,0.3)]' : 'border-blue-400 bg-blue-500/10 shadow-[0_0_15px_rgba(96,165,250,0.3)]'
              }`}
              style={getFaceOverlayStyle() || { display: 'none' }}
            />
          )}

          {/* 🟩 NEW: a box drawn around each eye that lights up the moment
              a blink closes it -- real-time visual proof the scan is
              actually reading your eyes, not just a status message the
              user has to trust. */}
          {eyeBoxes && (
            <>
              <div
                aria-hidden="true"
                className={`absolute border-2 rounded-md z-[16] pointer-events-none transition-all duration-75 ${
                  eyeBoxes.leftClosed ? 'border-emerald-400 bg-emerald-500/20 shadow-[0_0_10px_rgba(52,211,153,0.5)]' : 'border-cyan-300/70'
                }`}
                style={getEyeOverlayStyle(eyeBoxes.left) || { display: 'none' }}
              />
              <div
                aria-hidden="true"
                className={`absolute border-2 rounded-md z-[16] pointer-events-none transition-all duration-75 ${
                  eyeBoxes.rightClosed ? 'border-emerald-400 bg-emerald-500/20 shadow-[0_0_10px_rgba(52,211,153,0.5)]' : 'border-cyan-300/70'
                }`}
                style={getEyeOverlayStyle(eyeBoxes.right) || { display: 'none' }}
              />
            </>
          )}

          {/* 🟩 NEW: mouth/nose boxes -- a photo/screen literally cannot
              move its own lips or nostrils, so these light up on real
              movement as one more visible sign the scan is reading a live
              face, not just a status message. */}
          {mouthBox && (
            <div
              aria-hidden="true"
              className="absolute border-2 rounded-md z-[16] pointer-events-none transition-all duration-75 border-violet-300/70"
              style={getEyeOverlayStyle(mouthBox) || { display: 'none' }}
            />
          )}
          {noseBox && (
            <div
              aria-hidden="true"
              className="absolute border-2 rounded-md z-[16] pointer-events-none transition-all duration-75 border-violet-300/70"
              style={getEyeOverlayStyle(noseBox) || { display: 'none' }}
            />
          )}
        </div>

        {/* 🟩 MITIGATION: model download failed (flaky network, CDN hiccup,
            etc.) -- give the user a way to try again without a full reload. */}
        {modelsLoadFailed && (
          <button
            type="button"
            onClick={() => setModelLoadAttempt((n) => n + 1)}
            className="mb-4 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] font-bold text-slate-200 uppercase tracking-wider transition-colors"
          >
            {t('login.retryLoadingModels')}
          </button>
        )}

        {/* 🟩 UI: the directional challenge arrow, shown ABOVE the readiness
            bar (not cramped inside the frame overlay) -- big and prominent
            since it's the primary "what do I do right now" cue. */}
        <div className="h-10 flex items-center justify-center mb-1" aria-hidden={!challengeGlyph}>
          {challengeGlyph && (
            <span className="text-4xl animate-pulse" aria-hidden="true">{challengeGlyph}</span>
          )}
        </div>

        <div className="w-full max-w-[220px] sm:max-w-xs mb-3">
          <ScanReadinessBar readiness={scanReadiness} label={t('login.scanReadinessLabel')} />
        </div>

        {/* 🟩 UI: instruction/status text now lives below the bar, separate
            from the camera frame entirely, so a longer 2-step challenge
            instruction never crowds or gets clipped inside the frame. */}
        <p aria-live="polite" className="text-[11px] sm:text-xs font-bold text-blue-300 tracking-wide text-center max-w-xs uppercase px-4 mb-3 min-h-[2.5em]">
          {biometricStatus}
        </p>

        <h3 className="text-base sm:text-lg font-bold text-white mb-1 text-center px-4">{t('login.zeroTouchGate')}</h3>
        <p className="text-xs text-gray-400 tracking-wide text-center max-w-xs uppercase font-mono px-4">
          {scanReadiness >= 100
            ? (authMode === 'login' ? t('login.liveVerified') : t('login.statusMatrixVerified'))
            : (authMode === 'login' ? t('login.blinkToEnter') : t('login.statusFaceLocked'))}
        </p>
      </div>
    </div>
  );
}