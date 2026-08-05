import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const setOnline = (value) => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
};

describe('NetworkStatusBanner', () => {
    afterEach(() => {
        vi.doUnmock('../utils/deviceAdaptive');
        vi.resetModules();
        setOnline(true);
    });

    it('renders nothing when online and the connection looks normal', async () => {
        setOnline(true);
        vi.doMock('../utils/deviceAdaptive', () => ({ getNetworkProfile: () => ({ supported: true, isSlow: false }) }));
        const { default: NetworkStatusBanner } = await import('./NetworkStatusBanner');

        const { container } = render(<NetworkStatusBanner />);
        expect(container).toBeEmptyDOMElement();
    });

    it('shows an offline banner when navigator.onLine is false', async () => {
        setOnline(false);
        vi.doMock('../utils/deviceAdaptive', () => ({ getNetworkProfile: () => ({ supported: true, isSlow: false }) }));
        const { default: NetworkStatusBanner } = await import('./NetworkStatusBanner');

        render(<NetworkStatusBanner />);
        expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('shows a slow-connection banner when getNetworkProfile reports isSlow', async () => {
        setOnline(true);
        vi.doMock('../utils/deviceAdaptive', () => ({ getNetworkProfile: () => ({ supported: true, isSlow: true }) }));
        const { default: NetworkStatusBanner } = await import('./NetworkStatusBanner');

        render(<NetworkStatusBanner />);
        expect(screen.getByRole('status')).toBeInTheDocument();
    });
});
