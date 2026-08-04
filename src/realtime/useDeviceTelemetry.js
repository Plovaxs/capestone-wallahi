import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';

const TELEMETRY_CHANNEL = 'presence:device-telemetry';

/**
 * "Digital twin" for the attendance edge devices: each employee's browser
 * tab is effectively a small edge node (camera + geofence + on-device ML
 * inference), and this broadcasts a lightweight snapshot of its local
 * state — camera health, geofence status, which YOLO tier it's running,
 * torch/low-light state — over a dedicated Supabase Realtime presence
 * channel. Presence data is ephemeral (never written to a table, gone the
 * moment the tab closes), so this is purely additive and touches nothing
 * in the database.
 *
 * Employees pass `localTelemetry` (re-tracked whenever it changes) to
 * publish their own snapshot; everyone (in practice, supervisors) reads
 * back `telemetryByUserId`, a live map of every currently-online device's
 * latest published snapshot.
 */
export function useDeviceTelemetry(userProfile, localTelemetry) {
    const [telemetryByUserId, setTelemetryByUserId] = useState({});
    const channelRef = useRef(null);

    useEffect(() => {
        if (!userProfile?.id) return;

        const channel = supabase.channel(TELEMETRY_CHANNEL, {
            config: { presence: { key: userProfile.id } },
        });
        channelRef.current = channel;

        channel
            .on('presence', { event: 'sync' }, () => {
                const state = channel.presenceState();
                const next = {};
                for (const [key, entries] of Object.entries(state)) {
                    // Presence entries are arrays (one per connection for that key) — the
                    // latest tracked payload is what we care about for a live dashboard.
                    next[key] = entries[entries.length - 1];
                }
                setTelemetryByUserId(next);
            })
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
            channelRef.current = null;
        };
    }, [userProfile?.id]);

    useEffect(() => {
        if (!userProfile?.id || userProfile.role === 'supervisor' || !localTelemetry || !channelRef.current) return;
        channelRef.current.track(localTelemetry);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userProfile?.id, userProfile?.role, JSON.stringify(localTelemetry)]);

    return telemetryByUserId;
}
