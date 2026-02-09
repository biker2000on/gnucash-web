'use client';

interface ImportPreviewProps {
  counts: {
    commodities: number;
    accounts: number;
    transactions: number;
    splits: number;
    prices: number;
    budgets: number;
  };
  onConfirm: () => void;
  onCancel: () => void;
  importing: boolean;
}

export function ImportPreview({ counts, onConfirm, onCancel, importing }: ImportPreviewProps) {
  const items = [
    { label: 'Commodities', count: counts.commodities, icon: 'C' },
    { label: 'Accounts', count: counts.accounts, icon: 'A' },
    { label: 'Transactions', count: counts.transactions, icon: 'T' },
    { label: 'Splits', count: counts.splits, icon: 'S' },
    { label: 'Prices', count: counts.prices, icon: 'P' },
    { label: 'Budgets', count: counts.budgets, icon: 'B' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-foreground mb-1">Import Preview</h3>
        <p className="text-sm text-foreground-muted">
          The following data will be imported into the database:
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {items.map((item) => (
          <div
            key={item.label}
            className="bg-surface/50 border border-border rounded-xl p-4 text-center"
          >
            <div className="text-2xl font-bold text-foreground">
              {item.count.toLocaleString()}
            </div>
            <div className="text-sm text-foreground-secondary mt-1">{item.label}</div>
          </div>
        ))}
      </div>

      {counts.transactions > 10000 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 text-sm text-amber-300">
          Large dataset detected. The import may take several minutes.
        </div>
      )}

      <div className="flex justify-end gap-3 pt-2">
        <button
          onClick={onCancel}
          disabled={importing}
          className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={importing}
          className="flex items-center gap-2 px-5 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50 text-white rounded-xl transition-colors"
        >
          {importing ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Importing...
            </>
          ) : (
            'Import Data'
          )}
        </button>
      </div>
    </div>
  );
}
