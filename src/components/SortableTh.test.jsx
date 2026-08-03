import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import SortableTh from './SortableTh';

const renderInTable = (props) => render(
    <table><thead><tr><SortableTh {...props} /></tr></thead></table>
);

describe('SortableTh', () => {
    it('renders the label', () => {
        renderInTable({ label: 'Name', sortKey: 'name', sortConfig: { key: null, direction: 'asc' }, onSort: vi.fn() });
        expect(screen.getByText('Name')).toBeInTheDocument();
    });

    it('calls onSort with its sortKey when clicked', () => {
        const onSort = vi.fn();
        renderInTable({ label: 'Name', sortKey: 'name', sortConfig: { key: null, direction: 'asc' }, onSort });

        fireEvent.click(screen.getByRole('button'));
        expect(onSort).toHaveBeenCalledWith('name');
    });

    it('shows aria-sort="ascending" when active and ascending', () => {
        renderInTable({ label: 'Name', sortKey: 'name', sortConfig: { key: 'name', direction: 'asc' }, onSort: vi.fn() });
        expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending');
    });

    it('shows aria-sort="none" when a different column is active', () => {
        renderInTable({ label: 'Name', sortKey: 'name', sortConfig: { key: 'status', direction: 'asc' }, onSort: vi.fn() });
        expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'none');
    });

    it('has no detectable accessibility violations', async () => {
        const { container } = renderInTable({ label: 'Name', sortKey: 'name', sortConfig: { key: 'name', direction: 'asc' }, onSort: vi.fn() });
        expect(await axe(container)).toHaveNoViolations();
    });
});
