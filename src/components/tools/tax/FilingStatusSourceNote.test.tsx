import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilingStatusSourceNote } from './FilingStatusSourceNote';

describe('FilingStatusSourceNote', () => {
  it('renders nothing while inherited (value equals the household setting)', () => {
    const { container } = render(
      <FilingStatusSourceNote value="mfj" householdValue="mfj" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the household profile has no filing status', () => {
    const { container } = render(
      <FilingStatusSourceNote value="mfs" householdValue={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('marks divergence with the household label and a Settings link', () => {
    render(<FilingStatusSourceNote value="mfs" householdValue="mfj" />);
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('Differs from the household setting');
    expect(note.textContent).toContain('Married Filing Jointly');
    const link = screen.getByRole('link', { name: 'Settings' });
    expect(link).toHaveAttribute('href', '/settings');
  });

  it('returns to inherited state via the "Use household setting" action', () => {
    const onUseHousehold = vi.fn();
    render(
      <FilingStatusSourceNote
        value="single"
        householdValue="hoh"
        onUseHousehold={onUseHousehold}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use household setting' }));
    expect(onUseHousehold).toHaveBeenCalledTimes(1);
  });

  it('omits the reset action when no handler is provided', () => {
    render(<FilingStatusSourceNote value="single" householdValue="hoh" />);
    expect(screen.queryByRole('button', { name: 'Use household setting' })).toBeNull();
  });
});
