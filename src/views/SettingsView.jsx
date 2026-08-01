import React, { useState } from 'react';
import { supabase } from '../supabaseClient';
import { sanitizeFileExtension } from '../utils/sanitize';
import { checkRateLimit, formatRateLimitMessage } from '../utils/rateLimit';
import { validateAvatarFile } from '../utils/validateMime';
import { showUserError } from '../utils/errorHandling';

/**
 * COMPONENT: SettingsView
 * PURPOSE: Secure account profile configuration center.
 * FEATURES:
 * 1. Binary stream uploads to Supabase Object Storage with automated public URL bindings.
 * 2. User credential mutation handlers via Supabase Auth updating security layers.
 */
const SettingsView = ({ userProfile, fetchProfile, allUsers = [], fetchAllUsers }) => {
    // --- INTERFACE UTILITY LOADING STATES ---
    const [uploading, setUploading] = useState(false);
    const [password, setPassword] = useState('');
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
                alert(formatRateLimitMessage(rateLimit.retryAfterMs));
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
                    alert("❌ Avatar Upload Error: " + validation.error);
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

            alert('Profile picture updated cleanly!');
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
            alert("Security discrepancy: Input passwords do not match.");
            return;
        }

        const rateLimit = await checkRateLimit('password-change', { maxRequests: 5, windowSeconds: 60 });
        if (!rateLimit.allowed) {
            alert(formatRateLimitMessage(rateLimit.retryAfterMs));
            return;
        }

        if (password.length < 6) {
            alert("Security vulnerability: Passwords must contain at least 6 characters.");
            return;
        }

        // Requests an authenticated account update mutation pipeline from Supabase Auth
        const { error } = await supabase.auth.updateUser({ password: password });

        if (error) {
            showUserError('Failed to update password', error);
        } else {
            alert("Account password changed successfully!");
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

    return (
        <div className="p-8 max-w-4xl mx-auto space-y-6">
            <div>
                <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100">Account Settings</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">Manage identity configurations, media profiles, and access parameters.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">

                {/* --- CONTAINER SECTION 0: MY ASSIGNMENT (READ-ONLY FOR EVERYONE) --- */}
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700 md:col-span-2">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">My Assignment</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-4 font-medium">Department and contract period are set by your supervisor.</p>
                    <div className="flex flex-col sm:flex-row gap-6 text-xs">
                        <div className="space-y-1">
                            <span className="block font-bold text-gray-400 uppercase tracking-wider text-[10px]">Department</span>
                            <span className="font-bold text-gray-800 dark:text-gray-100">{userProfile.department || 'Not assigned yet'}</span>
                        </div>
                        <div className="space-y-1">
                            <span className="block font-bold text-gray-400 uppercase tracking-wider text-[10px]">Contract Period</span>
                            <span className="font-bold text-gray-800 dark:text-gray-100">
                                {userProfile.contract_start_date && userProfile.contract_end_date
                                    ? `${new Date(userProfile.contract_start_date).toLocaleDateString('en-GB')} – ${new Date(userProfile.contract_end_date).toLocaleDateString('en-GB')}`
                                    : 'Not set yet'}
                            </span>
                        </div>
                    </div>
                </div>

                {/* --- CONTAINER SECTION 1: PROFILE PICTURE ASSET ENGINE --- */}
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700 flex flex-col justify-between">
                    <div>
                        <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">Registered Face Photo</h3>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mb-6 font-medium">Upload a clear frontal face photo. This image is used as the registered identity for attendance matching.</p>
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
                            {uploading ? 'Processing Image Pipeline...' : 'PNG or JPG accepted. Max 2MB Limit.'}
                        </p>
                    </div>
                </div>

                {/* --- CONTAINER SECTION 2: AUTH SECURITY CONTROL LAYERS --- */}
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                    <div className="mb-6">
                        <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">Security Credentials</h3>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mb-6 font-medium">Amend system passwords regularly to satisfy cybersecurity framework rules.</p>
                    </div>
                    
                    <div className="space-y-4 text-xs font-semibold text-gray-500 dark:text-gray-400">
                        <div className="space-y-1">
                            <label className="block pl-1 font-bold text-[10px] text-gray-400 uppercase tracking-wider">New Password</label>
                            <input 
                                type="password" 
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full p-3 border border-gray-200 rounded-xl dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none font-medium"
                                placeholder="••••••••"
                            />
                        </div>
                        <div className="space-y-1">
                            <label className="block pl-1 font-bold text-[10px] text-gray-400 uppercase tracking-wider">Confirm New Password</label>
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
                            Update Password Layer
                        </button>
                    </div>
                </div>

            </div>

            {/* --- CONTAINER SECTION 3: MANAGE STAFF ASSIGNMENTS (SUPERVISOR ONLY) --- */}
            {userProfile.role === 'supervisor' && (
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 dark:bg-gray-800 dark:border-gray-700">
                    <h3 className="font-bold text-sm text-gray-800 dark:text-gray-100 mb-1">Manage Staff Assignments</h3>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mb-6 font-medium">Assign each intern's department and internship contract period.</p>

                    <div className="space-y-3">
                        {employeeUsers.length === 0 && (
                            <p className="text-xs text-gray-400 italic py-4 text-center">No employee accounts found yet.</p>
                        )}
                        {employeeUsers.map(emp => (
                            <div key={emp.id} className="border border-gray-100 dark:border-gray-700 rounded-xl p-4">
                                <div className="flex justify-between items-center gap-4">
                                    <div>
                                        <p className="font-bold text-sm text-gray-800 dark:text-gray-100">{emp.name}</p>
                                        <p className="text-[11px] text-gray-400">
                                            {emp.department || 'No department'} &middot; {emp.contract_start_date && emp.contract_end_date
                                                ? `${new Date(emp.contract_start_date).toLocaleDateString('en-GB')} – ${new Date(emp.contract_end_date).toLocaleDateString('en-GB')}`
                                                : 'No contract dates'}
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
                                            Edit
                                        </button>
                                    )}
                                </div>

                                {editingStaffId === emp.id && (
                                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                                        <div className="space-y-1">
                                            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider">Department</label>
                                            <input
                                                type="text"
                                                value={staffEditDraft.department}
                                                onChange={(e) => setStaffEditDraft(d => ({ ...d, department: e.target.value }))}
                                                placeholder="e.g. IT Division"
                                                className="w-full p-2 text-xs border border-gray-200 rounded-lg dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none"
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider">Contract Start</label>
                                            <input
                                                type="date"
                                                value={staffEditDraft.contract_start_date}
                                                onChange={(e) => setStaffEditDraft(d => ({ ...d, contract_start_date: e.target.value }))}
                                                className="w-full p-2 text-xs border border-gray-200 rounded-lg dark:bg-gray-900/40 dark:border-gray-600 dark:text-white focus:outline-none"
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider">Contract End</label>
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
                                                Cancel
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleSaveStaffAssignment(emp.id)}
                                                disabled={savingStaffId === emp.id}
                                                className="px-3 py-1.5 text-[11px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
                                            >
                                                {savingStaffId === emp.id ? 'Saving...' : 'Save'}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default SettingsView;