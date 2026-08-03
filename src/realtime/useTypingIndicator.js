import { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';

const STALE_AFTER_MS = 3000;

/**
 * Broadcasts "I'm typing" pings on a per-room Realtime broadcast channel
 * (no table, no persistence — just an ephemeral fan-out event) and tracks
 * who else is currently typing in that same room, expiring anyone whose
 * last ping is older than STALE_AFTER_MS in case their "stopped typing"
 * event never arrives (closed tab, dropped connection, etc.).
 */
export function useTypingIndicator(roomKey, userProfile) {
    const [typingNames, setTypingNames] = useState([]);
    const channelRef = useRef(null);
    const staleTimersRef = useRef({});

    useEffect(() => {
        if (!roomKey || !userProfile?.id) return;

        const channel = supabase.channel(`typing:${roomKey}`);
        channel
            .on('broadcast', { event: 'typing' }, ({ payload }) => {
                if (payload.userId === userProfile.id) return;

                setTypingNames((prev) => (prev.includes(payload.name) ? prev : [...prev, payload.name]));

                clearTimeout(staleTimersRef.current[payload.userId]);
                staleTimersRef.current[payload.userId] = setTimeout(() => {
                    setTypingNames((prev) => prev.filter((name) => name !== payload.name));
                }, STALE_AFTER_MS);
            })
            .subscribe();

        channelRef.current = channel;

        return () => {
            supabase.removeChannel(channel);
            Object.values(staleTimersRef.current).forEach(clearTimeout);
            staleTimersRef.current = {};
        };
    }, [roomKey, userProfile?.id]);

    const broadcastTyping = () => {
        channelRef.current?.send({
            type: 'broadcast',
            event: 'typing',
            payload: { userId: userProfile.id, name: userProfile.name },
        });
    };

    return { typingNames, broadcastTyping };
}
