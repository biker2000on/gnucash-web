'use client';

import { ReactNode, useState } from 'react';
import { ErrorLiveRegion } from '@/components/a11y/LiveRegion';
import BookCreateForm from '@/components/books/BookCreateForm';
import NewBookForm from '@/components/books/NewBookForm';
import { product } from '@/lib/product';
import { extractErrorMessage } from '@/lib/api-error';

interface CreateBookWizardProps {
  onBookCreated: (bookGuid: string) => void;
  isOnboarding?: boolean;
}

export function CreateBookWizard({ onBookCreated, isOnboarding = false }: CreateBookWizardProps) {
  const [step, setStep] = useState<'choose' | 'create' | 'import' | 'demo'>('choose');
  const [error, setError] = useState<string | null>(null);
  const [demoCreating, setDemoCreating] = useState<'household' | 'business' | null>(null);

  const handleCreateDemo = async (kind: 'household' | 'business') => {
    if (demoCreating) return;
    setDemoCreating(kind);
    setError(null);
    try {
      const res = await fetch('/api/books/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(extractErrorMessage(data, 'Failed to create demo book'));
      onBookCreated(data.bookGuid);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setDemoCreating(null);
    }
  };

  // The import step creates an empty book to import into; the name field, its
  // validation and the submit state come from the shared BookCreateForm, the
  // same component the "Start Fresh" step reaches through NewBookForm.
  const handleCreateForImport = async ({ name, currency }: { name: string; currency: string }) => {
    const res = await fetch('/api/books/from-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, currency }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(extractErrorMessage(data, 'Failed to create book'));
    }

    const data = await res.json();
    onBookCreated(data.guid);
  };

  // One live region for the whole wizard, not one per step. `error` survives a
  // step change, so a step-local region would remount already holding the
  // previous step's failure — a node that enters the tree with its text is the
  // announcement this component exists to avoid. Because every branch below
  // returns through `withLiveRegion`, the region occupies the same slot in
  // every render and React reconciles it rather than remounting it. A new
  // branch that returns bare JSX would break that; the test in
  // src/components/__tests__/error-live-regions.test.tsx pins it.
  const withLiveRegion = (stepContent: ReactNode) => (
    <>
      <ErrorLiveRegion message={error} />
      {stepContent}
    </>
  );

  if (step === 'choose') {
    return withLiveRegion(
      <div>
        {isOnboarding && (
          <div className="text-center mb-10">
            <h1 className="text-3xl font-bold text-foreground mb-2">Welcome to {product.brand}</h1>
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

        <div className="mt-6 text-center">
          <button
            onClick={() => setStep('demo')}
            className="text-sm text-foreground-muted hover:text-primary transition-colors underline underline-offset-2"
          >
            Or try a demo book with sample data
          </button>
        </div>
      </div>
    );
  }

  if (step === 'demo') {
    return withLiveRegion(
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

        <h2 className="text-2xl font-bold text-foreground mb-2">Try a Demo Book</h2>
        <p className="text-foreground-muted mb-6">
          Creates a book pre-filled with about a year of realistic sample data so you can
          explore accounts, reports, and tools. You can delete it at any time.
        </p>

        {error && (
          <div className="mb-4 p-3 bg-negative/10 border border-negative/30 rounded-lg text-negative text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <button
            onClick={() => void handleCreateDemo('household')}
            disabled={demoCreating !== null}
            className="text-left p-6 bg-surface/50 border border-border rounded-xl hover:border-primary/50 transition-colors group disabled:opacity-60"
          >
            <h3 className="text-lg font-semibold text-foreground mb-1 group-hover:text-primary transition-colors">
              {demoCreating === 'household' ? 'Creating…' : 'Demo Household'}
            </h3>
            <p className="text-sm text-foreground-muted">
              Paychecks with tax withholding and 401(k), rent, groceries, utilities,
              subscriptions, monthly investing, and a savings habit.
            </p>
          </button>

          <button
            onClick={() => void handleCreateDemo('business')}
            disabled={demoCreating !== null}
            className="text-left p-6 bg-surface/50 border border-border rounded-xl hover:border-primary/50 transition-colors group disabled:opacity-60"
          >
            <h3 className="text-lg font-semibold text-foreground mb-1 group-hover:text-primary transition-colors">
              {demoCreating === 'business' ? 'Creating…' : 'Demo Business'}
            </h3>
            <p className="text-sm text-foreground-muted">
              A single-member consulting LLC: monthly client invoices and payments,
              recurring expenses, owner draws, and tax-mapped categories.
            </p>
          </button>
        </div>
      </div>
    );
  }

  if (step === 'import') {
    return withLiveRegion(
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
          <div className="mb-4 p-3 bg-negative/10 border border-negative/30 rounded-lg text-negative text-sm">
            {error}
          </div>
        )}

        <div className="max-w-md">
          <BookCreateForm
            onSubmit={handleCreateForImport}
            onError={setError}
            nameInputId="import-book-name"
            namePlaceholder="e.g. My Finances"
            submitLabel="Create Book"
            submitFullWidth
          />
        </div>
      </div>
    );
  }

  // step === 'create'
  return withLiveRegion(
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
