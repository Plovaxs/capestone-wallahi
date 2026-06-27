import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../supabaseClient';
import LoginLogo from '../assets/customs-logo.jpg';
import * as faceapi from 'face-api.js';
import { toast } from 'react-hot-toast';

const LoginView = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [initials, setInitials] = useState('');
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);


  const [biometricStatus, setBiometricStatus] = useState('Position face for scan');

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const isMountedRef = useRef(false);
  const rafIdRef = useRef(null);
  const blinkTrackerRef = useRef({ leftClosed: false, rightClosed: false, blinkDetected: false });

  const EAR_THRESHOLD = 0.24;
  const FACE_DIST_THRESHOLD = 0.55;

  useEffect(() => {
    isMountedRef.current = true;

    const startWebcam = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' }
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error('Gagal buka kamera:', err);
        setBiometricStatus('Camera Failed');
      }
    };

    startWebcam();

    return () => {
      isMountedRef.current = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isMountedRef.current || !videoRef.current || videoRef.current.readyState < 2) return;

    const runFaceDetection = async () => {
      if (!isMountedRef.current) return;

      try {
        const detections = await faceapi.detectSingleFace(videoRef.current)
          .withFaceLandmarks()
          .withFaceDescriptor();

        if (detections) {
          const leftEye = detections.landmarks.getLeftEye();
          const rightEye = detections.landmarks.getRightEye();
          const leftEAR = computeEAR(leftEye);
          const rightEAR = computeEAR(rightEye);
          const avgEAR = (leftEAR + rightEAR) / 2;

          const tracker = blinkTrackerRef.current;
          if (avgEAR < EAR_THRESHOLD) {
            if (!tracker.leftClosed && !tracker.rightClosed) {
              tracker.leftClosed = true;
              tracker.rightClosed = true;
            }
          } else {
            if ((tracker.leftClosed && !tracker.rightClosed) || (!tracker.leftClosed && tracker.rightClosed)) {
              tracker.blinkDetected = true;
              tracker.leftClosed = false;
              tracker.rightClosed = false;
            }
          }

          if (tracker.blinkDetected) {
            setBiometricStatus('Liveness verified. Matching...');
            const descriptor = Array.from(detections.descriptor);
            await performBiometricLogin(descriptor);
            tracker.blinkDetected = false;
          } else {
            setBiometricStatus('Blink to authenticate');
          }
        } else {
          setBiometricStatus('No face detected');
        }
      } catch (err) {
        console.error('Face detection error:', err);
      }

      if (isMountedRef.current) {
        rafIdRef.current = requestAnimationFrame(runFaceDetection);
      }
    };

    rafIdRef.current = requestAnimationFrame(runFaceDetection);

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

   const computeEAR = (eye) => {
     if (!eye || eye.length < 6) return 1;
     
     // face-api.js urutan titik landmark mata (0 sampai 5):
     // 0: ujung kiri, 3: ujung kanan. 1&2: kelopak atas, 4&5: kelopak bawah.
     const p1 = eye[0];
     const p2 = eye[1];
     const p3 = eye[2];
     const p4 = eye[3];
     const p5 = eye[4];
     const p6 = eye[5];

     // Jarak Vertikal Kelopak Mata
     const v1 = Math.hypot(p2._x - p6._x, p2._y - p6._y);
     const v2 = Math.hypot(p3._x - p5._x, p3._y - p5._y);
     
     // Jarak Horizontal Panjang Mata
     const h = Math.hypot(p1._x - p4._x, p1._y - p4._y);

// Rumus Suci EAR: (Vertikal1 + Vertikal2) / (2 * Horizontal)
      return (v1 + v2) / (2.0 * h);
    };

    const euclideanDistance = (a, b) => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        sum += Math.pow(a[i] - b[i], 2);
      }
      return Math.sqrt(sum);
    };

  const performBiometricLogin = async (currentDescriptor) => {
    setLoading(true);
    setBiometricStatus('Matching...');
    setError('');

    try {
      const { data: profiles, error: fetchError } = await supabase
        .from('profiles')
        .select('id, email, role, face_descriptor');

      if (fetchError) throw fetchError;
      if (!profiles || profiles.length === 0) {
        setBiometricStatus('No profiles');
        setLoading(false);
        return;
      }

      let bestMatch = null;
      let minDistance = FACE_DISTANCE_THRESHOLD;

      for (const profile of profiles) {
        const storedDescriptor = profile.face_descriptor;
        if (!storedDescriptor || storedDescriptor.length !== currentDescriptor.length) continue;
        const distance = euclideanDistance(currentDescriptor, storedDescriptor);
        if (distance < minDistance) {
          minDistance = distance;
          bestMatch = profile;
        }
      }

      if (bestMatch) {
        setBiometricStatus('Authenticated! Redirecting...');
        setMessage(`Welcome, ${bestMatch.email}`);

        const biometricAuth = {
          user_id: bestMatch.user_id,
          email: bestMatch.email,
          role: bestMatch.role || 'employee',
          isBiometricAuthenticated: true,
          timestamp: Date.now()
        };

        localStorage.setItem('biometric_auth', JSON.stringify(biometricAuth));
        window.dispatchEvent(new CustomEvent('biometric_login_success', { detail: biometricAuth }));

        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
        }
        if (rafIdRef.current) {
          cancelAnimationFrame(rafIdRef.current);
        }

        setTimeout(() => window.location.reload(), 800);
      } else {
        setBiometricStatus('Unknown face');
        setError('Wajah tidak dikenali. Gunakan email/password.');
      }
    } catch (err) {
      console.error("Biometric auth error:", err);
      setError(`Gagal login: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
  e.preventDefault();
  setError('');
  setMessage('');
  setLoading(true);

  try {
    if (isRegisterMode) {
      // Pastikan kamera sudah siap
      if (!videoRef.current || videoRef.current.readyState < 2) {
        throw new Error('Kamera belum siap, tunggu frame-nya muncul.');
      }

      setBiometricStatus('Capturing biometrics...');

      // =======================
      // 1. DETECT FACE
      // =======================
      const detection = await faceapi.detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions({ 
        inputSize: 224, 
        scoreThreshold: 0.3 
      }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) {
        throw new Error('Muka tidak terdeteksi. Pastikan wajah berada di tengah lingkaran.');
      }

      const descriptorArray = Array.from(detection.descriptor);

      // =======================
      // 2. AUTH SIGN-UP
      // =======================
      setBiometricStatus('Creating account...');
      const { data: authData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name, initials: initials.toUpperCase() } },
      });

      if (signUpError) throw signUpError;
      const newUser = authData?.user;
      if (!newUser) throw new Error('Gagal dapatkan ID user dari Auth.');

      // =======================
      // 3. SAVE PROFILE + FACE DESCRIPTOR
      // =======================
      const { error: dbError } = await supabase
        .from('profiles')
        .insert([
          {
            id: newUser.id,
            name: name,
            email: email,
            role: 'employee',
            initials: initials.toUpperCase(),
            face_descriptor: descriptorArray,
          },
        ]);

      if (dbError) throw dbError;

      setBiometricStatus('Registrasi Berhasil!');
      toast.success('🔥 Akun + Wajah berhasil terdaftar!');
      setIsRegisterMode(false); // Kembali ke mode login
    } else {
      // =======================
      // 4. LOGIN MANUAL (PASSWORD)
      // =======================
      const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
      if (loginError) throw loginError;
    }
  } catch (err) {
    console.error('Submit Error:', err);
    setError(err.message);
    setBiometricStatus('Failed');
  } finally {
    setLoading(false);
  }
};

  return (
    <div className="relative min-h-screen w-full flex font-sans">
      {/* LEFT PANEL - FORM */}
      <div className="w-1/2 bg-slate-900 flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <img src={LoginLogo} alt="Logo" className="h-16 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-white mb-1">Bea Cukai</h2>
            <p className="text-blue-200 text-xs uppercase tracking-wider">Employee Monitoring System</p>
          </div>

          <div className="mb-6 flex flex-col items-center">
            <div className="relative w-56 h-56 bg-black rounded-xl overflow-hidden border-2 border-gray-600 mirror-x">
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover scale-x-[-1]" />
            </div>
            <p className="text-blue-300 text-xs mt-2 font-medium text-center">{biometricStatus}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {isRegisterMode && (
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text" placeholder="Nama Lengkap" value={name} onChange={(e) => setName(e.target.value)}
                  className="px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm" required
                />
                <input
                  type="text" placeholder="Inisial" value={initials} onChange={(e) => setInitials(e.target.value)}
                  className="px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm uppercase" required maxLength="2"
                />
              </div>
            )}

            <div>
              <input
                type="email" placeholder="Email Resmi" value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/50" required
              />
            </div>

            <div>
              <input
                type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/50" required
              />
            </div>

            {error && <div className="text-red-300 text-xs bg-red-500/20 p-2 rounded">{error}</div>}
            {message && <div className="text-emerald-300 text-xs bg-emerald-500/20 p-2 rounded">{message}</div>}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-md bg-gradient-to-r from-yellow-500 to-yellow-600 text-slate-900 font-bold hover:from-yellow-400 hover:to-yellow-500 disabled:opacity-50 uppercase tracking-wider text-sm shadow-md"
            >
              {loading ? 'Memproses...' : (loginMode ? 'Daftar + Scan Wajah 📸' : 'Masuk')}
            </button>
          </form>

          <div className="text-center mt-4">
            <button onClick={() => setIsRegisterMode(!isRegisterMode)} className="text-blue-200 text-sm hover:text-white underline">
              {isRegisterMode ? 'Sudah punya akun? Masuk' : 'Belum punya akun? Daftar'}
            </button>
          </div>
        </div>
      </div>

      {/* RIGHT PANEL - CAMERA BACKGROUND */}
      <div className="w-1/2 bg-gradient-to-br from-blue-900 via-slate-900 to-indigo-900 flex items-center justify-center overflow-hidden">
        <div className="text-center text-white/80">
          <div className="w-64 h-64 mx-auto mb-6 bg-black/30 rounded-full flex items-center justify-center">
            <div className="w-48 h-48 border-4 border-dashed border-blue-300 rounded-full animate-spin"></div>
          </div>
          <h3 className="text-xl font-bold text-white mb-2">Zero-Touch Biometric Gate</h3>
          <p className="text-blue-200 text-sm">Blink untuk otentikasi otomatis</p>
        </div>
      </div>
    </div>
  );
};

export default LoginView;