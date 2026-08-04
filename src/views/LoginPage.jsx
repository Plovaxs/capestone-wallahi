import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import * as faceapi from 'face-api.js';
import { supabase } from '../supabaseClient';
import LoginLogo from '../assets/customs-logo.jpg';

function calculateEAR(eyeLandmarks) {
  if (!eyeLandmarks || eyeLandmarks.length < 6) return 1;

  const p2 = eyeLandmarks[1];
  const p3 = eyeLandmarks[2];
  const p6 = eyeLandmarks[5];
  const p5 = eyeLandmarks[4];
  const p1 = eyeLandmarks[0];
  const p4 = eyeLandmarks[3];

  const point = (p) => ({ x: p.x ?? p._x, y: p.y ?? p._y });
  const a = point(p1);
  const b = point(p2);
  const c = point(p3);
  const d = point(p4);
  const e = point(p5);
  const f = point(p6);

  const distVert1 = Math.hypot(b.x - f.x, b.y - f.y);
  const distVert2 = Math.hypot(c.x - e.x, c.y - e.y);
  const distHoriz = Math.hypot(a.x - d.x, a.y - d.y);

  if (distHoriz === 0) return 1;
  return (distVert1 + distVert2) / (2.0 * distHoriz);
}

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
  const isEyeClosedRef = useRef(false);
  const isRedirectingRef = useRef(false);
  const lastAttemptRef = useRef(0);
  const ATTEMPT_COOLDOWN_MS = 4000;

  const [modelsLoaded, setModelsLoaded] = useState(false); 
  const [blinkCount, setBlinkCount] = useState(0);

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
    let rafId = null;

    const detectLoop = async () => {
      if (isRedirectingRef.current || !modelsLoaded) return;

      if (!videoRef.current || videoRef.current.videoWidth === 0 || videoRef.current.videoHeight === 0) {
        rafId = requestAnimationFrame(detectLoop);
        return;
      }

      try {
        const detection = await faceapi
          .detectSingleFace(
            videoRef.current,
            // Low threshold here is fine just for finding eyes/blinks quickly
            new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.15 })
          )
          .withFaceLandmarks()
          .withFaceDescriptor();

        if (detection) {
          const leftEAR = calculateEAR(detection.landmarks.getLeftEye());
          const rightEAR = calculateEAR(detection.landmarks.getRightEye());
          const avgEAR = (leftEAR + rightEAR) / 2;

          if (avgEAR < 0.26) {
            isEyeClosedRef.current = true;
          } else if (isEyeClosedRef.current) {
            isEyeClosedRef.current = false;
            setBlinkCount(p => p + 1);
            
            if (authMode === 'login') {
              if (suggestPasswordFallback) {
                setBiometricStatus(t('login.statusUsePasswordInstead'));
              } else {
                const now = Date.now();
                if (now - lastAttemptRef.current < ATTEMPT_COOLDOWN_MS) {
                  // Ignore blinks/noise while still cooling down from the last attempt
                  setBiometricStatus(t('login.statusPleaseWait'));
                } else {
                  lastAttemptRef.current = now;
                  setBiometricStatus(t('login.statusLivenessVerified'));
                  await executeBiometricLogin(detection.descriptor);
                }
              }
            } else {
              setBiometricStatus(t('login.statusMatrixVerified'));
            }
          } else {
            if (authMode === 'login') {
              setBiometricStatus(t('login.statusBlinkToAuth'));
            } else {
              setBiometricStatus(t('login.statusFaceLocked'));
            }
          }
        } else {
          setBiometricStatus(t('login.statusNoFace'));
        }
      } catch (err) {
        console.error('Face detection error:', err);
      }

      rafId = requestAnimationFrame(detectLoop);
    };

    if (modelsLoaded) {
      rafId = requestAnimationFrame(detectLoop);
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [authMode, modelsLoaded, suggestPasswordFallback]);

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
        const detection = await faceapi
          .detectSingleFace(
            videoRef.current,
            // 🟩 FIX 2: STRICT REGISTRATION SCORE
            // 0.6 prevents the camera from saving blurry or poorly lit face scans
            new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.6 })
          )
          .withFaceLandmarks()
          .withFaceDescriptor();

        if (!detection) {
          throw new Error(t('login.errorFaceUnclear'));
        }

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
          <div aria-live="polite" className="absolute bottom-3 sm:bottom-4 left-1/2 -translate-x-1/2 w-[85%] bg-slate-900/90 border border-blue-500/30 backdrop-blur-sm text-[9px] sm:text-[10px] font-bold text-blue-400 px-2 sm:px-3 py-1 rounded-2xl uppercase tracking-widest text-center leading-tight z-20">
            {biometricStatus}
          </div>
        </div>

        <h3 className="text-base sm:text-lg font-bold text-white mb-1 text-center px-4">{t('login.zeroTouchGate')}</h3>
        <p className="text-xs text-gray-400 tracking-wide text-center max-w-xs uppercase font-mono px-4">
          {blinkCount > 0 ? t('login.liveVerified') : t('login.blinkToEnter')}
        </p>
      </div>
    </div>
  );
}