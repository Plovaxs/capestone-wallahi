import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { supabase } from '../supabaseClient';
import ExportButton from '../components/ExportButton';
import { generateTablePdf } from '../utils/generateTablePdf';
import SortableTh from '../components/SortableTh';
import { PunctualityPolicy } from '../domain/PunctualityPolicy';
import * as faceapi from 'face-api.js';
import { pipeline } from '@huggingface/transformers';
import { showUserError } from '../utils/errorHandling';
import { RandomLivenessChallenge, CHALLENGE_TYPES } from '../vision/livenessDetector';
import { checkFraming, checkBrightness, checkOcclusion, checkSingleFace } from '../vision/faceQuality';
import { classifyMatch } from '../vision/matchConfidence';
import { checkReplaySuspicion } from '../vision/antiReplayHeuristic';
import { recordMatchDistance, clearStalenessCounter } from '../vision/descriptorStaleness';
import { checkEnrollmentQuality } from '../vision/enrollmentQuality';
import { getBucket } from '../utils/tokenBucket';
import Modal from '../components/Modal';

const QUALITY_HINT_KEYS = {
    'no-face': 'attendance.statusScanning',
    'multiple-faces': 'attendance.statusMultipleFaces',
    'too-far': 'attendance.statusTooFar',
    'too-close': 'attendance.statusTooClose',
    'off-center': 'attendance.statusOffCenter',
    'too-dark': 'attendance.statusTooDark',
    'too-bright': 'attendance.statusTooBright',
    'low-confidence': 'attendance.statusLowConfidence',
};

const CHALLENGE_HINT_KEYS = {
    [CHALLENGE_TYPES.BLINK]: 'attendance.statusAwaitingBlink',
    [CHALLENGE_TYPES.HEAD_TURN]: 'attendance.statusAwaitingHeadTurn',
};

const ENROLL_QUALITY_HINT_KEYS = {
    'too-dark': 'attendance.enrollQualityTooDark',
    'too-bright': 'attendance.enrollQualityTooBright',
    'too-blurry': 'attendance.enrollQualityTooBlurry',
};

const determineYoloVersion = () => {
  const hardwareConcurrency = navigator.hardwareConcurrency ? parseInt(navigator.hardwareConcurrency, 10) : 0;
  const deviceMemory = parseFloat(navigator.deviceMemory);
  if (deviceMemory < 4 || hardwareConcurrency <= 4) return 'nano';
  if (deviceMemory >= 8 && hardwareConcurrency > 4) return 'medium';
  return 'nano';
};

const YOLO_MODEL_IDS = {
  nano: 'Xenova/yolov8n-face',
  medium: 'Xenova/yolov8n-face' 
};

