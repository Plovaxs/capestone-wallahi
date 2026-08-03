import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from 'jest-axe';
import PageSkeleton from './PageSkeleton';

describe('PageSkeleton', () => {
    it('is hidden from assistive tech (aria-hidden) since it has no meaningful content', () => {
        const { container } = render(<PageSkeleton />);
        expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
    });

    it('has no detectable accessibility violations', async () => {
        const { container } = render(<PageSkeleton />);
        expect(await axe(container)).toHaveNoViolations();
    });
});
