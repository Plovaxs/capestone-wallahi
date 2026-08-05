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
  const isLowLightRef = useRef(false); // 🟩 NEW: sustained-dark-read streak flips this on to boost brightness/contrast on the capture canvas
  const lowLightStreakRef = useRef(0);
  const microMotionTrackerRef = useRef(createMicroMotionTracker()); // 🟩 NEW: same pixel-variance liveness signal used on Attendance's clock-in scan

  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [scanReadiness, setScanReadiness] = useState(0); // 🟩 NEW: 0-100 "how close to a good capture" score driving the readiness bar
  const [faceOverlayBox, setFaceOverlayBox] = useState(null); // 🟩 NEW: bounding box drawn around the detected face, same visual language as AttendanceView

  useEffect(() => {
    async function loadNeuralModels() {
      try {
        setBiometricStatus(t('login.statusLoadingModels'));
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
          faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
          faceapi.nets.faceRecognitionNet.loadFromUri('/models')
        ]);
        setModelsLoaded(true);
        setBiometricStatus(t('login.statusPositionFace'));
      } catch (err) {
        console.error('Failed to load neural models:', err);
        setBiometricStatus(t('login.statusModelsUnreachable'));
      }
    }
    loadNeuralModels();
  }, []);

  useEffect(() => {
    let localStream = null;
    let isCurrent = true;

    async function startVideo() {
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
      } catch (_err) {
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

  // 🟩 FACE BOX POSITIONING: same math as AttendanceView's getFaceOverlayStyle
  // (video is `object-cover`-scaled into the circular viewport and mirrored
  // via CSS, so the box has to be scaled/offset and horizontally flipped to
  // land on the actual face instead of the un-mirrored raw coordinates).
  const getFaceOverlayStyle = () => {
    if (!faceOverlayBox || !videoRef.current) return null;

    const videoEl = videoRef.current;
    const naturalWidth = videoEl.videoWidth || faceOverlayBox.imageWidth;
    const naturalHeight = videoEl.videoHeight || faceOverlayBox.imageHeight;
    const viewportWidth = videoEl.clientWidth || 0;
    const viewportHeight = videoEl.clientHeight || 0;

    if (!naturalWidth || !naturalHeight || !viewportWidth || !viewportHeight) return null;

    const naturalRatio = naturalWidth / naturalHeight;
    const viewportRatio = viewportWidth / viewportHeight;

    let displayedWidth = viewportWidth;
    let displayedHeight = viewportHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (viewportRatio > naturalRatio) {
      displayedHeight = viewportHeight;
      displayedWidth = viewportHeight * naturalRatio;
      offsetX = (viewportWidth - displayedWidth) / 2;
    } else {
      displayedWidth = viewportWidth;
      displayedHeight = viewportWidth / naturalRatio;
      offsetY = (viewportHeight - displayedHeight) / 2;
    }

    const scaleX = displayedWidth / naturalWidth;
    const scaleY = displayedHeight / naturalHeight;

    const boxWidth = faceOverlayBox.width * scaleX;
    const boxHeight = faceOverlayBox.height * scaleY;

    const standardLeft = offsetX + (faceOverlayBox.x * scaleX);
    const mirroredLeft = viewportWidth - standardLeft - boxWidth;

    return {
      left: `${mirroredLeft}px`,
      top: `${offsetY + (faceOverlayBox.y * scaleY)}px`,
      width: `${boxWidth}px`,
      height: `${boxHeight}px`,
    };
  };

  const executeBiometricLogin = async (liveDescriptor) => {
       isRedirectingRef.current = true;
   setBiometricStatus(t('login.statusVerifyingServer'));

   const { data, error } = await supabase.functions.invoke('biometric-login', {
     body: { descriptor: Array.from(liveDescriptor) },
   });

   if (error || !data?.token_hash) {
     isRedirectingRef.current = false;
     setError(t('login.errorFaceNotRecognized'));
     setBiometricFailCount((prev) => prev + 1);
     return;
   }

   // Exchange the server-issued token for a real, verified session.
   const { error: verifyError } = await supabase.auth.verifyOtp({
     token_hash: data.token_hash,
     type: 'magiclink',
   });

   if (verifyError) {
     isRedirectingRef.current = false;
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