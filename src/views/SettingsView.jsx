import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { supabase } from '../supabaseClient';
import { sanitizeFileExtension } from '../utils/sanitize';
import { checkRateLimit, formatRateLimitMessage } from '../utils/rateLimit';
import { validateAvatarFile } from '../utils/validateMime';
import { showUserError } from '../utils/errorHandling';
import { notificationDispatcher } from '../patterns/notificationChannels/NotificationDispatcher';
import { BrowserPushChannel } from '../patterns/notificationChannels/BrowserPushChannel';

/**
 * COMPONENT: SettingsView
 * PURPOSE: Secure account profile configuration center.
 * FEATURES:
 * 1. Binary stream uploads to Supabase Object Storage with automated public URL bindings.
 * 2. User credential mutation handlers via Supabase Auth updating security layers.
 */
const SettingsView = ({
    userProfile, fetchProfile, allUsers = [], fetchAllUsers,
    colorblindMode, setColorblindMode,
    fontSize, setFontSize,
    highContrast, setHighContrast,
    reduceMotion, setReduceMotion,
    isDarkMode, toggleDarkMode,
    onReplayOnboarding,
}) => {
    const { t, i18n } = useTranslation();

    // --- INTERFACE UTILITY LOADING STATES ---
    const [uploading, setUploading] = useState(false);
    const [password, setPassword] = useState('');

    // --- BROWSER PUSH NOTIFICATION CHANNEL (strategy pattern toggle) ---
    const pushChannel = notificationDispatcher.getChannel(BrowserPushChannel);
    const [pushPermission, setPushPermission] = useState(
        pushChannel?.isSupported() ? Notification.permission : 'unsupported'
    );
    const handleEnableDesktopNotifications = async () => {
        const result = await pushChannel.requestPermission();
        setPushPermission(result);
        if (result === 'granted') toast.success(t('settings.desktopNotificationsEnabled'));
        else if (result === 'denied') toast.error(t('settings.desktopNotificationsDenied'));
    };
    const [confirmPassword, setConfirmPassword] = useState('');

    // --- SUPERVISOR-ONLY: STAFF DEPARTMENT / CONTRACT ASSIGNMENT ---
    const [editingStaffId, setEditingStaffId] = useState(null);
    const [staffEditDraft, setStaffEditDraft] = useState({ department: '', contract_start_date: '', contract_end_date: '' });
    const [savingStaffId, setSavingStaffId] = useState(null);
    const employeeUsers = allUsers.filter(u => u.role === 'employee');

    /**
     * PIPELINE TRANSACTION: handleAvatarUpload
     * PURPOSE: Manages the binary image stream upload to the 'avatars' storage bucket.
     * STEP-BY-STEP OPERATION:
     * 1. Extends a unique isolated folder path inside storage via: user_id/timestamp.ext
     * 2. Directs the file stream payload to Supabase Storage with upsert overwrite safety overrides.
     * 3. References the immutable storage asset public URL endpoint.
     * 4. Updates public.profiles dynamically to match the newly generated publicUrl asset source path.
     */
    const handleAvatarUpload = async (event) => {
        try {
            setUploading(true);

            const rateLimit = await checkRateLimit('avatar-upload', { maxRequests: 5, windowSeconds: 30 });
            if (!rateLimit.allowed) {
                toast.error(formatRateLimitMessage(rateLimit.retryAfterMs));
                return;
            }
            
            // Edge-case check ensuring the file array payload exists safely
            if (!event.target.files || event.target.files.length === 0) {
                return; 
            }

            const file = event.target.files[0];
                // Validate file MIME type and extension before upload
                const validation = validateAvatarFile(file);
                if (!validation.valid) {
                    toast.error(t('settings.avatarUploadError', { error: validation.error }));
                    setUploading(false);
                    event.target.value = null;
                    return;
                }
            
            // Keep only a safe file extension when building the storage path.
            const fileExt = sanitizeFileExtension(file.name);
            const filePath = `${userProfile.id}/${Date.now()}.${fileExt}`;

            // 1. Dispatch binary stream to Supabase Storage bucket asset paths
            const { error: uploadError } = await supabase.storage
                .from('avatars')
                .upload(filePath, file, { upsert: true });

            if (uploadError) throw uploadError;

           // 2. Resolve immutable public absolute tracking URL references
            const { data } = supabase.storage.from('avatars').getPublicUrl(filePath);
            
            // 3. Bind resolved public URL value to the user profile table record
            const { error: updateError } = await supabase
                .from('profiles')
                // 🟩 FIX: Append a cache-busting timestamp so the UI updates instantly
                .update({ avatar_url: `${data.publicUrl}?t=${Date.now()}` })
                .eq('id', userProfile.id);
                
            if (updateError) throw updateError;

            toast.success(t('settings.avatarUpdated'));
            fetchProfile(); // Invalidates core app level layout caches to trigger live visual re-renders
        } catch (error) {
            showUserError('Failed to upload profile image', error);
        } finally {
            setUploading(false);
        }
    };

    /**
     * PIPELINE TRANSACTION: handlePasswordChange
     * PURPOSE: Encrypted update routing channel to reset active auth passwords.
     * BOUNDARY CONDITIONS: Enforces minimum character parameters matching strict Supabase schemas.
     */
    const handlePasswordChange = async () => {
        if (password !== confirmPassword) {
            toast.error(t('settings.passwordMismatch'));
            return;
        }

        const rateLimit = await checkRateLimit('password-change', { maxRequests: 5, windowSeconds: 60 });
        if (!rateLimit.allowed) {
            toast.error(formatRateLimitMessage(rateLimit.retryAfterMs));
            return;
        }

        if (password.length < 6) {
            toast.error(t('settings.passwordTooShort'));
            return;
        }

        // Requests an authenticated account update mutation pipeline from Supabase Auth
        const { error } = await supabase.auth.updateUser({ password: password });

        if (error) {
            showUserError('Failed to update password', error);
        } else {
            toast.success(t('settings.passwordChanged'));
            setPassword('');
            setConfirmPassword('');
        }
    };

    /**
     * PIPELINE TRANSACTION: handleSaveStaffAssignment
     * PURPOSE: Supervisor-only update of another user's department and
     * internship contract period. Guarded server-side by the
     * protect_privileged_profile_columns trigger regardless of what the
     * client sends.
     */
    const handleSaveStaffAssignment = async (targetId) => {
        setSavingStaffId(targetId);
        const { error } = await supabase
            .from('profiles')
            .update({
                department: staffEditDraft.department || null,
                contract_start_date: staffEditDraft.contract_start_date || null,
                contract_end_date: staffEditDraft.contract_end_date || null,
            })
            .eq('id', targetId);

        if (error) {
            showUserError('Failed to update assignment', error);
        } else {
            setEditingStaffId(null);
            fetchAllUsers && fetchAllUsers();
        }
        setSavingStaffId(null);
    };

    const handleLanguageChange = (lang) => {
        i18n.changeLanguage(lang);
        localStorage.setItem('language', lang);
    };

    return (
        <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6">
            <div>
                <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100">{t('settings.title')}</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.subtitle')}</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">

                {/* --- CONTAINER SECTION 0: MY ASSIGNMENT (READ-ONLY FOR EVERYONE) --- */}
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700 md:col-span-2">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('settings.myAssignment')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4 font-medium">{t('settings.myAssignmentDescription')}</p>
                    <div className="flex flex-col sm:flex-row gap-6 text-xs">
                        <div className="space-y-1">
                            <span className="block font-bold text-gray-400 uppercase tracking-wider text-[10px]">{t('settings.department')}</span>
                            <span className="font-bold text-gray-800 dark:text-gray-100">{userProfile.department || t('settings.notAssignedYet')}</span>
                        </div>
                        <div className="space-y-1">
                            <span className="block font-bold text-gray-400 uppercase tracking-wider text-[10px]">{t('settings.contractPeriod')}</span>
                            <span className="font-bold text-gray-800 dark:text-gray-100">
                                {userProfile.contract_start_date && userProfile.contract_end_date
                                    ? `${new Date(userProfile.contract_start_date).toLocaleDateString('en-GB')} – ${new Date(userProfile.contract_end_date).toLocaleDateString('en-GB')}`
                                    : t('settings.notSetYet')}
                            </span>
                        </div>
                    </div>
                </div>

                {/* --- CONTAINER SECTION 1: PROFILE PICTURE ASSET ENGINE --- */}
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700 flex flex-col justify-between">
                    <div>
                        <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('settings.registeredFacePhoto')}</h3>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mb-6 font-medium">{t('settings.registeredFacePhotoDescription')}</p>
                    </div>
                    
                    <div className="flex flex-col items-center py-4">
                        <div className="relative group">
                            {/* Outer Avatar Frame Container */}
                            <div className="w-32 h-32 rounded-full bg-gray-50 overflow-hidden border-4 border-white shadow-md group-hover:opacity-90 transition dark:border-gray-700 dark:bg-gray-700">
                                {userProfile.avatar_url ? (
                                    <img 
                                        src={userProfile.avatar_url} 
                                        alt="Active Operational Identity" 
                                        className="w-full h-full object-cover"
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-4xl font-extrabold text-blue-600 bg-blue-50 dark:bg-slate-900/60 dark:text-blue-400">
                                        {userProfile.name?.charAt(0)}
                                    </div>
                                )}
                            </div>

                            {/* Floating Hardware Media Selection Trigger Overlay */}
                            <label className="absolute bottom-0 right-0 bg-blue-600 text-white p-2.5 rounded-full cursor-pointer shadow-lg hover:bg-blue-700 hover:scale-105 active:scale-95 transition-all">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                    <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                                </svg>
                                <input 
                                    type="file" 
                                    className="hidden" 
                                    accept="image/*" 
                                    onChange={handleAvatarUpload} 
                                    disabled={uploading} 
                                />
                            </label>
                        </div>
                        
                        <p className="text-[11px] font-bold text-gray-400 mt-5 uppercase tracking-wide">
                            {uploading ? t('settings.processingImage') : t('settings.photoHint')}
                        </p>
                    </div>
                </div>

                {/* --- CONTAINER SECTION 2: AUTH SECURITY CONTROL LAYERS --- */}
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                    <div className="mb-6">
                        <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('settings.securityCredentials')}</h3>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mb-6 font-medium">{t('settings.securityCredentialsDescription')}</p>
                    </div>

                    <div className="space-y-4 text-xs font-semibold text-gray-500 dark:text-gray-400">
                        <div className="space-y-1">
                            <label className="block pl-1 font-bold text-[10px] text-gray-400 uppercase tracking-wider">{t('settings.newPassword')}</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full p-3 border border-gray-200 rounded-xl dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none font-medium"
                                placeholder="••••••••"
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="block pl-1 font-bold text-[10px] text-gray-400 uppercase tracking-wider">{t('settings.confirmNewPassword')}</label>
                            <input
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                className="w-full p-3 border border-gray-200 rounded-xl dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none font-medium"
                                placeholder="••••••••"
                            />
                        </div>

                        <button 
                            type="button"
                            onClick={handlePasswordChange}
                            disabled={!password || !confirmPassword}
                            className="w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all mt-4 text-xs shadow-sm shadow-blue-500/10"
                        >
                            {t('settings.updatePassword')}
                        </button>
                    </div>
                </div>

            </div>

            {/* --- CONTAINER SECTION 3: MANAGE STAFF ASSIGNMENTS (SUPERVISOR ONLY) --- */}
            {userProfile.role === 'supervisor' && (
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('settings.manageStaffAssignments')}</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-6 font-medium">{t('settings.manageStaffAssignmentsDescription')}</p>

                    <div className="space-y-3">
                        {employeeUsers.length === 0 && (
                            <p className="text-xs text-gray-400 italic py-4 text-center">{t('settings.noEmployeesFound')}</p>
                        )}
                        {employeeUsers.map(emp => (
                            <div key={emp.id} className="border border-gray-100 dark:border-gray-700 rounded-xl p-4">
                                <div className="flex justify-between items-center gap-4">
                                    <div>
                                        <p className="font-bold text-sm text-gray-800 dark:text-gray-100">{emp.name}</p>
                                        <p className="text-[11px] text-gray-400">
                                            {emp.department || t('settings.noDepartment')} &middot; {emp.contract_start_date && emp.contract_end_date
                                                ? `${new Date(emp.contract_start_date).toLocaleDateString('en-GB')} – ${new Date(emp.contract_end_date).toLocaleDateString('en-GB')}`
                                                : t('settings.noContractDates')}
                                        </p>
                                    </div>
                                    {editingStaffId !== emp.id && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setEditingStaffId(emp.id);
                                                setStaffEditDraft({
                                                    department: emp.department || '',
                                                    contract_start_date: emp.contract_start_date || '',
                                                    contract_end_date: emp.contract_end_date || '',
                                                });
                                            }}
                                            className="text-[11px] font-bold text-blue-600 hover:text-blue-800 dark:text-blue-400"
                                        >
                                            {t('settings.edit')}
                                        </button>
                                    )}
                                </div>

                                {editingStaffId === emp.id && (
                                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                                        <div className="space-y-1">
                                            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider">{t('settings.department')}</label>
                                            <input
                                                type="text"
                                                value={staffEditDraft.department}
                                                onChange={(e) => setStaffEditDraft(d => ({ ...d, department: e.target.value }))}
                                                placeholder={t('settings.departmentPlaceholder')}
                                                className="w-full p-2 text-xs border border-gray-200 rounded-lg dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none"
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider">{t('settings.contractStart')}</label>
                                            <input
                                                type="date"
                                                value={staffEditDraft.contract_start_date}
                                                onChange={(e) => setStaffEditDraft(d => ({ ...d, contract_start_date: e.target.value }))}
                                                className="w-full p-2 text-xs border border-gray-200 rounded-lg dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none"
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider">{t('settings.contractEnd')}</label>
                                            <input
                                                type="date"
                                                value={staffEditDraft.contract_end_date}
                                                onChange={(e) => setStaffEditDraft(d => ({ ...d, contract_end_date: e.target.value }))}
                                                className="w-full p-2 text-xs border border-gray-200 rounded-lg dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none"
                                            />
                                        </div>
                                        <div className="sm:col-span-3 flex gap-2 justify-end mt-1">
                                            <button
                                                type="button"
                                                onClick={() => setEditingStaffId(null)}
                                                className="px-3 py-1.5 text-[11px] font-bold text-gray-500 hover:text-gray-700 dark:text-gray-400 rounded-lg"
                                            >
                                                {t('settings.cancel')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleSaveStaffAssignment(emp.id)}
                                                disabled={savingStaffId === emp.id}
                                                className="px-3 py-1.5 text-[11px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
                                            >
                                                {savingStaffId === emp.id ? t('settings.saving') : t('settings.save')}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* --- CONTAINER SECTION: NOTIFICATION CHANNELS (strategy pattern) --- */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('settings.notificationChannels')}</h3>
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-4 font-medium">{t('settings.notificationChannelsDescription')}</p>
                {pushPermission === 'unsupported' ? (
                    <p className="text-xs text-gray-400 italic">{t('settings.desktopNotificationsUnsupported')}</p>
                ) : pushPermission === 'granted' ? (
                    <p className="text-xs font-bold text-green-600 dark:text-green-400">{t('settings.desktopNotificationsEnabled')}</p>
                ) : (
                    <button
                        type="button"
                        onClick={handleEnableDesktopNotifications}
                        className="px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
                    >
                        {t('settings.enableDesktopNotifications')}
                    </button>
                )}
            </div>

            {/* --- CONTAINER SECTION 4: ACCESSIBILITY --- */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">{t('accessibility.title')}</h3>
                <p className="text-xs text-gray-400 dark:text-gray-500 mb-6 font-medium">{t('accessibility.description')}</p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 text-xs">
                    {/* Language */}
                    <div className="space-y-1">
                        <label className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider">{t('accessibility.language')}</label>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-1">{t('accessibility.languageDescription')}</p>
                        <select
                            value={i18n.language}
                            onChange={(e) => handleLanguageChange(e.target.value)}
                            className="w-full p-2.5 border border-gray-200 rounded-xl dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none font-semibold"
                        >
                            <option value="en">English</option>
                            <option value="id">Bahasa Indonesia</option>
                        </select>
                    </div>

                    {/* Colorblind Mode */}
                    <div className="space-y-1">
                        <label className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider">{t('accessibility.colorblindMode')}</label>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-1">{t('accessibility.colorblindDescription')}</p>
                        <select
                            value={colorblindMode}
                            onChange={(e) => setColorblindMode(e.target.value)}
                            className="w-full p-2.5 border border-gray-200 rounded-xl dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none font-semibold"
                        >
                            <option value="none">{t('accessibility.colorblindNone')}</option>
                            <option value="protanopia">{t('accessibility.colorblindProtanopia')}</option>
                            <option value="deuteranopia">{t('accessibility.colorblindDeuteranopia')}</option>
                            <option value="tritanopia">{t('accessibility.colorblindTritanopia')}</option>
                        </select>
                    </div>

                    {/* Font Size */}
                    <div className="space-y-1">
                        <label className="block font-bold text-[10px] text-gray-400 uppercase tracking-wider">{t('accessibility.fontSize')}</label>
                        <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-1">{t('accessibility.fontSizeDescription')}</p>
                        <select
                            value={fontSize}
                            onChange={(e) => setFontSize(e.target.value)}
                            className="w-full p-2.5 border border-gray-200 rounded-xl dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none font-semibold"
                        >
                            <option value="normal">{t('accessibility.fontSizeNormal')}</option>
                            <option value="large">{t('accessibility.fontSizeLarge')}</option>
                            <option value="xl">{t('accessibility.fontSizeExtraLarge')}</option>
                        </select>
                    </div>

                    {/* Dark Mode + High Contrast + Reduce Motion toggles */}
                    <div className="space-y-4">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <p className="font-bold text-gray-700 dark:text-gray-200 text-[11px] uppercase tracking-wider">{t('accessibility.darkMode')}</p>
                                <p className="text-[11px] text-gray-400 dark:text-gray-500">{t('accessibility.darkModeDescription')}</p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={isDarkMode}
                                aria-label={t('accessibility.darkMode')}
                                onClick={toggleDarkMode}
                                className={`shrink-0 w-11 h-6 rounded-full transition-colors relative ${isDarkMode ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700'}`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${isDarkMode ? 'translate-x-5' : ''}`} />
                            </button>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <p className="font-bold text-gray-700 dark:text-gray-200 text-[11px] uppercase tracking-wider">{t('accessibility.highContrast')}</p>
                                <p className="text-[11px] text-gray-400 dark:text-gray-500">{t('accessibility.highContrastDescription')}</p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={highContrast}
                                aria-label={t('accessibility.highContrast')}
                                onClick={() => setHighContrast(!highContrast)}
                                className={`shrink-0 w-11 h-6 rounded-full transition-colors relative ${highContrast ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700'}`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${highContrast ? 'translate-x-5' : ''}`} />
                            </button>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <p className="font-bold text-gray-700 dark:text-gray-200 text-[11px] uppercase tracking-wider">{t('accessibility.reduceMotion')}</p>
                                <p className="text-[11px] text-gray-400 dark:text-gray-500">{t('accessibility.reduceMotionDescription')}</p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={reduceMotion}
                                aria-label={t('accessibility.reduceMotion')}
                                onClick={() => setReduceMotion(!reduceMotion)}
                                className={`shrink-0 w-11 h-6 rounded-full transition-colors relative ${reduceMotion ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700'}`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${reduceMotion ? 'translate-x-5' : ''}`} />
                            </button>
                        </div>
                    </div>
                </div>

                {/* Keyboard Shortcuts */}
                <div className="mt-6 pt-6 border-t border-gray-100 dark:border-gray-700">
                    <h4 className="font-bold text-[11px] text-gray-700 dark:text-gray-200 uppercase tracking-wider mb-1">{t('accessibility.keyboardShortcuts')}</h4>
                    <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-3">{t('accessibility.keyboardShortcutsDescription')}</p>
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
                        {[
                            { key: 'Esc', desc: t('accessibility.shortcutEsc') },
                            { key: 'Tab', desc: t('accessibility.shortcutTab') },
                            { key: 'Shift + Tab', desc: t('accessibility.shortcutShiftTab') },
                            { key: 'Enter / Space', desc: t('accessibility.shortcutEnterSpace') },
                        ].map(({ key, desc }) => (
                            <div key={key} className="flex items-center gap-2">
                                <dt>
                                    <kbd className="px-2 py-1 text-[10px] font-bold bg-gray-100 dark:bg-gray-900/60 border border-gray-200 dark:border-gray-600 rounded-md text-gray-600 dark:text-gray-300">
                                        {key}
                                    </kbd>
                                </dt>
                                <dd className="text-gray-500 dark:text-gray-400">{desc}</dd>
                            </div>
                        ))}
                    </dl>
                </div>

                {/* Onboarding Tour Replay */}
                {onReplayOnboarding && (
                    <div className="mt-6 pt-6 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between gap-4">
                        <div>
                            <h4 className="font-bold text-[11px] text-gray-700 dark:text-gray-200 uppercase tracking-wider mb-1">{t('accessibility.onboardingTour')}</h4>
                            <p className="text-[11px] text-gray-400 dark:text-gray-500">{t('accessibility.onboardingTourDescription')}</p>
                        </div>
                        <button
                            type="button"
                            onClick={onReplayOnboarding}
                            className="shrink-0 text-xs font-bold text-blue-600 bg-blue-50 dark:bg-blue-950/30 dark:text-blue-300 px-4 py-2 rounded-xl hover:bg-blue-100 dark:hover:bg-blue-900/40 transition"
                        >
                            {t('accessibility.replayTour')}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default SettingsView;