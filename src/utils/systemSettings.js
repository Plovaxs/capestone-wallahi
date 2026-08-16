import { systemSettingsRepository } from '../data/repositories/systemSettingsRepository';

const VIRTUAL_CAMERA_CHECK_KEY = 'virtual_camera_check_enabled';

/**
 * Whether the virtual-camera-driver block on face sign-in (see
 * vision/virtualCameraDetector.js, used by LoginPage.jsx and
 * AttendanceView.jsx) is currently active -- a supervisor-controlled
 * global switch (Debug Center > Camera & Face), not a per-browser
 * preference. Fails OPEN to `true` (check stays enforced) on any read
 * error or missing row -- a security check should never silently turn
 * itself off just because a fetch failed; the supervisor toggle is the
 * only intentional way to disable it.
 */
export async function isVirtualCameraCheckEnabled() {
    try {
        const row = await systemSettingsRepository.get(VIRTUAL_CAMERA_CHECK_KEY);
        if (!row || typeof row.value !== 'boolean') return true;
        return row.value;
    } catch {
        return true;
    }
}

export { VIRTUAL_CAMERA_CHECK_KEY };
