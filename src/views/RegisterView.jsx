import React, { useRef, useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import RegisterLogo from '../assets/customs-logo.jpg';
import * as faceapi from 'face-api.js';

const RegisterView = () => {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  
  // State Form Register (sinkron ama input UI)
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [initials, setInitials] = useState('');
  const [registrationInProgress, setRegistrationInProgress] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // 1. HIDUPKAN WEBCAM OTOMATIS SAAT HALAMAN DIBUKA
  useEffect(() => {
    let isMounted = true;

    const startWebcam = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { width: 640, height: 480, facingMode: 'user' } 
        });
        if (isMounted && videoRef.current) {
          videoRef.current.srcObject = stream;
          streamRef.current = stream;
        }
      } catch (err) {
        console.error("Gagal akses webcam:", err);
        alert("Gagal buka kamera. Pastiin gak dipake aplikasi lain, wir!");
      }
    };

    startWebcam();

    // CLEANUP SAKTI: Matikan kamera total pas pindah halaman
    return () => {
      isMounted = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        console.info("🎯 Register webcam stream safely terminated.");
      }
    };
  }, []);

  // 2. FUNGSI REGISTER + BIOMETRIC CAPTURE
  const handleRegister = async (e) => {
    if (e) e.preventDefault();
    if (registrationInProgress) return;
    
    if (!email || !password) {
      alert("Isi email ama password dulu, wir!");
      return;
    }

    setRegistrationInProgress(true);

    try {
      // Guard pengecekan frame video HTML5
      if (!videoRef.current || videoRef.current.readyState < 2) {
        alert("Kamera belum siap atau frame belum ready, tunggu bentar wir!");
        setRegistrationInProgress(false);
        return;
      }

      // Scan Muka Detik Itu Juga
      const detection = await faceapi.detectSingleFace(videoRef.current)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!detection) {
        alert("Muka lo belum kedeteksi ama AI, wir! Pasin posisi muka ke kamera.");
        setRegistrationInProgress(false);
        return;
      }

      // Eksekusi Register Akun ke Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: email,
        password: password,
        options: { data: { name, initials: initials.toUpperCase() } }
      });

      if (authError) {
        alert(`Auth Error: ${authError.message}`);
        setRegistrationInProgress(false);
        return;
      }

      const newUser = authData?.user;
      if (!newUser) {
        alert("Gagal dapet data user baru. Coba cek konfigurasi email confirmation.");
        setRegistrationInProgress(false);
        return;
      }

    // Convert Face Descriptor to a clean JavaScript Array
      const faceDescriptorArray = Array.from(detection.descriptor);

      // ✅ FIX: Use .upsert() instead of .insert() to prevent trigger duplication errors,
      // and explicitly provide all missing profile fields gathered from your form inputs.
      const { data: profiles, error: profileError } = await supabase
        .from('profiles')
        .upsert([{
          id: newUser.id,
          name: name,
          email: email,
          role: 'employee',
          initials: initials.toUpperCase(),
          face_descriptor: faceDescriptorArray
        }], { onConflict: 'id' }); // Overwrites safely if the row already exists

      if (profileError) {
        console.error("Failed to save profile biometrics:", profileError);
        alert(`Account created, but profile could not be initialized: ${profileError.message}`);
      } else {
        alert("🔥 REGISTRATION SUCCESSFUL: Account and face descriptors synced!");
        window.location.href = '/';
      }

    } catch (error) {
      console.error("Fatal registration error:", error);
      alert("Terjadi kesalahan fatal sistem.");
    } finally {
      setRegistrationInProgress(false);
    }
  };

  return (
    <div className="relative min-h-screen w-full flex font-sans">
      {/* LEFT PANEL - FORM */}
      <div className="w-1/2 bg-slate-900 flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <img src={RegisterLogo} alt="Logo" className="h-16 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-white mb-1">Bea Cukai</h2>
            <p className="text-blue-200 text-xs uppercase tracking-wider">Registrasi Akun</p>
          </div>

          <form onSubmit={handleRegister} className="space-y-4">
            <div>
              <input
                type="text" 
                value={name} 
                onChange={(e) => setName(e.target.value)}
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/50"
                placeholder="Nama Lengkap"
                required
              />
            </div>
            <div>
              <input
                type="text" 
                value={initials} 
                onChange={(e) => setInitials(e.target.value)}
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm uppercase focus:outline-none focus:ring-2 focus:ring-yellow-400/50"
                placeholder="Inisial (maks 2 huruf)"
                required 
                maxLength="2"
              />
            </div>
            <div>
              <input
                type="email" 
                value={email} 
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/50"
                placeholder="Email Resmi"
                required
              />
            </div>

            <div>
              <input
                type="password" 
                value={password} 
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/50"
                placeholder="Password"
                required
              />
            </div>

            {error && <div className="text-red-300 text-xs bg-red-500/20 p-2 rounded">{error}</div>}
            {message && <div className="text-emerald-300 text-xs bg-emerald-500/20 p-2 rounded">{message}</div>}

            <button
              type="submit"
              disabled={registrationInProgress}
              className="w-full py-3 bg-gradient-to-r from-yellow-500 to-yellow-600 text-slate-900 font-bold rounded-lg hover:from-yellow-400 hover:to-yellow-500 disabled:opacity-50"
            >
              {registrationInProgress ? "Memproses..." : "Register Akun + Scan Muka"}
            </button>
          </form>

          <div className="text-center mt-4">
            <a href="/" className="text-blue-200 text-sm hover:text-white underline">
              Sudah punya akun? Masuk
            </a>
          </div>
        </div>
      </div>

      {/* RIGHT PANEL - CAMERA BACKGROUND */}
      <div className="w-1/2 bg-gradient-to-br from-blue-900 via-slate-900 to-indigo-900 flex items-center justify-center overflow-hidden">
        <div className="relative w-56 h-56 bg-black rounded-xl overflow-hidden border-2 border-gray-600 mirror-x">
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover scale-x-[-1]" />
        </div>
      </div>
    </div>
  );
};

export default RegisterView;