import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ModuleTabBar from './ModuleTabBar';

const tabs = [
    { id: 'overview', label: 'Overview', icon: <span /> },
    { id: 'insights', label: 'Insights', icon: <span /> },
];

describe('ModuleTabBar', () => {
    it('renders every tab and marks the active one', () => {
        render(<ModuleTabBar tabs={tabs} activeTab="overview" onChange={vi.fn()} />);
        expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tab', { name: /Insights/ })).toHaveAttribute('aria-selected', 'false');
    });

    it('calls onChange with the clicked tab id', () => {
        const onChange = vi.fn();
        render(<ModuleTabBar tabs={tabs} activeTab="overview" onChange={onChange} />);
        fireEvent.click(screen.getByRole('tab', { name: /Insights/ }));
        expect(onChange).toHaveBeenCalledWith('insights');
    });
});
