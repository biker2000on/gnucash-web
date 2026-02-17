'use client';

import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';
import {
  getAvailableTemplates,
  type TemplateLocale,
  type TemplateFile,
  type AccountTemplate,
  flattenTemplate,
} from '@/lib/account-templates';

interface NewBookWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (bookGuid: string) => void;
}

interface Currency {
  guid: string;
  mnemonic: string;
  fullname: string;
}

const STEPS = ['Name & Currency', 'Template', 'Confirm'];

const localeCurrencyMap: Record<string, string> = {
  en_US: 'USD',
  en_GB: 'GBP',
};

// ---------------------------------------------------------------------------
// Step Indicator
// ---------------------------------------------------------------------------

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex items-center justify-center gap-2 px-6 py-4 border-b border-border">
      {STEPS.map((label, index) => {
        const isActive = index === currentStep;
        const isCompleted = index < currentStep;
        return (
          <div key={label} className="flex items-center gap-2">
            {index > 0 && (
              <div
                className={`h-px w-8 transition-colors ${
                  isCompleted ? 'bg-cyan-500' : 'bg-border'
                }`}
              />
            )}
            <div className="flex items-center gap-2">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                  isActive
                    ? 'bg-cyan-600 text-white'
                    : isCompleted
                      ? 'bg-cyan-600/30 text-cyan-400'
                      : 'bg-surface-hover text-foreground-tertiary'
                }`}
              >
                {isCompleted ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  index + 1
                )}
              </div>
              <span
                className={`text-xs font-medium hidden sm:inline ${
                  isActive
                    ? 'text-foreground'
                    : isCompleted
                      ? 'text-foreground-secondary'
                      : 'text-foreground-tertiary'
                }`}
              >
                {label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account Tree Preview
// ---------------------------------------------------------------------------

function AccountTreeNode({ account, depth = 0 }: { account: AccountTemplate; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = account.children && account.children.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-1.5 py-0.5 cursor-default hover:bg-surface-hover/50 rounded px-1"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-4 h-4 flex items-center justify-center text-foreground-tertiary hover:text-foreground transition-colors shrink-0"
          >
            <svg
              className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <span className="w-4 h-4 shrink-0" />
        )}
        <span className={`text-xs ${account.placeholder ? 'text-foreground-secondary font-medium' : 'text-foreground'}`}>
          {account.name}
        </span>
        <span className="text-[10px] text-foreground-tertiary ml-auto pr-1">
          {account.type}
        </span>
      </div>
      {expanded && hasChildren && account.children!.map((child) => (
        <AccountTreeNode key={child.name} account={child} depth={depth + 1} />
      ))}
    </div>
  );
}

function AccountTreePreview({ accounts }: { accounts: AccountTemplate[] }) {
  if (accounts.length === 0) {
    return (
      <div className="text-sm text-foreground-tertiary italic py-4 text-center">
        No template selected. Standard top-level accounts (Assets, Liabilities, Income, Expenses, Equity) will be created.
      </div>
    );
  }

  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-input-bg p-2">
      {accounts.map((account) => (
        <AccountTreeNode key={account.name} account={account} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Wizard
// ---------------------------------------------------------------------------

export default function NewBookWizard({ isOpen, onClose, onSuccess }: NewBookWizardProps) {
  const [step, setStep] = useState(0);

  // Step 1 state
  const [bookName, setBookName] = useState('');
  const [bookDescription, setBookDescription] = useState('');
  const [selectedCurrency, setSelectedCurrency] = useState('USD');
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loadingCurrencies, setLoadingCurrencies] = useState(false);

  // Step 2 state
  const [locales] = useState<TemplateLocale[]>(() => getAvailableTemplates());
  const [selectedLocale, setSelectedLocale] = useState('en_US');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>('personal');

  // Step 3 / submission
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // Fetch currencies from API
  const fetchCurrencies = useCallback(async () => {
    setLoadingCurrencies(true);
    try {
      const res = await fetch('/api/commodities?type=CURRENCY');
      if (res.ok) {
        const data: Currency[] = await res.json();
        setCurrencies(data);
      }
    } catch {
      // Currencies will remain empty; user can still type
    } finally {
      setLoadingCurrencies(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchCurrencies();
    }
  }, [isOpen, fetchCurrencies]);

  // Reset state when wizard opens
  useEffect(() => {
    if (isOpen) {
      setStep(0);
      setBookName('');
      setBookDescription('');
      setSelectedCurrency('USD');
      setSelectedLocale('en_US');
      setSelectedTemplateId('personal');
      setCreating(false);
      setError('');
    }
  }, [isOpen]);

  // Auto-update currency when locale changes
  useEffect(() => {
    const mapped = localeCurrencyMap[selectedLocale];
    if (mapped) {
      setSelectedCurrency(mapped);
    }
  }, [selectedLocale]);

  const selectedLocaleData = locales.find(l => l.code === selectedLocale);
  const selectedTemplate: TemplateFile | null =
    selectedLocaleData?.templates.find(t => t.id === selectedTemplateId) ?? null;

  const totalAccounts = selectedTemplate
    ? flattenTemplate(selectedTemplate.accounts).length
    : 5;

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  const canGoNext = (): boolean => {
    if (step === 0) {
      return bookName.trim().length > 0 && selectedCurrency.length > 0;
    }
    return true;
  };

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      setError('');
    }
  };

  const handleBack = () => {
    if (step > 0) {
      setStep(step - 1);
      setError('');
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/books/from-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: bookName.trim(),
          description: bookDescription.trim() || undefined,
          currency: selectedCurrency,
          locale: selectedTemplateId ? selectedLocale : undefined,
          templateId: selectedTemplateId || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Failed to create book');
        return;
      }

      const data = await res.json();
      onSuccess(data.guid);
    } catch {
      setError('Failed to create book. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render Steps
  // ---------------------------------------------------------------------------

  const renderStep0 = () => (
    <div className="p-6 space-y-5">
      <div>
        <label htmlFor="wizard-book-name" className="block text-sm font-medium text-foreground mb-1.5">
          Book Name <span className="text-red-400">*</span>
        </label>
        <input
          id="wizard-book-name"
          type="text"
          value={bookName}
          onChange={(e) => setBookName(e.target.value)}
          className="w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-foreground placeholder-foreground-tertiary focus:outline-none focus:ring-2 focus:ring-cyan-500"
          placeholder="e.g. My Finances"
          autoFocus
        />
      </div>

      <div>
        <label htmlFor="wizard-book-desc" className="block text-sm font-medium text-foreground mb-1.5">
          Description
        </label>
        <textarea
          id="wizard-book-desc"
          value={bookDescription}
          onChange={(e) => setBookDescription(e.target.value)}
          rows={3}
          className="w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-foreground placeholder-foreground-tertiary focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"
          placeholder="Optional description for this book"
        />
      </div>

      <div>
        <label htmlFor="wizard-currency" className="block text-sm font-medium text-foreground mb-1.5">
          Default Currency <span className="text-red-400">*</span>
        </label>
        {loadingCurrencies ? (
          <div className="flex items-center gap-2 text-sm text-foreground-tertiary py-2">
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Loading currencies...
          </div>
        ) : (
          <select
            id="wizard-currency"
            value={selectedCurrency}
            onChange={(e) => setSelectedCurrency(e.target.value)}
            className="w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500"
          >
            {currencies.length === 0 ? (
              <option value="USD">USD - US Dollar</option>
            ) : (
              currencies.map((c) => (
                <option key={c.guid} value={c.mnemonic}>
                  {c.mnemonic} - {c.fullname}
                </option>
              ))
            )}
          </select>
        )}
      </div>
    </div>
  );

  const renderStep1 = () => (
    <div className="p-6 space-y-5">
      <div>
        <label htmlFor="wizard-locale" className="block text-sm font-medium text-foreground mb-1.5">
          Locale
        </label>
        <select
          id="wizard-locale"
          value={selectedLocale}
          onChange={(e) => {
            setSelectedLocale(e.target.value);
            // Reset template to first available for new locale, or null
            const newLocale = locales.find(l => l.code === e.target.value);
            setSelectedTemplateId(newLocale?.templates[0]?.id ?? null);
          }}
          className="w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500"
        >
          {locales.map((loc) => (
            <option key={loc.code} value={loc.code}>
              {loc.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-2">
          Account Template
        </label>
        <div className="space-y-2">
          {/* No template option */}
          <label
            className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              selectedTemplateId === null
                ? 'border-cyan-500/50 bg-cyan-500/5'
                : 'border-border hover:border-border hover:bg-surface-hover/50'
            }`}
          >
            <input
              type="radio"
              name="template"
              checked={selectedTemplateId === null}
              onChange={() => setSelectedTemplateId(null)}
              className="mt-0.5 accent-cyan-500"
            />
            <div>
              <div className="text-sm font-medium text-foreground">No Template</div>
              <div className="text-xs text-foreground-tertiary mt-0.5">
                Create an empty book with only top-level account categories.
              </div>
            </div>
          </label>

          {/* Template options */}
          {selectedLocaleData?.templates.map((tmpl) => (
            <label
              key={tmpl.id}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                selectedTemplateId === tmpl.id
                  ? 'border-cyan-500/50 bg-cyan-500/5'
                  : 'border-border hover:border-border hover:bg-surface-hover/50'
              }`}
            >
              <input
                type="radio"
                name="template"
                checked={selectedTemplateId === tmpl.id}
                onChange={() => setSelectedTemplateId(tmpl.id)}
                className="mt-0.5 accent-cyan-500"
              />
              <div>
                <div className="text-sm font-medium text-foreground">{tmpl.name}</div>
                <div className="text-xs text-foreground-tertiary mt-0.5">{tmpl.description}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Tree preview */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">
          Account Preview
        </label>
        <AccountTreePreview accounts={selectedTemplate?.accounts ?? []} />
      </div>
    </div>
  );

  const renderStep2 = () => (
    <div className="p-6 space-y-5">
      <h3 className="text-sm font-semibold text-foreground-secondary uppercase tracking-wider">
        Review Your New Book
      </h3>

      <div className="space-y-3">
        <div className="flex items-center justify-between py-2 border-b border-border/50">
          <span className="text-sm text-foreground-secondary">Name</span>
          <span className="text-sm font-medium text-foreground">{bookName.trim()}</span>
        </div>

        {bookDescription.trim() && (
          <div className="flex items-start justify-between py-2 border-b border-border/50">
            <span className="text-sm text-foreground-secondary">Description</span>
            <span className="text-sm text-foreground max-w-[60%] text-right">{bookDescription.trim()}</span>
          </div>
        )}

        <div className="flex items-center justify-between py-2 border-b border-border/50">
          <span className="text-sm text-foreground-secondary">Currency</span>
          <span className="text-sm font-medium text-foreground">{selectedCurrency}</span>
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border/50">
          <span className="text-sm text-foreground-secondary">Template</span>
          <span className="text-sm font-medium text-foreground">
            {selectedTemplate ? selectedTemplate.name : 'None (empty book)'}
          </span>
        </div>

        <div className="flex items-center justify-between py-2 border-b border-border/50">
          <span className="text-sm text-foreground-secondary">Accounts</span>
          <span className="text-sm font-medium text-foreground">
            {totalAccounts} account{totalAccounts !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {selectedTemplate && (
        <div>
          <label className="block text-sm font-medium text-foreground-secondary mb-1.5">
            Account Structure
          </label>
          <AccountTreePreview accounts={selectedTemplate.accounts} />
        </div>
      )}
    </div>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Book" size="2xl" closeOnBackdrop={!creating}>
      <StepIndicator currentStep={step} />

      {/* Step content */}
      {step === 0 && renderStep0()}
      {step === 1 && renderStep1()}
      {step === 2 && renderStep2()}

      {/* Error */}
      {error && (
        <div className="mx-6 mb-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Navigation buttons */}
      <div className="flex items-center justify-between px-6 py-4 border-t border-border">
        <button
          onClick={step === 0 ? onClose : handleBack}
          disabled={creating}
          className="px-4 py-2 text-sm font-medium text-foreground-secondary bg-surface-hover rounded-lg hover:bg-surface-hover/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {step === 0 ? 'Cancel' : 'Back'}
        </button>

        {step < STEPS.length - 1 ? (
          <button
            onClick={handleNext}
            disabled={!canGoNext()}
            className="px-5 py-2 text-sm font-medium text-white bg-cyan-600 rounded-lg hover:bg-cyan-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Next
          </button>
        ) : (
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-5 py-2 text-sm font-medium text-white bg-cyan-600 rounded-lg hover:bg-cyan-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {creating ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Creating...
              </>
            ) : (
              'Create Book'
            )}
          </button>
        )}
      </div>
    </Modal>
  );
}