const AttendanceView = ({ userProfile, attendance = [], allUsers = [], fetchAttendance, fetchProfile, onlineUserIds = new Set() }) => {
    const { t } = useTranslation();
    const FACE_MODEL_URL = import.meta.env.VITE_FACE_MODEL_URL || '/models';
    const YOLO_LOCAL_PATH = import.meta.env.VITE_YOLO_LOCAL_PATH || '/models/yolov8n-face';
    const FACE_MATCH_THRESHOLD = 0.5;
    const YOLO_FACE_THRESHOLD = 0.35;
    const ATTENDANCE_TABLE = 'attendance';
    const FACE_SCAN_INTERVAL_MS = 1800;
    const FACE_DETECT_OPTIONS = new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.15 });

    const [isLoading, setIsLoading] = useState(false); 
    const [isEnrolling, setIsEnrolling] = useState(false); // 🟩 NEW: guards against rapid re-clicks on Enroll Facial Matrix
    const [liveDistance, setLiveDistance] = useState(null); 
    const [isInRange, setIsInRange] = useState(false); 
    const [currentCoords, setCurrentCoords] = useState(null); 
    const [isCameraReady, setIsCameraReady] = useState(false); 
    const [, setCameraStatus] = useState('idle'); // cameraStatus itself is never read, only tracked
    const [faceStatus, setFaceStatus] = useState('idle'); 
    const [biometricStatus, setBiometricStatus] = useState(t('login.statusInitializing'));
    const [, setClockInAt] = useState(''); // write-only, never displayed
    const [, setClockInSource] = useState('none'); // write-only, never displayed
    const [disableYolo] = useState(false); // setter was never called anywhere — always stays false
    const [, setCurrentModelVersion] = useState(null); // write-only, never displayed
    const [faceOverlayBox, setFaceOverlayBox] = useState(null);
    const [hasStoredFace, setHasStoredFace] = useState(false);
    const [, setFaceMatchDistance] = useState(null); // write-only, never displayed
    const [, setFaceDetectionMode] = useState('idle'); // write-only, never displayed
    const [isFaceVerified, setIsFaceVerified] = useState(false);
    const [hasBlinked, setHasBlinked] = useState(false); // 🟩 NEW: liveness gate — a matched face still can't clock in until the liveness challenge is confirmed
    const [challengeType, setChallengeType] = useState(null); // 🟩 NEW: which liveness challenge is active this session (blink or head-turn)
    const [showConsentModal, setShowConsentModal] = useState(false); // 🟩 NEW: biometric-data consent gate before first enrollment

    const [searchTerm, setSearchTerm] = useState('');
    const [filterSource, setFilterSource] = useState('all');
    const [filterMode, setFilterMode] = useState('all');
    const [filterStatus, setFilterStatus] = useState('all');
    const [sortBy, setSortBy] = useState('name-az');
    const [historyStatusFilter, setHistoryStatusFilter] = useState('all'); // 🟩 NEW: On Time / Late filter for the personal log grid

    // --- SORTABLE TABLE COLUMNS (roster table) — takes precedence over the sortBy dropdown when set ---
    const [columnSort, setColumnSort] = useState({ key: null, direction: 'asc' });
    const toggleColumnSort = (key) => {
        setColumnSort(prev => (
            prev.key === key
                ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
                : { key, direction: 'asc' }
        ));
    };

    const today = new Date().toISOString().split('T')[0]; 
    const attendanceRows = Array.isArray(attendance) ? attendance : [];
    const todayRecord = attendanceRows.find(record => record.employee_id === userProfile.id && record.date === today);

    const WORK_START_TIME = '08:00:00'; 
    const OFFICE_LOCATION = { lat: -6.20651363, lng: 106.87604852 };
    const ALLOWED_RADIUS_METERS = 2000; 

    const webcamVideoRef = useRef(null);
    const referenceDescriptorRef = useRef(null);
    const faceScanBusyRef = useRef(false);
    const yoloDetectorRef = useRef(null);
    const yoloDetectorPromiseRef = useRef(null);
    const autoClockInGuardRef = useRef(false);
    const webcamStreamRef = useRef(null);
    const livenessChallengeRef = useRef(new RandomLivenessChallenge());
    const borderlineStreakRef = useRef(0); // consecutive borderline-tier match reads, for confidence-tiered re-check
    // Client-side pre-throttle on repeated mismatches (NOT the security boundary —
    // trivially bypassable client-side — just avoids hammering the scan loop
    // indefinitely; per utils/tokenBucket.js's documented purpose).
    const mismatchBucketRef = useRef(getBucket(`face-scan-${userProfile.id}`, { capacity: 8, refillRatePerSec: 8 / 30 }));

    const parseStoredDescriptor = (value) => {
        if (!value) return null;
        let parsed = value;
        if (typeof value === 'string') {
            try { parsed = JSON.parse(value); } catch { return null; }
        }
        if (Array.isArray(parsed)) return new Float32Array(parsed);
        if (parsed && Array.isArray(parsed.data)) return new Float32Array(parsed.data);
        return null;
    };

    const getRecordClockInTime = (record) => record?.clock_in || record?.created_at || '';

    const normalizeBoundingBox = (box) => {
        if (!box) return null;
        const x = Number(box.xmin ?? box.x ?? 0);
        const y = Number(box.ymin ?? box.y ?? 0);
        const width = Number(box.width ?? ((box.xmax ?? 0) - (box.xmin ?? 0)));
        const height = Number(box.height ?? ((box.ymax ?? 0) - (box.ymin ?? 0)));
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
        return { x, y, width, height };
    };

    const detectWithFaceApi = async (canvasOrImage) => {
        const detections = await faceapi.detectAllFaces(canvasOrImage, FACE_DETECT_OPTIONS).withFaceLandmarks().withFaceDescriptors();
        if (detections.length > 0) {
            const best = detections.sort((a, b) => (b.detection.score || 0) - (a.detection.score || 0))[0];
            return { ...best, faceCount: detections.length };
        }
        const single = await faceapi.detectSingleFace(canvasOrImage, FACE_DETECT_OPTIONS).withFaceLandmarks().withFaceDescriptor();
        return single ? { ...single, faceCount: 1 } : null;
    };

    const detectFaceFromImage = async (imageEl) => {
        if (!imageEl) return null;
        const isVideo = imageEl.tagName === 'VIDEO';
        const ready = isVideo ? imageEl.readyState >= 2 : imageEl.complete;
        const width = isVideo ? imageEl.videoWidth : imageEl.naturalWidth;
        const height = isVideo ? imageEl.videoHeight : imageEl.naturalHeight;

        if (!ready || width === 0 || height === 0) return null;

        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = width;
        sourceCanvas.height = height;
        const sourceContext = sourceCanvas.getContext('2d');
        if (!sourceContext) return null;
        sourceContext.drawImage(imageEl, 0, 0, width, height);

        if (!disableYolo) {
            try {
                const detector = await ensureYoloFaceDetector();
                const detections = await detector(sourceCanvas, { threshold: YOLO_FACE_THRESHOLD });
                const bestDetection = detections.sort((a, b) => (b.score || 0) - (a.score || 0))[0];

                if (bestDetection?.box) {
                    const cropCanvas = cropFaceCanvas(sourceCanvas, bestDetection.box);
                    if (cropCanvas) {
                        const croppedDetection = await detectWithFaceApi(cropCanvas);
                        if (croppedDetection) {
                            return {
                                ...croppedDetection,
                                source: 'yolo',
                                box: normalizeBoundingBox(bestDetection.box),
                                faceCount: detections.length, // YOLO's whole-frame count takes precedence over the single crop's own count
                                sourceCanvas,
                            };
                        }
                    }
                }
            } catch (_error) {
                console.info('YOLO fallback to face-api full frame.');
            }
        }

        const fallbackDetection = await detectWithFaceApi(sourceCanvas);
        if (!fallbackDetection) return null;
        return {
            ...fallbackDetection,
            source: 'faceapi',
            box: normalizeBoundingBox(fallbackDetection.detection?.box || fallbackDetection.box),
            sourceCanvas,
        };
    };

    const cropFaceCanvas = (sourceCanvas, box) => {
        if (!sourceCanvas || !box) return null;
        const x = Math.max(0, Math.floor(box.xmin ?? box.x ?? 0));
        const y = Math.max(0, Math.floor(box.ymin ?? box.y ?? 0));
        const width = Math.max(1, Math.floor(box.width ?? ((box.xmax ?? 0) - (box.xmin ?? 0))));
        const height = Math.max(1, Math.floor(box.height ?? ((box.ymax ?? 0) - (box.ymin ?? 0))));
        const safeWidth = Math.min(width, sourceCanvas.width - x);
        const safeHeight = Math.min(height, sourceCanvas.height - y);

        if (safeWidth <= 1 || safeHeight <= 1) return null;

        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = safeWidth;
        cropCanvas.height = safeHeight;
        const cropContext = cropCanvas.getContext('2d');
        if (!cropContext) return null;
        cropContext.drawImage(sourceCanvas, x, y, safeWidth, safeHeight, 0, 0, safeWidth, safeHeight);
        return cropCanvas;
    };

    const ensureYoloFaceDetector = async () => {
        if (yoloDetectorRef.current) return yoloDetectorRef.current;
        if (!yoloDetectorPromiseRef.current) {
            const selectedModelVersion = determineYoloVersion();
            const modelId = selectedModelVersion === 'nano' ? YOLO_MODEL_IDS.nano : YOLO_MODEL_IDS.medium;

            yoloDetectorPromiseRef.current = pipeline('object-detection', modelId)
                .then(detector => {
                    yoloDetectorRef.current = detector;
                    setCurrentModelVersion(selectedModelVersion);
                    return detector;
                })
                .catch(async (_err) => {
                    const localDetector = await pipeline('object-detection', YOLO_LOCAL_PATH);
                    yoloDetectorRef.current = localDetector;
                    return localDetector;
                });
        }
        return yoloDetectorPromiseRef.current;
    };

    // HISTORY SUMMARY CALCULATIONS
    const myHistory = attendanceRows.filter(a => a.employee_id === userProfile.id);
    const totalDays = myHistory.length;
    const lateDays = myHistory.filter(a => a.status === 'Late').length;
    const punctualityScore = PunctualityPolicy.calculate(myHistory) ?? 0;

    // 🟩 NEW: Lets an intern filter their own log by On Time / Late instead of
    // scanning every card manually.
    const filteredMyHistory = myHistory.filter(a => historyStatusFilter === 'all' || a.status === historyStatusFilter);

    const activeEmployees = allUsers.filter(u => u.role === 'employee');
    const clockedInTodayCount = activeEmployees.filter(emp => 
        attendanceRows.some(a => a.employee_id === emp.id && a.date === today)
    ).length;
    const wfhAssignmentCount = activeEmployees.filter(emp => emp.work_mode === 'WFH').length;
    const wfoAssignmentCount = activeEmployees.filter(emp => (emp.work_mode || 'WFO') === 'WFO').length;

    const uniqueSources = Array.from(
        new Set(
            allUsers
                .filter(u => u.role === 'employee')
                .map(u => u.source || u.university || 'President University')
        )
    );

    const processedInterns = allUsers
        .filter(u => u.role === 'employee')
        .filter(emp => {
            const matchesSearch = emp.name.toLowerCase().includes(searchTerm.toLowerCase());
            const empSource = emp.source || emp.university || 'President University';
            const matchesSource = filterSource === 'all' || empSource === filterSource;
            const empMode = emp.work_mode || 'WFO';
            const matchesMode = filterMode === 'all' || empMode === filterMode;
            
            const empTodayRecord = attendanceRows.find(a => a.employee_id === emp.id && a.date === today);
            let matchesStatus = true;
            if (filterStatus === 'clocked_in') matchesStatus = !!empTodayRecord;
            if (filterStatus === 'not_clocked_in') matchesStatus = !empTodayRecord;

            return matchesSearch && matchesSource && matchesMode && matchesStatus;
        })
        .sort((a, b) => {
            if (columnSort.key) {
                const dir = columnSort.direction === 'asc' ? 1 : -1;
                if (columnSort.key === 'status') {
                    const aClocked = attendanceRows.some(att => att.employee_id === a.id && att.date === today);
                    const bClocked = attendanceRows.some(att => att.employee_id === b.id && att.date === today);
                    return (bClocked - aClocked) * dir;
                }
                const getVal = (emp) => {
                    if (columnSort.key === 'name') return emp.name;
                    if (columnSort.key === 'institution') return emp.source || emp.university || 'President University';
                    if (columnSort.key === 'mode') return emp.work_mode || 'WFO';
                    return '';
                };
                return getVal(a).localeCompare(getVal(b)) * dir;
            }
            if (sortBy === 'name-az') return a.name.localeCompare(b.name);
            if (sortBy === 'name-za') return b.name.localeCompare(a.name);
            if (sortBy === 'status-active') {
                const aClocked = attendanceRows.some(att => att.employee_id === a.id && att.date === today);
                const bClocked = attendanceRows.some(att => att.employee_id === b.id && att.date === today);
                return bClocked - aClocked;
            }
            return 0;
        });

    const [exportEmployeeId, setExportEmployeeId] = useState('all'); // 🟩 NEW: single-employee export filter

    const exportDataFiltered = processedInterns
        .filter(emp => exportEmployeeId === 'all' || emp.id === exportEmployeeId)
        .flatMap(emp => 
        attendanceRows.filter(a => a.employee_id === emp.id).map(record => ({
            Date: record.date,
            Employee: emp.name,
            Institution: emp.source || emp.university || 'President University',
            "Assigned Mode": emp.work_mode || 'WFO',
            Status: record.status,
            "Check In": getRecordClockInTime(record),
            "Check Out": record.clock_out
        }))
    );

    // ==========================================
    // GEOLOCATION STREAM LOGIC
    // ==========================================
    useEffect(() => {
        if (!navigator.geolocation || !userProfile) return;

        const watchId = navigator.geolocation.watchPosition(
            (position) => {
                try {
                    const { latitude, longitude } = position.coords;
                    setCurrentCoords({ latitude, longitude }); 

                    const earthRadius = 6371000; 
                    const dLat = (OFFICE_LOCATION.lat - latitude) * Math.PI / 180;
                    const dLon = (OFFICE_LOCATION.lng - longitude) * Math.PI / 180;
                    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(latitude * Math.PI / 180) * Math.cos(OFFICE_LOCATION.lat * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
                    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                    const dist = earthRadius * c;
                    
                    setLiveDistance(dist);
                    
                    if (userProfile.role === 'supervisor') {
                        setIsInRange(true); 
                    } else {
                        const assignedMode = userProfile.work_mode || 'WFO';
                        if (assignedMode === 'WFH') {
                            setIsInRange(true); 
                        } else {
                            setIsInRange(dist <= ALLOWED_RADIUS_METERS); 
                        }
                    }
                } catch (e) {
                    console.info(e);
                }
            },
            (_err) => {
                setCurrentCoords(null);
                setLiveDistance(null);
                setIsInRange(false);
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );

        return () => navigator.geolocation.clearWatch(watchId);
    }, [userProfile, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng]);

    // ==========================================
    // VIDEO LIFE CYCLE CONTROLLER
    // ==========================================
    useEffect(() => {
        if (!userProfile || userProfile.role === 'supervisor') return;
        let isCancelled = false;
        let stream = null;

        const startWebcam = async () => {
            setCameraStatus('loading');
            try {
                stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
                if (isCancelled) {
                    stream.getTracks().forEach(track => track.stop());
                    return;
                }
                webcamStreamRef.current = stream;
                if (webcamVideoRef.current) {
                    webcamVideoRef.current.srcObject = stream;
                }
                setIsCameraReady(true);
                setCameraStatus('ready');
            } catch (_error) {
                setCameraStatus('error');
            }
        };

        startWebcam();

        return () => {
            isCancelled = true;
            if (stream) stream.getTracks().forEach(track => track.stop());
        };
    }, [userProfile]);

    // ==========================================
    // NEURAL MODEL ENGINE WEIGHT LOADER
    // ==========================================
    useEffect(() => {
        if (!userProfile || userProfile.role === 'supervisor') return;

        async function loadModels() {
            setFaceStatus('loading-models');
            setBiometricStatus(t('attendance.statusLoadingModels'));
            await Promise.all([
                faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL),
                faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URL),
                faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL)
            ]);
            const savedDescriptor = parseStoredDescriptor(userProfile.face_descriptor);
            if (savedDescriptor) {
                referenceDescriptorRef.current = savedDescriptor;
                setHasStoredFace(true);
                setFaceStatus('scanning');
                setBiometricStatus(t('attendance.statusAlignFace'));
            } else {
                setFaceStatus('error');
                setBiometricStatus(t('attendance.statusMissingProfile'));
            }
        }
        loadModels();
    }, [userProfile, disableYolo, FACE_MODEL_URL]);

    // ==========================================
    // ACTIVE MOTION DETECTOR SCAN ENGINE HOOK
    // ==========================================
    useEffect(() => {
        if (!isCameraReady || faceStatus !== 'scanning' || todayRecord) return;

        // Fresh, randomly-typed liveness challenge every time a scan session
        // (re)starts — a blink/head-turn observed in a previous, already-
        // finished attempt shouldn't carry over and silently satisfy this one.
        livenessChallengeRef.current.reset();
        setChallengeType(livenessChallengeRef.current.challengeType);
        setHasBlinked(false);
        borderlineStreakRef.current = 0;

        const timer = setInterval(async () => {
            if (faceScanBusyRef.current || !webcamVideoRef.current) return;
            faceScanBusyRef.current = true;

            try {
                // 🟩 CORRECTED: Calls your deep yolo/faceapi abstraction layer wrapper directly
                const liveDet = await detectFaceFromImage(webcamVideoRef.current);

                if (liveDet) {
                    const imageWidth = webcamVideoRef.current.videoWidth;
                    const imageHeight = webcamVideoRef.current.videoHeight;

                    // Update bounding box positions for visual injection
                    if (liveDet.box) {
                        setFaceOverlayBox({
                            ...liveDet.box,
                            imageWidth,
                            imageHeight,
                            source: liveDet.source
                        });
                    }

                    // 🟩 QUALITY GATES: framing/size, single-face, lighting, and
                    // detector-confidence (occlusion proxy) are all checked BEFORE
                    // trusting a match — a low-quality read shouldn't silently
                    // count toward liveness or clock-in either way.
                    let brightness = { ok: true, reason: null };
                    if (liveDet.box && liveDet.sourceCanvas) {
                        try {
                            const ctx = liveDet.sourceCanvas.getContext('2d');
                            const region = ctx.getImageData(liveDet.box.x, liveDet.box.y, liveDet.box.width, liveDet.box.height);
                            brightness = checkBrightness(region.data);
                        } catch (_err) {
                            // getImageData can throw on a tainted canvas in some browsers — skip the check, don't crash the loop.
                        }
                    }
                    const framing = checkFraming(liveDet.box, imageWidth, imageHeight);
                    const singleFace = checkSingleFace(liveDet.faceCount ?? 1);
                    const occlusion = checkOcclusion(liveDet.detection?.score);
                    const qualityIssue = !singleFace.ok ? singleFace : !framing.ok ? framing : !brightness.ok ? brightness : !occlusion.ok ? occlusion : null;

                    if (qualityIssue) {
                        setIsFaceVerified(false);
                        setHasBlinked(false);
                        setBiometricStatus(t(QUALITY_HINT_KEYS[qualityIssue.reason] || 'attendance.statusScanning'));
                        faceScanBusyRef.current = false;
                        return;
                    }

                    if (referenceDescriptorRef.current) {
                        const dist = faceapi.euclideanDistance(liveDet.descriptor, referenceDescriptorRef.current);
                        const matchTier = classifyMatch(dist, FACE_MATCH_THRESHOLD);
                        setFaceMatchDistance(dist);
                        setFaceDetectionMode(liveDet.source || 'faceapi');

                        // Both confident and borderline distances count as a match —
                        // the liveness challenge below is the real extra confirmation
                        // step, so this doesn't also need its own multi-read delay.
                        const isMatch = matchTier !== 'no-match';
                        borderlineStreakRef.current = 0;

                        setFaceStatus(isMatch ? 'matched' : 'mismatch');
                        // 🟩 FIX: isFaceVerified was read by the manual "Clock In Shift"
                        // button but its setter was never called anywhere, so the
                        // button stayed permanently disabled regardless of match status.
                        setIsFaceVerified(isMatch);

                        if (isMatch) {
                            // 🟩 LIVENESS GATE: a matched descriptor alone doesn't prove a
                            // live person is present — a printed photo or a video replay
                            // would match too. Require one randomly-chosen challenge
                            // (blink OR head-turn, time-boxed) before treating the match
                            // as final — unpredictable and can't be satisfied by a clip
                            // prepared for only one challenge type.
                            const challengeConfirmed = livenessChallengeRef.current.registerFrame(liveDet.landmarks);
                            setHasBlinked(challengeConfirmed);

                            if (userProfile.work_mode === 'WFO' && !isInRange) {
                                setBiometricStatus(t('attendance.statusAccessDenied'));
                            } else if (livenessChallengeRef.current.isExpired()) {
                                setBiometricStatus(t('attendance.statusChallengeExpired'));
                                livenessChallengeRef.current.reset();
                                setChallengeType(livenessChallengeRef.current.challengeType);
                            } else if (!challengeConfirmed) {
                                setBiometricStatus(t(CHALLENGE_HINT_KEYS[livenessChallengeRef.current.challengeType]));
                            } else if (!autoClockInGuardRef.current) {
                                autoClockInGuardRef.current = true;
                                setBiometricStatus(t('attendance.statusMatchVerified'));
                                clearInterval(timer);

                                // Best-effort, non-blocking anti-replay signal: warn if the
                                // border around the face looks suspiciously uniform (a
                                // possible phone/tablet bezel), but never hard-block on it —
                                // a plain wall behind a real person can trigger the same signal.
                                try {
                                    const ctx = liveDet.sourceCanvas.getContext('2d');
                                    const marginX = Math.round(liveDet.box.width * 0.15);
                                    const marginY = Math.round(liveDet.box.height * 0.15);
                                    const borderRegion = ctx.getImageData(
                                        Math.max(0, liveDet.box.x - marginX),
                                        Math.max(0, liveDet.box.y - marginY),
                                        liveDet.box.width + marginX * 2,
                                        liveDet.box.height + marginY * 2
                                    );
                                    if (checkReplaySuspicion(borderRegion.data).suspicious) {
                                        toast(t('attendance.antiReplayWarning'), { icon: '⚠️' });
                                    }
                                } catch (_err) {
                                    // Non-critical signal — ignore failures (tainted canvas, out-of-bounds region, etc.)
                                }

                                // 🟩 STALENESS REMINDER: track whether recent matches keep
                                // coming in close to the threshold rather than confidently.
                                const staleness = recordMatchDistance(userProfile.id, dist, FACE_MATCH_THRESHOLD);
                                if (staleness.shouldSuggestReEnrollment) {
                                    toast(t('attendance.reEnrollSuggestion'), { icon: '🔄', duration: 6000 });
                                }

                                await handleClockIn('face-match');
                            }
                        } else {
                            const bucketExhausted = !mismatchBucketRef.current.tryConsume();
                            setBiometricStatus(bucketExhausted ? t('attendance.statusTooManyAttempts') : t('attendance.statusNotRecognized'));
                        }
                    }
                } else {
                    setFaceOverlayBox(null);
                    setFaceMatchDistance(null);
                    setIsFaceVerified(false);
                    setBiometricStatus(t('attendance.statusScanning'));
                }
            } catch (err) {
                console.error(err);
            }
            faceScanBusyRef.current = false;
        }, 1200);

        return () => {
            clearInterval(timer);
            setFaceOverlayBox(null);
        };
        // Intentional: detectFaceFromImage and handleClockIn are redefined every
        // render (not memoized), so listing them here would tear down and
        // recreate the scan interval on every render instead of letting it run
        // steadily. userProfile.work_mode is read fresh via closure each tick;
        // work_mode changes are rare enough that a full remount isn't needed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isCameraReady, faceStatus, isInRange, todayRecord, disableYolo]);

    // ==========================================
    // MATHEMATICAL MATRIX POSITION CALCULATOR
    // ==========================================
    const getFaceOverlayStyle = () => {
        if (!faceOverlayBox || !webcamVideoRef.current) return null;

        const videoEl = webcamVideoRef.current;
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
        
        // 🟩 MIRROR STYLING CORRECTION: Computes position relative to flipped canvas limits
        const standardLeft = offsetX + (faceOverlayBox.x * scaleX);
        const mirroredLeft = viewportWidth - standardLeft - boxWidth;

        return {
            left: `${mirroredLeft}px`,
            top: `${offsetY + (faceOverlayBox.y * scaleY)}px`,
            width: `${boxWidth}px`,
            height: `${boxHeight}px`,
        };
    };

    const handleClockIn = async (source = 'manual') => {
        if (userProfile.role !== 'supervisor' && !currentCoords) {
            toast.error(t('attendance.gpsWaiting'));
            return false;
        }
        if (userProfile.role !== 'supervisor' && !isInRange) {
            toast.error(t('attendance.geofenceRejection'));
            return false;
        }

        setIsLoading(true);
        try {
            const now = new Date();
            const time = now.toLocaleTimeString('en-GB', { hour12: false });
            const status = time > WORK_START_TIME ? 'Late' : 'Present';

            const { error } = await supabase.from(ATTENDANCE_TABLE).insert([{ 
                employee_id: userProfile.id,
                date: today,
                status,
                clock_in: time,
                latitude: currentCoords ? currentCoords.latitude : null,
                longitude: currentCoords ? currentCoords.longitude : null,
            }]);

            if (error) {
                showUserError('Failed to record attendance', error);
                return false;
            }

            setClockInAt(time);
            setClockInSource(source);
            await fetchAttendance();
            return true;
        } finally {
            setIsLoading(false);
        }
    };

    const handleClockOut = async () => {
        setIsLoading(true); 
        const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
        await supabase.from(ATTENDANCE_TABLE).update({ clock_out: time }).eq('id', todayRecord.id);
        await fetchAttendance(); 
        setIsLoading(false); 
    };

    const handleToggleWorkMode = async (employeeId, currentMode) => {
        const nextMode = currentMode === 'WFH' ? 'WFO' : 'WFH';
        await supabase.from('profiles').update({ work_mode: nextMode }).eq('id', employeeId);
        window.location.reload(); 
    };

  const openMap = (lat, lng) => {
        if (!lat || !lng) return;
        // 🟩 FIX: Standardized the Google Maps coordinate query URL
        window.open(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`, '_blank');
    };

    const FACE_CONSENT_KEY = `face_enrollment_consent_${userProfile.id}`;

    // 🟩 CONSENT GATE: face descriptors are sensitive biometric personal data —
    // require an explicit, informed opt-in the first time a user enrolls,
    // rather than silently capturing and storing it on first click.
    const handleEnrollFaceFromStream = () => {
        if (!webcamVideoRef.current || isEnrolling) return;

        let hasConsented = false;
        try { hasConsented = localStorage.getItem(FACE_CONSENT_KEY) === 'true'; } catch { /* localStorage unavailable — treat as not yet consented */ }

        if (!hasConsented) {
            setShowConsentModal(true);
            return;
        }
        performFaceEnrollment();
    };

    const handleConsentAccept = () => {
        try { localStorage.setItem(FACE_CONSENT_KEY, 'true'); } catch { /* consent just won't persist across sessions */ }
        setShowConsentModal(false);
        performFaceEnrollment();
    };

    const performFaceEnrollment = async () => {
        // 🟩 FIX: Without this guard, clicking the button rapidly fired a fresh
        // detect+update call on every click (no disable-while-processing state),
        // which can burst enough concurrent Supabase requests to trip its auth
        // rate limiter.
        if (isEnrolling) return;
        setIsEnrolling(true);

        try {
            const det = await detectFaceFromImage(webcamVideoRef.current);

            if (det) {
                // 🟩 ENROLLMENT QUALITY GATE: reject a blurry or badly-lit capture up
                // front — a poor reference descriptor causes every future clock-in
                // to be unreliable, and that's much harder to diagnose after the fact.
                if (det.box && det.sourceCanvas) {
                    try {
                        const ctx = det.sourceCanvas.getContext('2d');
                        const region = ctx.getImageData(det.box.x, det.box.y, det.box.width, det.box.height);
                        const quality = checkEnrollmentQuality(region.data, det.box.width, det.box.height);
                        if (!quality.ok) {
                            toast.error(t(ENROLL_QUALITY_HINT_KEYS[quality.reason] || 'attendance.faceDetectFailed'));
                            return;
                        }
                    } catch (_err) {
                        // Quality sampling failed (tainted canvas, etc.) — proceed rather than block enrollment entirely on a non-critical check.
                    }
                }

                // 🟩 FIX: Stringify the array before updating the profile
                const stringifiedDescriptor = JSON.stringify(Array.from(det.descriptor));

                const { error } = await supabase
                    .from('profiles')
                    .update({ face_descriptor: stringifiedDescriptor })
                    .eq('id', userProfile.id);

                if (error) {
                    showUserError('Failed to enroll face', error);
                } else {
                    clearStalenessCounter(userProfile.id);
                    toast.success(t('attendance.faceEnrolled'));
                    fetchProfile?.();
                }
            } else {
                toast.error(t('attendance.faceDetectFailed'));
            }
        } finally {
            setIsEnrolling(false);
        }
    };

    const handleResetEnrolledFace = async () => {
        if (isEnrolling) return;
        setIsEnrolling(true);
        try {
            await supabase.from('profiles').update({ face_descriptor: null }).eq('id', userProfile.id);
            toast.success(t('attendance.faceCleared'));
            fetchProfile?.();
        } finally {
            setIsEnrolling(false);
        }
    };

    const statusBadge = (status, clockOut, date) => {
        if (!clockOut && date !== today) {
            return <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase bg-red-500/10 text-red-400 border border-red-500/20">{t('attendance.incomplete')}</span>;
        }
        if (!clockOut) {
            return <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse">{t('attendance.inProgress')}</span>;
        }
        const styles = status === 'Present' 
            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
            : 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
        return <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase ${styles}`}>{status}</span>;
    };

    return (
        <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-6 text-slate-100">
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center border-b border-slate-800 pb-5 gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">
                        {userProfile.role === 'supervisor' ? t('attendance.supervisorTitle') : t('attendance.employeeTitle')}
                    </h1>
                    <p className="text-sm text-slate-400 mt-1">
                        {userProfile.role === 'supervisor' ? t('attendance.supervisorSubtitle') : t('attendance.employeeSubtitle')}
                    </p>
                </div>
                {userProfile.role === 'supervisor' && (
                    <div className="flex items-center gap-2">
                        <select
                            value={exportEmployeeId}
                            onChange={(e) => setExportEmployeeId(e.target.value)}
                            className="text-xs font-bold bg-slate-900 border border-slate-700 text-slate-300 rounded-lg px-2 py-2 focus:outline-none focus:border-blue-500"
                        >
                            <option value="all">{t('attendance.allEmployees')}</option>
                            {processedInterns.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                        </select>
                        <ExportButton data={exportDataFiltered} filename={exportEmployeeId === 'all' ? "Outsourcing_Staff_Attendance_Roster" : `Attendance_${processedInterns.find(e => e.id === exportEmployeeId)?.name || 'Employee'}`} label={t('attendance.exportCleanSheet')} />
                        <button
                            type="button"
                            onClick={() => generateTablePdf({
                                title: userProfile.role === 'supervisor' ? t('attendance.supervisorTitle') : t('attendance.employeeTitle'),
                                subtitle: exportEmployeeId === 'all' ? t('attendance.allEmployees') : processedInterns.find(e => e.id === exportEmployeeId)?.name || '',
                                columns: [
                                    { key: 'Date', label: t('attendance.date') },
                                    { key: 'Employee', label: t('attendance.employee') },
                                    { key: 'Institution', label: t('attendance.institution') },
                                    { key: 'Assigned Mode', label: t('attendance.assignedMode') },
                                    { key: 'Status', label: t('attendance.status') },
                                    { key: 'Check In', label: t('attendance.checkIn') },
                                    { key: 'Check Out', label: t('attendance.checkOut') },
                                ],
                                rows: exportDataFiltered,
                                filename: exportEmployeeId === 'all' ? 'Attendance_Roster' : `Attendance_${processedInterns.find(e => e.id === exportEmployeeId)?.name || 'Employee'}`,
                            })}
                            className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg shadow-sm transition-all text-sm border border-red-700"
                            title={t('common.exportPdf')}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            {t('common.exportPdf')}
                        </button>
                    </div>
                )}
            </div>

            {userProfile.role === 'supervisor' ? (
                <div className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                        <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-5 shadow-xl backdrop-blur-md">
                            <div className="text-xs font-bold text-slate-400 uppercase tracking-widest">{t('attendance.totalRegisteredStaff')}</div>
                            <div className="text-4xl font-black text-white mt-2 flex items-baseline gap-2">
                                {activeEmployees.length} <span className="text-xs font-bold text-slate-500 uppercase font-sans">{t('attendance.officers')}</span>
                            </div>
                        </div>
                        <div className="bg-gradient-to-br from-blue-600/20 to-indigo-600/10 border border-blue-500/30 rounded-2xl p-5 shadow-xl backdrop-blur-md">
                            <div className="text-xs font-bold text-blue-400 uppercase tracking-widest">{t('attendance.activeClockedInToday')}</div>
                            <div className="text-4xl font-black text-blue-400 mt-2 flex items-baseline gap-2">
                                {clockedInTodayCount} <span className="text-xs font-bold text-blue-500 uppercase font-sans animate-pulse">{t('attendance.liveNow')}</span>
                            </div>
                        </div>
                        <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-5 shadow-xl backdrop-blur-md flex flex-col justify-center">
                            <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">{t('attendance.dutyModeDistribution')}</div>
                            <div className="flex gap-2">
                                <span className="bg-blue-500/10 text-blue-400 border border-blue-500/20 px-3 py-1 rounded-xl text-[10px] font-bold uppercase tracking-wider">🏢 {wfoAssignmentCount} WFO</span>
                                <span className="bg-purple-500/10 text-purple-400 border border-purple-500/20 px-3 py-1 rounded-xl text-[10px] font-bold uppercase tracking-wider">🏠 {wfhAssignmentCount} WFH</span>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 bg-slate-800/40 p-4 rounded-2xl border border-slate-700/50 shadow-inner">
                        <div>
                            <label htmlFor="att-search" className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">{t('attendance.searchStaff')}</label>
                            <input
                                id="att-search"
                                type="text"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                placeholder={t('attendance.searchPlaceholder')}
                                className="w-full px-3 py-2 text-xs border border-slate-700 bg-slate-900/60 rounded-xl focus:outline-none focus:border-blue-500 text-white placeholder-slate-500 font-medium"
                            />
                        </div>
                        <div>
                            <label htmlFor="att-source" className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">{t('attendance.originInstitution')}</label>
                            <select id="att-source" value={filterSource} onChange={(e) => setFilterSource(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-700 bg-slate-900/60 rounded-xl focus:outline-none focus:border-blue-500 text-white font-bold">
                                <option value="all">{t('attendance.allInstitutions')}</option>
                                {uniqueSources.map(src => <option key={src} value={src}>{src}</option>)}
                            </select>
                        </div>
                        <div>
                            <label htmlFor="att-mode" className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">{t('attendance.assignedMode')}</label>
                            <select id="att-mode" value={filterMode} onChange={(e) => setFilterMode(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-700 bg-slate-900/60 rounded-xl focus:outline-none focus:border-blue-500 text-white font-bold">
                                <option value="all">{t('attendance.allModes')}</option>
                                <option value="WFO">{t('attendance.officeWFO')}</option>
                                <option value="WFH">{t('attendance.remoteWFH')}</option>
                            </select>
                        </div>
                        <div>
                            <label htmlFor="att-status" className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">{t('attendance.rosterState')}</label>
                            <select id="att-status" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-700 bg-slate-900/60 rounded-xl focus:outline-none focus:border-blue-500 text-white font-bold">
                                <option value="all">{t('attendance.allStatuses')}</option>
                                <option value="clocked_in">{t('attendance.activeClockedIn')}</option>
                                <option value="not_clocked_in">{t('attendance.inactiveNotIn')}</option>
                            </select>
                        </div>
                        <div>
                            <label htmlFor="att-sort" className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5">{t('attendance.sortConfiguration')}</label>
                            <select id="att-sort" value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-700 bg-slate-900/60 rounded-xl focus:outline-none focus:border-blue-500 text-white font-bold">
                                <option value="name-az">{t('attendance.nameAZ')}</option>
                                <option value="name-za">{t('attendance.nameZA')}</option>
                                <option value="status-active">{t('attendance.clockedInFirst')}</option>
                            </select>
                        </div>
                    </div>

                    <div className="bg-slate-800/20 rounded-2xl border border-slate-800 shadow-2xl overflow-hidden backdrop-blur-sm">
                        <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse">
                                <thead className="bg-slate-800/60 border-b border-slate-700/60 text-[11px] font-bold text-slate-400 uppercase tracking-widest">
                                    <tr>
                                        <SortableTh label={t('attendance.colStaffName')} sortKey="name" sortConfig={columnSort} onSort={toggleColumnSort} />
                                        <SortableTh label={t('attendance.colInstitution')} sortKey="institution" sortConfig={columnSort} onSort={toggleColumnSort} />
                                        <SortableTh label={t('attendance.colDutyMode')} sortKey="mode" sortConfig={columnSort} onSort={toggleColumnSort} />
                                        <SortableTh label={t('attendance.colTodayStatus')} sortKey="status" sortConfig={columnSort} onSort={toggleColumnSort} />
                                        <th className="p-4 text-right">{t('attendance.colActions')}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-800/60 text-xs font-semibold text-slate-200">
                                    {processedInterns.map(emp => {
                                        const empToday = attendance.find(a => a.employee_id === emp.id && a.date === today);
                                        return (
                                            <tr key={emp.id} className="hover:bg-slate-800/30 transition-all duration-150">
                                                <td className="p-4 font-bold text-white">
                                                    <div className="flex items-center gap-3">
                                                        <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center font-black text-white text-xs border border-blue-400/20">
                                                            {emp.name?.charAt(0).toUpperCase()}
                                                        </div>
                                                        <span>{emp.name}</span>
                                                        {onlineUserIds.has(String(emp.id)) && (
                                                            <span
                                                                className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)] animate-pulse"
                                                                title={t('attendance.onlineNow')}
                                                            />
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="p-4">
                                                    <span className="bg-slate-900/80 text-slate-400 border border-slate-700/60 px-2.5 py-1 rounded-lg text-[10px] uppercase font-mono tracking-wide">
                                                        {emp.source || emp.university || 'President University'}
                                                    </span>
                                                </td>
                                                <td className="p-4">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleToggleWorkMode(emp.id, emp.work_mode || 'WFO')}
                                                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-xl font-bold border text-[10px] uppercase tracking-wider ${
                                                            emp.work_mode === 'WFH' ? 'bg-purple-500/10 text-purple-400 border-purple-500/20' : 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                                                        }`}
                                                    >
                                                        {emp.work_mode === 'WFH' ? t('attendance.wfhRemote') : t('attendance.wfoOnSite')}
                                                    </button>
                                                </td>
                                                <td className="p-4">
                                                    {empToday ? (
                                                        <div className="flex flex-col items-start gap-1">
                                                            {statusBadge(empToday.status, empToday.clock_out, empToday.date)}
                                                            <span className="text-[10px] font-bold text-slate-500 font-mono">IN: {getRecordClockInTime(empToday)}</span>
                                                        </div>
                                                    ) : (
                                                        <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-900 text-slate-600 border border-slate-800">{t('attendance.notClockedIn')}</span>
                                                    )}
                                                </td>
                                                <td className="p-4 text-right">
                                                    {empToday?.latitude && (
                                                        <button type="button" onClick={() => openMap(empToday.latitude, empToday.longitude)} className="text-xs font-bold px-3 py-1.5 border border-slate-700 rounded-xl bg-slate-900/60 text-slate-300 hover:text-white hover:bg-slate-800 shadow-md transition">
                                                            {t('attendance.viewMapLocation')}
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 font-bold text-slate-400 text-xs tracking-wider">
                        <div className="bg-gradient-to-br from-blue-600 to-indigo-800 rounded-2xl p-5 text-white shadow-xl">
                            <p className="text-blue-200 text-xs font-black uppercase tracking-widest mb-1">{t('attendance.myPunctuality')}</p>
                            <h3 className="text-4xl font-black tracking-tight">{punctualityScore}%</h3>
                        </div>
                        <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-5 shadow-xl backdrop-blur-md">
                            <p className="mb-1 text-slate-400">{t('attendance.totalPresentDays')}</p>
                            <h3 className="text-4xl font-black text-white mt-1">{totalDays} <span className="text-xs font-bold text-slate-500 uppercase">{t('attendance.days')}</span></h3>
                        </div>
                        <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-5 shadow-xl backdrop-blur-md">
                            <p className="mb-1 text-slate-400">{t('attendance.lateArrivals')}</p>
                            <h3 className={`text-4xl font-black ${lateDays > 0 ? 'text-amber-400' : 'text-white'} mt-1`}>{lateDays} <span className="text-xs font-bold text-slate-500 uppercase">{t('attendance.days')}</span></h3>
                        </div>
                    </div>

                    <div className="bg-slate-800/40 p-5 rounded-2xl border border-slate-700/50 shadow-xl flex flex-col md:flex-row justify-between items-center gap-4 backdrop-blur-md">
                         <div className="flex items-center gap-4">
                            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-2xl ${isInRange ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20 animate-pulse'}`}>
                                {(userProfile.work_mode || 'WFO') === 'WFO' ? '🏢' : '🏠'}
                            </div>
                            <div>
                                <h2 className="text-base font-bold text-white">{t('attendance.assignedDutyProfile', { mode: (userProfile.work_mode || 'WFO') === 'WFO' ? t('attendance.officeBoundary') : t('attendance.remoteHome') })}</h2>
                                <p className={`text-xs font-bold uppercase font-mono mt-0.5 tracking-wider ${isInRange ? 'text-emerald-400' : 'text-red-400'}`}>
                                    {(userProfile.work_mode || 'WFO') === 'WFO'
                                        ? (liveDistance !== null ? t('attendance.coordinatesTracked', { distance: liveDistance.toFixed(0) }) : t('attendance.capturingGps'))
                                        : t('attendance.remoteGeofenceBypass')}
                                </p>
                            </div>
                         </div>

                         <div className="flex gap-3 w-full md:w-auto">
                            {!todayRecord && (
                                <button
                                    type="button"
                                    onClick={() => handleClockIn('manual')}
                                    disabled={isLoading || !isInRange || !isCameraReady || !isFaceVerified || !hasBlinked}
                                    className={`w-full md:w-auto px-8 py-3 rounded-xl font-bold text-slate-900 transition-all shadow-lg ${isLoading || !isInRange || !isCameraReady || !isFaceVerified || !hasBlinked ? 'bg-slate-700 text-slate-500 cursor-not-allowed border border-slate-600' : 'bg-gradient-to-r from-yellow-400 to-amber-500 hover:from-yellow-300 hover:to-amber-400 hover:-translate-y-0.5 font-black uppercase text-xs tracking-widest'}`}
                                >
                                    {isLoading
                                        ? t('attendance.processing')
                                        : (isFaceVerified && !hasBlinked
                                            ? t(challengeType === CHALLENGE_TYPES.HEAD_TURN ? 'attendance.pleaseTurnHead' : 'attendance.pleaseBlink')
                                            : (isFaceVerified ? t('attendance.clockInShift') : t('attendance.verifyBiometrics')))}
                                </button>
                            )}
                            {todayRecord && !todayRecord.clock_out && (
                                <button type="button" onClick={handleClockOut} disabled={isLoading} className="w-full md:w-auto px-8 py-3 rounded-xl font-black text-white bg-red-600 hover:bg-red-500 transition-all shadow-md hover:-translate-y-0.5 uppercase text-xs tracking-widest">
                                    {t('attendance.clockOutShift')}
                                </button>
                            )}
                            {todayRecord && todayRecord.clock_out && (
                                <div className="w-full md:w-auto px-8 py-3 bg-slate-900 border border-slate-800 text-slate-500 font-extrabold rounded-xl text-xs uppercase tracking-widest text-center">{t('attendance.shiftCompleted')}</div>
                            )}
                         </div>
                    </div>

                    <div className="bg-slate-800/40 rounded-2xl border border-slate-700/50 shadow-xl overflow-hidden backdrop-blur-md">
                        <div className="px-5 py-4 border-b border-slate-700/60 bg-slate-800/20">
                            <h3 className="text-sm font-bold text-white">{t('attendance.liveVerificationGate')}</h3>
                            <p className="text-[11px] text-slate-400 mt-0.5">{t('attendance.liveVerificationDescription')}</p>
                        </div>
                        <div className="p-5 flex flex-col items-center">
                            {/* LIVE VIDEO FRAME HOUSING WITH RESTORED OVERLAY MAPPERS */}
                            <div className="relative w-full max-w-md aspect-video bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden group shadow-2xl">
                                <video
                                    ref={webcamVideoRef}
                                    autoPlay
                                    playsInline
                                    muted
                                    className="absolute inset-0 w-full h-full object-cover"
                                    style={{ transform: 'scaleX(-1)' }}
                                />
                                
                                {/* 🟩 RESTORED: Pure geometric YOLO-style HTML wireframe bounding box */}
                                {faceOverlayBox && isCameraReady && (
                                    <div
                                        className={`absolute border-2 rounded-xl z-20 pointer-events-none transition-all duration-75 ${
                                            faceStatus === 'matched' ? 'border-emerald-400 bg-emerald-500/10 shadow-[0_0_15px_rgba(52,211,153,0.3)]' : 'border-blue-400 bg-blue-500/10 shadow-[0_0_15px_rgba(96,165,250,0.3)]'
                                        }`}
                                        style={getFaceOverlayStyle() || { display: 'none' }}
                                    >
                                        <div className={`absolute -top-6 left-0 text-[9px] font-black tracking-widest px-2 py-0.5 rounded-md text-white font-mono uppercase shadow-md ${
                                            faceStatus === 'matched' ? 'bg-emerald-500' : 'bg-blue-500'
                                        }`}>
                                            {faceOverlayBox.source === 'yolo' ? '⚡ YOLOv8 FACE' : '🔍 FACE-API'}
                                        </div>
                                    </div>
                                )}

                                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-slate-900/95 border border-blue-500/30 backdrop-blur-md text-[10px] font-mono font-bold text-blue-400 px-3 py-1 rounded-full uppercase tracking-widest whitespace-nowrap z-30 animate-pulse shadow-2xl">
                                    {biometricStatus}
                                </div>
                            </div>

                            <div className="mt-4 flex flex-wrap gap-2 w-full max-w-md text-[10px] font-black uppercase tracking-widest font-mono">
                                <button type="button" onClick={handleEnrollFaceFromStream} disabled={!isCameraReady || hasStoredFace || isEnrolling} className="flex-1 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white shadow-md disabled:bg-slate-800 disabled:text-slate-600 transition-all">{isEnrolling ? t('attendance.enrolling') : t('attendance.enrollFacialMatrix')}</button>
                                <button type="button" onClick={handleResetEnrolledFace} disabled={isEnrolling} className="px-4 py-2 rounded-xl bg-slate-900 border border-slate-700 text-slate-400 hover:text-white transition-all disabled:opacity-50">{t('attendance.resetMatrix')}</button>
                            </div>
                        </div>
                    </div>

                    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 shadow-inner">
                        <div className="flex items-center justify-between mb-4">
                            <span id="personal-clock-log-label" className="text-[11px] font-black uppercase tracking-widest text-slate-400">{t('attendance.personalClockLog')}</span>
                            <select
                                aria-labelledby="personal-clock-log-label"
                                value={historyStatusFilter}
                                onChange={(e) => setHistoryStatusFilter(e.target.value)}
                                className="text-[10px] font-bold uppercase tracking-wider bg-slate-900 border border-slate-700 text-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:border-blue-500"
                            >
                                <option value="all">{t('attendance.allRecords')}</option>
                                <option value="Present">{t('attendance.onTimeOnly')}</option>
                                <option value="Late">{t('attendance.lateOnly')}</option>
                            </select>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {filteredMyHistory.slice(0, 9).map(record => (
                                <div key={record.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 flex flex-col justify-between shadow-sm">
                                    <div className="flex items-center justify-between mb-1.5 border-b border-slate-800 pb-1.5">
                                        <span className="text-[11px] font-bold text-white font-mono">{record.date}</span>
                                        <span className={`text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md border ${
                                            record.status === 'Late'
                                                ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
                                                : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                                        }`}>
                                            {record.status === 'Late' ? t('attendance.late') : t('attendance.onTime')}
                                        </span>
                                    </div>
                                    <div className="space-y-0.5 text-[11px] text-slate-400 font-mono">
                                        <div>{t('attendance.inTime')} : <span className="text-white font-bold">{getRecordClockInTime(record)}</span></div>
                                        <div>{t('attendance.outTime')}: <span className="text-white font-bold">{record.clock_out || '--:--:--'}</span></div>
                                    </div>
                                </div>
                            ))}
                            {filteredMyHistory.length === 0 && (
                                <p className="col-span-full text-center text-xs text-slate-500 italic py-6">{t('attendance.noMatchingRecords')}</p>
                            )}
                        </div>
                    </div>
                </>
            )}

            <Modal isOpen={showConsentModal} onClose={() => setShowConsentModal(false)} title={t('attendance.consentTitle')}>
                <div className="space-y-4">
                    <p className="text-sm text-gray-700 dark:text-gray-200">{t('attendance.consentBody')}</p>
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setShowConsentModal(false)}
                            className="px-4 py-2 text-xs font-bold rounded-xl border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                        >
                            {t('confirm.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={handleConsentAccept}
                            className="px-4 py-2 text-xs font-bold rounded-xl text-white bg-blue-600 hover:bg-blue-700 shadow-sm"
                        >
                            {t('attendance.consentAccept')}
                        </button>
                    </div>
                </div>
            </Modal>
        </div>
    );
};

export default AttendanceView;