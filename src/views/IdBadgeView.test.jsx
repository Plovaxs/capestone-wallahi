import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../i18n';

vi.mock('qrcode', () => ({
    default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,fake')) },
}));

import IdBadgeView from './IdBadgeView';

const profile = { id: 'emp-42', name: 'Budi Santoso', position: 'Intern', department: 'IT' };

describe('IdBadgeView', () => {
    it('renders the Overview tab by default with the QR badge', async () => {
        await act(async () => { render(<IdBadgeView userProfile={profile} />); });
        expect(screen.getByText('ID Badge')).toBeInTheDocument();
        expect(screen.getByAltText('ID Badge')).toBeInTheDocument();
    });

    it('the Payload Details tab decodes and shows exactly what a scanner would read', async () => {
        await act(async () => { render(<IdBadgeView userProfile={profile} />); });
        await act(async () => { screen.getByText('Payload Details').click(); });

        expect(screen.getByText('emp-42')).toBeInTheDocument();
        expect(screen.getByText('Budi Santoso')).toBeInTheDocument();
        expect(screen.getByText(/"id":"emp-42"/)).toBeInTheDocument();
    });

    it('the Print Layout tab shows a print-ready card and a working Print button', async () => {
        await act(async () => { render(<IdBadgeView userProfile={profile} />); });
        await act(async () => { screen.getByText('Print Layout').click(); });

        const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
        await act(async () => { screen.getByText('Print').click(); });
        expect(printSpy).toHaveBeenCalled();
        printSpy.mockRestore();
    });
});
