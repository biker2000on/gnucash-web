'use client';

import { useState } from 'react';
import { CurrencySelect } from '@/components/CurrencySelect';
import NewBookForm from '@/components/books/NewBookForm';

interface CreateBookWizardProps {
  onBookCreated: (bookGuid: string) => void;
  isOnboarding?: boolean;
}

export function CreateBookWizard({ onBookCreated, isOnboarding = false }: CreateBookWizardProps) {
  const [step, setStep] = useState<'choose' | 'create' | 'import'>('choose');
  const [bookName, setBookName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreateForImport = async () => {
    if (!bookName.trim()) {
      setError('Please enter a book name');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/books/from-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: bookName.trim(),
          currency,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create book');
      }

      const data = await res.json();
      onBookCreated(data.guid);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  if (step === 'choose') {
    return (
      <div>
        {isOnboarding && (
          <div className="text-center mb-10">
            <h1 className="text-3xl font-bold text-foreground mb-2">Welcome to GnuCash Web</h1>
            <p className="text-foreground-muted">
              Get started by creating your first book of accounts.
            </p>
          </div>
        )}
        {!isOnboarding && (
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-foreground">Create a New Book</h2>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <button
            onClick={() => setStep('create')}
            className="text-left p-6 bg-surface/50 border border-border rounded-xl hover:border-primary/50 transition-colors group"
          >
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center mb-4">
              <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-1 group-hover:text-primary transition-colors">
              Start Fresh
            </h3>
            <p className="text-sm text-foreground-muted">
              Pick your organization type — household, business, or nonprofit — and get a recommended account structure.
            </p>
          </button>

          <button
            onClick={() => setStep('import')}
            className="text-left p-6 bg-surface/50 border border-border rounded-xl hover:border-primary/50 transition-colors group"
          >
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center mb-4">
              <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-1 group-hover:text-primary transition-colors">
              Import from GnuCash
            </h3>
            <p className="text-sm text-foreground-muted">
              Upload an existing GnuCash XML file to import your accounts and transactions.
            </p>
          </button>
        </div>
      </div>
    );
  }

  if (step === 'import') {
    return (
      <div>
        <button
          onClick={() => setStep('choose')}
          className="text-sm text-foreground-muted hover:text-foreground mb-6 flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>

        <h2 className="text-2xl font-bold text-foreground mb-2">Import from GnuCash</h2>
        <p className="text-foreground-muted mb-6">
          First, create a book with a name and currency. You can then import your GnuCash data from the Import/Export page.
        </p>

        {error && (
          <div className="mb-4 p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-400 text-sm">
            {error}
          </div>
        )}

        <div className="space-y-4 max-w-md">
          <div>
            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-2">
              Book Name
            </label>
            <input
              type="text"
              value={bookName}
              onChange={e => setBookName(e.target.value)}
              className="w-full bg-input-bg border border-input-border rounded-lg px-4 py-3 text-foreground focus:outline-none focus:border-primary/50 transition-colors"
              placeholder="e.g., My Finances"
            />
          </div>

          <div>
            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-2">
              Base Currency
            </label>
            <CurrencySelect value={currency} onChange={setCurrency} />
          </div>

          <button
            onClick={handleCreateForImport}
            disabled={loading || !bookName.trim()}
            className="w-full py-3 bg-primary hover:bg-primary-hover disabled:bg-foreground-muted text-primary-foreground font-medium rounded-lg transition-all"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Creating...
              </span>
            ) : (
              'Create Book'
            )}
          </button>
        </div>
      </div>
    );
  }

  // step === 'create'
  return (
    <div>
      <button
        onClick={() => setStep('choose')}
        className="text-sm text-foreground-muted hover:text-foreground mb-6 flex items-center gap-1"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </button>

      <h2 className="text-2xl font-bold text-foreground mb-6">Create a New Book</h2>

      <div className="max-w-xl">
        <NewBookForm onSuccess={onBookCreated} />
      </div>
    </div>
  );
}
