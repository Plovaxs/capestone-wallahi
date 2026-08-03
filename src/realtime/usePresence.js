import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

/**
 * Joins a single shared Supabase Realtime "presence" channel and tracks
 * this user under their own id. Presence channels are ephemeral (no
 * table, no row) — Supabase itself keeps the roster of who's currently
 * subscribed and pushes sync/join/leave events to everyone in the channel.
 * Returns the live set of currently-online user ids.
 */
export function usePresence(userProfile) {
    const [onlineUserIds, setOnlineUserIds] = useState(new Set());

    useEffect(() => {
        if (!userProfile?.id) return;

        const channel = supabase.channel('presence:online-users', {
            config: { presence: { key: userProfile.id } },
        });

        channel
            .on('presence', { event: 'sync' }, () => {
                setOnlineUserIds(new Set(Object.keys(channel.presenceState())));
            })
            .subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    await channel.track({ user_id: userProfile.id, name: userProfile.name, online_at: new Date().toISOString() });
                }
            });

        return () => supabase.removeChannel(channel);
    }, [userProfile?.id, userProfile?.name]);

    return onlineUserIds;
}
