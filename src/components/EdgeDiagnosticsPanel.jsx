import React from 'react';
import DiagnosticTile from './DiagnosticTile';

/**
 * Local-only readout of the IoT/edge sensor signals AttendanceView's scan
 * loop is already computing every tick (camera, geofence, lens, ambient
 * light, device + pixel motion, color liveness, network, battery, model
 * tier) -- nothing here is sent anywhere, it just surfaces state that
 * already exists so that sensor-fusion work is actually visible instead of
 * running silently in the background. Extracted out of AttendanceView.jsx
 * (which was otherwise carrying its entire render tree in one file) since
 * this block is purely presentational and doesn't touch any of the view's
 * scan-loop state directly.
 */
const EdgeDiagnosticsPanel = ({ t, cameraError, isCameraReady, isInRange, sensorDiagnostics, torchActive, disableYolo }) => (
    <div className="rounded-2xl border border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/40 p-4 shadow-inner">
        <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-black uppercase tracking-widest text-gray-500 dark:text-slate-400">{t('attendance.edgeDiagnosticsTitle')}</span>
            <span className="text-[9px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500">{t('attendance.edgeDiagnosticsLocalOnly')}</span>
        </div>
        <p className="text-[10px] text-gray-400 dark:text-slate-500 mb-4">{t('attendance.edgeDiagnosticsDescription')}</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            <DiagnosticTile
                label={t('attendance.diagCamera')}
                value={cameraError ? t('attendance.diagIssue') : isCameraReady ? t('attendance.diagOk') : t('attendance.diagStarting')}
                ok={!cameraError && isCameraReady}
            />
            <DiagnosticTile
                label={t('attendance.diagGeofence')}
                value={isInRange ? t('attendance.diagInRange') : t('attendance.diagOutOfRange')}
                ok={isInRange}
            />
            <DiagnosticTile
                label={t('attendance.diagLens')}
                value={sensorDiagnostics.lensClear ? t('attendance.diagClear') : t('attendance.diagObstructed')}
                ok={sensorDiagnostics.lensClear}
            />
            <DiagnosticTile
                label={t('attendance.diagLighting')}
                value={sensorDiagnostics.isAmbientLowLight || torchActive ? t('attendance.diagLowLight') : t('attendance.diagNormal')}
                ok={!sensorDiagnostics.isAmbientLowLight}
                detail={typeof sensorDiagnostics.ambientLux === 'number' ? `${Math.round(sensorDiagnostics.ambientLux)} lux` : (torchActive ? t('attendance.torchActiveLabel') : null)}
            />
            <DiagnosticTile
                label={t('attendance.diagMotion')}
                value={!sensorDiagnostics.motionReady ? t('attendance.diagNoSensor') : sensorDiagnostics.motionStable ? t('attendance.diagStable') : t('attendance.diagFlagged')}
                ok={!sensorDiagnostics.motionReady || sensorDiagnostics.motionStable}
            />
            <DiagnosticTile
                label={t('attendance.diagPixelLiveness')}
                value={!sensorDiagnostics.microMotionReady ? t('attendance.diagWarming') : sensorDiagnostics.microMotionStable ? t('attendance.diagStable') : t('attendance.diagFlagged')}
                ok={!sensorDiagnostics.microMotionReady || sensorDiagnostics.microMotionStable}
            />
            <DiagnosticTile
                label={t('attendance.diagColorLiveness')}
                value={sensorDiagnostics.colorPlausible ? t('attendance.diagOk') : t('attendance.diagFlagged')}
                ok={sensorDiagnostics.colorPlausible}
            />
            <DiagnosticTile
                label={t('attendance.diagPulse')}
                value={!sensorDiagnostics.pulseReady ? t('attendance.diagWarming') : sensorDiagnostics.pulsePlausible ? t('attendance.diagDetected') : t('attendance.diagFlagged')}
                ok={!sensorDiagnostics.pulseReady || sensorDiagnostics.pulsePlausible}
            />
            <DiagnosticTile
                label={t('attendance.diagNetwork')}
                value={sensorDiagnostics.networkEffectiveType ? sensorDiagnostics.networkEffectiveType.toUpperCase() : t('attendance.diagUnknown')}
                ok={!sensorDiagnostics.isSlowNetwork}
            />
            <DiagnosticTile
                label={t('attendance.diagBattery')}
                value={typeof sensorDiagnostics.batteryLevel === 'number' ? `${Math.round(sensorDiagnostics.batteryLevel * 100)}%${sensorDiagnostics.isCharging ? ' ⚡' : ''}` : t('attendance.diagUnknown')}
                ok={sensorDiagnostics.batteryLevel === null || sensorDiagnostics.batteryLevel > 0.2 || sensorDiagnostics.isCharging}
            />
            <DiagnosticTile
                label={t('attendance.diagModel')}
                value={disableYolo ? t('attendance.diagModelReduced') : t('attendance.diagModelFull')}
                ok={true}
            />
            <DiagnosticTile
                label={t('attendance.diagLatency')}
                value={!sensorDiagnostics.latencyReady ? t('attendance.diagWarming') : `${sensorDiagnostics.avgLatencyMs}ms`}
                ok={!sensorDiagnostics.latencyReady || !sensorDiagnostics.latencyOverBudget}
                detail={sensorDiagnostics.latencyOverBudget ? t('attendance.diagLatencyDowngraded') : null}
            />
        </div>
    </div>
);

export default EdgeDiagnosticsPanel;
