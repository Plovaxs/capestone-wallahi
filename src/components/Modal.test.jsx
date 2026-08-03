import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import Modal from './Modal';

describe('Modal', () => {
    it('has no detectable accessibility violations while open', async () => {
        const { container } = render(
            <Modal isOpen={true} onClose={() => {}} title="Example dialog">
                <p>Some dialog content</p>
            </Modal>
        );
        expect(await axe(container)).toHaveNoViolations();
    });

    it('renders nothing when closed', () => {
        const { container } = render(
            <Modal isOpen={false} onClose={() => {}} title="Example dialog">
                <p>Some dialog content</p>
            </Modal>
        );
        expect(container).toBeEmptyDOMElement();
    });

    it('exposes dialog semantics (role, aria-modal, labelled title)', () => {
        render(
            <Modal isOpen={true} onClose={() => {}} title="Example dialog">
                <p>Some dialog content</p>
            </Modal>
        );
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByText('Example dialog')).toBeInTheDocument();
    });

    it('calls onClose when the close button is clicked', () => {
        let closed = false;
        render(
            <Modal isOpen={true} onClose={() => { closed = true; }} title="Example dialog">
                <p>Some dialog content</p>
            </Modal>
        );
        fireEvent.click(screen.getByRole('button'));
        expect(closed).toBe(true);
    });

    it('closes on Escape key', () => {
        let closed = false;
        render(
            <Modal isOpen={true} onClose={() => { closed = true; }} title="Example dialog">
                <p>Some dialog content</p>
            </Modal>
        );
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(closed).toBe(true);
    });
});
