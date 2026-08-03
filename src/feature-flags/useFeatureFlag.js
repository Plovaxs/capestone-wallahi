import { useState, useEffect } from 'react';
import { featureFlags } from './FeatureFlagService';

/** Re-renders the calling component whenever `flagName` changes. */
export function useFeatureFlag(flagName) {
    const [enabled, setEnabled] = useState(() => featureFlags.isEnabled(flagName));

    useEffect(() => {
        setEnabled(featureFlags.isEnabled(flagName));
        return featureFlags.subscribe(() => setEnabled(featureFlags.isEnabled(flagName)));
    }, [flagName]);

    return enabled;
}
