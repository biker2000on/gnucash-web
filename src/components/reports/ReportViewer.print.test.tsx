import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportViewer } from './ReportViewer';

vi.mock('./ReportFilters', () => ({
    ReportFilters: () => <div data-testid="report-filters" />,
}));

vi.mock('@/components/ui/ActionMenu', () => ({
    ActionMenu: ({ items }: { items: Array<{ label: string; onSelect: () => void }> }) => {
        const printItem = items.find((item) => item.label === 'Print');
        return <button onClick={printItem?.onSelect}>Print</button>;
    },
}));

describe('ReportViewer treasurer print typography', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('uses a targeted 12px treasurer print scale with compact vertical spacing', () => {
        const printWindow = {
            document: { close: vi.fn(), write: vi.fn() },
            focus: vi.fn(),
            print: vi.fn(),
            close: vi.fn(),
        } as unknown as Window;
        vi.spyOn(window, 'open').mockReturnValue(printWindow);

        render(
            <ReportViewer
                title="Treasurer Report"
                filters={{ startDate: null, endDate: null }}
                onFilterChange={vi.fn()}
            >
                <div className="treasurer-report p-6 space-y-8">Treasurer content</div>
            </ReportViewer>,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Print' }));

        const markup = (printWindow.document.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(markup).toContain('.treasurer-report {');
        expect(markup).toContain('font-size: 12px;');
        expect(markup).toContain('.treasurer-report h3 { font-size: 13px; }');
        expect(markup).toContain('.treasurer-report table,');
        expect(markup).toContain('margin-top: 6px !important;');
        expect(markup).toContain('padding-top: 1px !important;');
        expect(markup).toContain('.treasurer-report table { margin: 2px 0; }');
    });
});
