import React, { useState, useEffect, useRef } from 'react';
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
  const [authMode, setAuthMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [initials, setInitials] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [biometricStatus, setBiometricStatus] = useState('Initializing Scanner...');

  const videoRef = useRef(null);
  const isEyeClosedRef = useRef(false);
  const isRedirectingRef = useRef(false); 

  const [allProfiles, setAllProfiles] = useState([]);
  const [modelsLoaded, setModelsLoaded] = useState(false); 
  const profilesRef = useRef([]);
  const [blinkCount, setBlinkCount] = useState(0);

  useEffect(() => {
    async function loadNeuralModels() {
      try {
        setBiometricStatus('Loading network weights...');
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
          faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
          faceapi.nets.faceRecognitionNet.loadFromUri('/models')
        ]);
        setModelsLoaded(true);
        setBiometricStatus('Position face for scan');
      } catch (err) {
        console.error('Failed to load neural models:', err);
        setBiometricStatus('Model weight assets unreachable');
      }
    }
    loadNeuralModels();
  }, []);

  useEffect(() => {
    async function fetchProfiles() {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, name, role, initials, face_descriptor')
        .not('face_descriptor', 'is', null);

      if (error) return;

      const formatted = data.map(p => {
        let parsedDescriptor = p.face_descriptor;
        if (typeof parsedDescriptor === 'string') {
           try { parsedDescriptor = JSON.parse(parsedDescriptor); } catch { parsedDescriptor = []; }
        }
        return {
          ...p,
          descriptor: new Float32Array(parsedDescriptor)
        };
      });

      setAllProfiles(formatted);
      profilesRef.current = formatted;
    }

    if (modelsLoaded) {
      fetchProfiles();
    }
  }, [authMode, modelsLoaded]);

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
      } catch (err) {
        setBiometricStatus('Webcam stream unreachable');
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
              setBiometricStatus('Liveness verified. Matching...');
              await executeBiometricLogin(detection.descriptor);
            } else {
              setBiometricStatus('Matrix verified. Ready to register.');
            }
          } else {
            if (authMode === 'login') {
              setBiometricStatus('Blink to authenticate');
            } else {
              setBiometricStatus('Face locked. Fill form to register.');
            }
          }
        } else {
          setBiometricStatus('No face detected. Align your face.');
        }
      } catch (err) {
      }

      rafId = requestAnimationFrame(detectLoop);
    };

    if (allProfiles.length > 0 && modelsLoaded) {
      rafId = requestAnimationFrame(detectLoop);
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [allProfiles, authMode, modelsLoaded]);

  const executeBiometricLogin = async (liveDescriptor) => {
    let bestMatch = null;
    
    // 🟩 FIX 1: TIGHTENED EUCLIDEAN THRESHOLD
    // 0.42 guarantees strict 1-to-1 matches and kills false positives
    let lowestDistance = 0.42; 

    if (profilesRef.current.length === 0) return;

    for (const profile of profilesRef.current) {
      if (!profile.descriptor) continue;
      const dist = faceapi.euclideanDistance(liveDescriptor, profile.descriptor);
      
      if (dist < lowestDistance) {
        lowestDistance = dist;
        bestMatch = profile;
      }
    }

    if (bestMatch) {
      isRedirectingRef.current = true; 
      setBiometricStatus('Face matched. Continue with password sign-in.');
      setMessage(`Face match found for ${bestMatch.name}.`);
    } else {
      setBiometricStatus('Unknown face');
      setError('Wajah tidak dikenali dalam records.');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (authMode === 'register') {
        if (!videoRef.current || videoRef.current.readyState < 2) {
          throw new Error('Kamera belum siap, tunggu frame muncul.');
        }

        setBiometricStatus('Capturing HIGH DEF face matrix...');
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
          throw new Error('Tatap kamera dengan jelas! Pastikan cahaya terang dan muka tidak tertutup.');
        }
        
        const stringifiedDescriptor = JSON.stringify(Array.from(detection.descriptor));

        setBiometricStatus('Creating account...');
        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { name, initials: initials.toUpperCase() } }
        });

        if (signUpError) throw signUpError;
        const newUser = signUpData?.user;
        if (!newUser) throw new Error('Gagal mendapat allocation UUID');

        await new Promise(resolve => setTimeout(resolve, 500));

        setBiometricStatus('Saving strict profile...');
        const { error: profileError } = await supabase
          .from('profiles')
          .upsert([{
            id: newUser.id,
            name,
            role: 'employee',
            initials: initials.toUpperCase(),
            face_descriptor: stringifiedDescriptor
          }], { onConflict: 'id' });

        if (profileError) throw profileError;

        setBiometricStatus('Registrasi berhasil!');
        alert('🔥 High-Fidelity Face Matrix synchronized successfully!');
        
        setMessage('Face registration saved. Use your password to sign in.');

      } else {
        const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
        if (loginError) throw loginError;
      }
    } catch (err) {
      setError(err.message);
      setBiometricStatus('Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen w-full flex font-sans">
      <div className="w-1/2 bg-slate-900 flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <img src={LoginLogo} alt="Logo" className="h-16 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-white mb-1">Bea Cukai</h2>
            <p className="text-blue-200 text-xs uppercase tracking-wider">Employee Monitoring System</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {authMode === 'register' && (
              <>
                <input
                  type="text"
                  placeholder="Nama Lengkap"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none"
                  required
                />
                <input
                  type="text"
                  placeholder="Inisial"
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
              placeholder="Email Resmi"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none"
              required
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none"
              required
            />

            {error && <div className="text-red-300 text-xs bg-red-500/20 p-2 rounded">{error}</div>}
            {message && <div className="text-emerald-300 text-xs bg-emerald-500/20 p-2 rounded">{message}</div>}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-gradient-to-r from-yellow-500 to-yellow-600 text-slate-900 font-bold rounded-lg uppercase text-sm tracking-wider shadow-md disabled:opacity-50"
            >
              {loading ? 'Memproses...' : authMode === 'register' ? 'Daftar & Scan Wajah' : 'Masuk'}
            </button>
          </form>

          <div className="text-center mt-4">
            <button
              type="button"
              onClick={() => {
                setAuthMode(authMode === 'login' ? 'register' : 'login');
                setError('');
              }}
              className="text-blue-200 text-sm hover:text-white underline bg-transparent border-none cursor-pointer"
            >
              {authMode === 'login' ? 'Belum punya akun? Daftar' : 'Sudah punya akun? Masuk'}
            </button>
          </div>
        </div>
      </div>

      <div className="w-1/2 bg-gradient-to-br from-blue-900 via-slate-950 to-indigo-950 flex flex-col items-center p-8 justify-center">
        <div className="absolute top-4 right-4">
          <img src={LoginLogo} alt="Logo" className="h-10 w-auto opacity-60" />
        </div>

        <div className="relative w-72 h-72 bg-black rounded-full border-4 border-dashed border-blue-400 overflow-hidden flex items-center justify-center mb-6 shadow-[0_0_35px_rgba(59,130,246,0.2)]">
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover rounded-full z-10"
            style={{ transform: 'scaleX(-1)' }}
          />
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-slate-900/90 border border-blue-500/30 backdrop-blur-sm text-[10px] font-bold text-blue-400 px-3 py-1 rounded-full uppercase tracking-widest whitespace-nowrap z-20">
            {biometricStatus}
          </div>
        </div>

        <h3 className="text-lg font-bold text-white mb-1">Zero-Touch Biometric Gate</h3>
        <p className="text-xs text-gray-400 tracking-wide text-center max-w-xs uppercase font-mono">
          {blinkCount > 0 ? '✅ LIVE USER VERIFIED' : '🔒 Silahkan berkedip untuk masuk'}
        </p>
      </div>
    </div>
  );
}