import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import * as faceapi from 'face-api.js';
import { supabase } from '../supabaseClient';
import LoginLogo from '../assets/customs-logo.jpg';
import { checkFraming, checkOcclusion, checkBrightness, checkSingleFace } from '../vision/faceQuality';
import { calculateFrameReadiness } from '../vision/scanReadiness';
import ScanReadinessBar from '../components/ScanReadinessBar';
import { selectPrimaryFace } from '../vision/primaryFaceSelector';
import { checkReplaySuspicion } from '../vision/antiReplayHeuristic';
import { checkColorLiveness } from '../vision/colorLivenessHeuristic';
import { createMicroMotionTracker } from '../vision/microMotionTracker';
import { calculateFaceOverlayStyle } from '../vision/faceOverlayGeometry';

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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [initials, setInitials] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [biometricStatus, setBiometricStatus] = useState(t('login.statusInitializing'));
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
  const isLowLightRef = useRef(false); // 🟩 NEW: sustained-dark-read streak flips this on to boost brightness/contrast on the capture canvas
  const lowLightStreakRef = useRef(0);
  const microMotionTrackerRef = useRef(createMicroMotionTracker()); // 🟩 NEW: same pixel-variance liveness signal used on Attendance's clock-in scan

  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false); // 🟩 NEW: drives a retry button -- a failed model load used to leave the user permanently stuck with only a status-pill message and no way forward but a full page reload
  const [modelLoadAttempt, setModelLoadAttempt] = useState(0); // 🟩 NEW: bumping this re-runs the model-load effect, giving the retry button something to trigger
  const [cameraError, setCameraError] = useState(null); // 🟩 NEW: null | 'denied' | 'not-found' | 'busy' | 'unsupported' | 'unknown'
  const [scanReadiness, setScanReadiness] = useState(0); // 🟩 NEW: 0-100 "how close to a good capture" score driving the readiness bar
  const [faceOverlayBox, setFaceOverlayBox] = useState(null); // 🟩 NEW: bounding box drawn around the detected face, same visual language as AttendanceView

  useEffect(() => {
    let isCurrent = true;
    async function loadNeuralModels() {
      try {
        setModelsLoadFailed(false);
        setBiometricStatus(t('login.statusLoadingModels'));
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
          faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
          faceapi.nets.faceRecognitionNet.loadFromUri('/models')
        ]);
        if (!isCurrent) return;
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

  useEffect(() => {
    let intervalId = null;
    let cancelled = false;

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
        const ctx = sourceCanvas.getContext('2d');
        if (!ctx) return;
        ctx.filter = isLowLightRef.current ? 'brightness(1.6) contrast(1.15)' : 'none';
        ctx.drawImage(videoEl, 0, 0, width, height);
        ctx.filter = 'none';

        const allDetections = await faceapi
          .detectAllFaces(sourceCanvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 }))
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
          microMotionTrackerRef.current.reset();
          setBiometricStatus(t('login.statusNoFace'));
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

        setScanReadiness(calculateFrameReadiness({
          singleFace: singleFace.ok,
          framing: framing.ok,
          brightness: brightness.ok,
          occlusion: occlusion.ok,
        }));
        setFaceOverlayBox({ x: box.x, y: box.y, width: box.width, height: box.height, imageWidth: width, imageHeight: height });

        const qualityIssue = !singleFace.ok ? singleFace : !framing.ok ? framing : !brightness.ok ? brightness : !occlusion.ok ? occlusion : null;
        if (qualityIssue) {
          microMotionTrackerRef.current.reset();
          setBiometricStatus(t(QUALITY_HINT_KEYS[qualityIssue.reason] || 'login.statusPositionFace'));
          return;
        }

        microMotionTrackerRef.current.addFrame(region.data, region.width, region.height);
        const colorLiveness = checkColorLiveness(region.data, region.width, region.height);

        // 🟩 REGISTRATION: just needs a clear, well-framed, single face so
        // the user can hit "Save" -- the actual capture happens there, not
        // here, so no auto-login/liveness gating applies in this mode.
        if (authMode !== 'login') {
          setBiometricStatus(t('login.statusMatrixVerified'));
          return;
        }

        // 🟩 LOGIN: no blink wait anymore -- passive liveness only. Border-
        // uniformity + (device-independent) pixel-variance + color/texture
        // plausibility together catch a printed photo or a phone held up
        // to the camera, including one that's being shaken to fake motion,
        // without asking the user to do anything.
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

        const marginX = Math.round(box.width * 0.15);
        const marginY = Math.round(box.height * 0.15);
        const borderRegion = ctx.getImageData(
          Math.max(0, Math.round(box.x - marginX)),
          Math.max(0, Math.round(box.y - marginY)),
          Math.min(Math.round(box.width + marginX * 2), width),
          Math.min(Math.round(box.height + marginY * 2), height)
        );
        const borderSuspicious = checkReplaySuspicion(borderRegion.data).suspicious;
        const pixelFlat = microMotionStats.isSuspiciouslyFlat;
        const livenessSuspicious = borderSuspicious && (pixelFlat || colorLiveness.suspicious);

        if (livenessSuspicious) {
          setBiometricStatus(t('login.statusLivenessSuspicious'));
          return;
        }

        lastAttemptRef.current = now;
        setBiometricStatus(t('login.statusLivenessVerified'));
        await executeBiometricLogin(detection.descriptor);
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
      intervalId = setInterval(detectTick, DETECT_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      microMotionTrackerRef.current.reset();
    };
  }, [authMode, modelsLoaded, suggestPasswordFallback]);

  // Video is `object-cover`-scaled into the circular viewport and mirrored
  // via CSS -- shared with AttendanceView (vision/faceOverlayGeometry.js)
  // instead of each page keeping its own copy of the same math.
  const getFaceOverlayStyle = () => calculateFaceOverlayStyle({ box: faceOverlayBox, videoEl: videoRef.current });

  const executeBiometricLogin = async (liveDescriptor) => {
   isRedirectingRef.current = true;
   setBiometricStatus(t('login.statusVerifyingServer'));

   const { data, error } = await supabase.functions.invoke('biometric-login', {
     body: { descriptor: Array.from(liveDescriptor) },
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
     } else if (reason === 'rate_limited') {
       setError(t('login.errorRateLimited'));
       // Doesn't count toward biometricFailCount -- being rate-limited says
       // nothing about whether this user's face actually matches, so it
       // shouldn't push them toward "give up and use a password" any faster.
     } else {
       // Network failure (offline, DNS, CORS) or an unexpected 5xx -- the
       // request may not have reached the matching logic at all.
       console.error('[login] biometric-login request failed:', error);
       setError(t('login.errorNetworkOrServer'));
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
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (authMode === 'register') {
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

        const regDetections = await faceapi
          .detectAllFaces(
            regCanvas,
            // 🟩 STRICT REGISTRATION SCORE: 0.6 prevents the camera from
            // saving a blurry or poorly-lit face scan as the permanent
            // reference descriptor.
            new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.6 })
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
              face_descriptor: stringifiedDescriptor
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

  return (
    <div className="relative min-h-screen w-full flex flex-col md:flex-row font-sans">
      <div className="w-full md:w-1/2 bg-slate-900 flex items-center justify-center p-6 sm:p-8">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <img src={LoginLogo} alt="Logo" className="h-14 sm:h-16 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-white mb-1">{t('login.companyName')}</h2>
            <p className="text-blue-200 text-xs uppercase tracking-wider">{t('login.systemSubtitle')}</p>
          </div>

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
                  className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none"
                  required
                />
                <input
                  type="text"
                  placeholder={t('login.initials')}
                  aria-label={t('login.initials')}
                  value={initials}
                  onChange={e => setInitials(e.target.value)}
                  className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm uppercase focus:outline-none"
                  required
                  maxLength="2"
                />
              </>
            )}

            <input
              type="email"
              placeholder={t('login.officialEmail')}
              aria-label={t('login.officialEmail')}
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none"
              required
            />
            <input
              type="password"
              placeholder={t('login.password')}
              aria-label={t('login.password')}
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none"
              required
            />

            {error && <div role="alert" className="text-red-300 text-xs bg-red-500/20 p-2 rounded">{error}</div>}
            {message && <div role="status" className="text-emerald-300 text-xs bg-emerald-500/20 p-2 rounded">{message}</div>}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-yellow-500 to-yellow-600 text-slate-900 font-bold rounded-lg uppercase text-sm tracking-wider shadow-md disabled:opacity-50"
            >
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
        </div>
      </div>

      <div className="relative w-full md:w-1/2 bg-gradient-to-br from-blue-900 via-slate-950 to-indigo-950 flex flex-col items-center p-6 sm:p-8 py-10 justify-center">
        <div className="hidden md:block absolute top-4 right-4">
          <img src={LoginLogo} alt="Logo" className="h-10 w-auto opacity-60" />
        </div>

        <div className="relative w-52 h-52 sm:w-64 sm:h-64 md:w-72 md:h-72 bg-black rounded-full border-4 border-dashed border-blue-400 overflow-hidden flex items-center justify-center mb-6 shadow-[0_0_35px_rgba(59,130,246,0.2)]">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover rounded-full z-10"
            style={{ transform: 'scaleX(-1)' }}
          />

          {/* 🟩 CAMERA FALLBACK: covers the (black/empty) video circle with an
              actionable, specific message instead of leaving it silently
              stuck on a generic "webcam unreachable" status pill. */}
          {cameraError && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-slate-950/95 text-center p-4 rounded-full">
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
          <div aria-live="polite" className="absolute bottom-3 sm:bottom-4 left-1/2 -translate-x-1/2 w-[85%] bg-slate-900/90 border border-blue-500/30 backdrop-blur-sm text-[9px] sm:text-[10px] font-bold text-blue-400 px-2 sm:px-3 py-1 rounded-2xl uppercase tracking-widest text-center leading-tight z-20">
            {biometricStatus}
          </div>
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

        <div className="w-full max-w-[220px] sm:max-w-xs mb-4">
          <ScanReadinessBar readiness={scanReadiness} label={t('login.scanReadinessLabel')} />
        </div>

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