'use client';

import { useState, useRef, useCallback } from 'react';
import { ImportPreview } from '@/components/ImportPreview';

interface PreviewData {
  commodities: number;
  accounts: number;
  transactions: number;
  splits: number;
  prices: number;
  budgets: number;
}

interface ImportResult {
  commodities: number;
  accounts: number;
  transactions: number;
  splits: number;
  prices: number;
  budgets: number;
  budgetAmounts: number;
  skipped: string[];
  warnings: string[];
}

export default function ImportExportPage() {
  // Import state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Export state
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback((file: File) => {
    setSelectedFile(file);
    setPreviewData(null);
    setImportResult(null);
    setImportError(null);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handlePreview = useCallback(async () => {
    if (!selectedFile) return;

    setPreviewing(true);
    setImportError(null);

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('preview', 'true');

      const res = await fetch('/api/import', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Preview failed');
      }

      const data = await res.json();
      setPreviewData(data.counts);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  }, [selectedFile]);

  const handleImport = useCallback(async () => {
    if (!selectedFile) return;

    setImporting(true);
    setImportError(null);

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);

      const res = await fetch('/api/import', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Import failed');
      }

      const data = await res.json();
      setImportResult(data.summary);
      setPreviewData(null);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }, [selectedFile]);

  const handleCancelPreview = useCallback(() => {
    setPreviewData(null);
  }, []);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);

    try {
      const res = await fetch('/api/export');
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Export failed');
      }

      // Download the file
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disposition = res.headers.get('Content-Disposition');
      const filenameMatch = disposition?.match(/filename="(.+)"/);
      a.download = filenameMatch?.[1] || 'export.gnucash';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }, []);

  const handleReset = useCallback(() => {
    setSelectedFile(null);
    setPreviewData(null);
    setImportResult(null);
    setImportError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold text-foreground">Import / Export</h1>
        <p className="text-foreground-muted mt-1">
          Import GnuCash XML files or export your current book data.
        </p>
      </header>

      {/* Import Section */}
      <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Import</h2>
          <p className="text-sm text-foreground-secondary mt-1">
            Upload a .gnucash file (gzip-compressed XML or uncompressed XML).
          </p>
        </div>

        {/* File Drop Zone */}
        {!importResult && (
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
            className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all
              ${dragOver
                ? 'border-cyan-500 bg-cyan-500/10'
                : 'border-border hover:border-foreground-secondary hover:bg-surface/50'
              }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".gnucash,.xml,.gz"
              onChange={handleInputChange}
              className="hidden"
            />
            <div className="space-y-3">
              <div className="mx-auto w-12 h-12 rounded-full bg-surface flex items-center justify-center">
                <svg className="w-6 h-6 text-foreground-secondary" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
              </div>
              <div>
                <p className="text-foreground-secondary">
                  {selectedFile ? (
                    <span className="text-foreground font-medium">{selectedFile.name}</span>
                  ) : (
                    'Drop a .gnucash file here or click to browse'
                  )}
                </p>
                {selectedFile && (
                  <p className="text-sm text-foreground-muted mt-1">
                    {formatFileSize(selectedFile.size)}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Error Display */}
        {importError && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4 text-sm text-rose-400">
            {importError}
          </div>
        )}

        {/* Action Buttons (when file selected but no preview yet) */}
        {selectedFile && !previewData && !importResult && (
          <div className="flex gap-3">
            <button
              onClick={handlePreview}
              disabled={previewing}
              className="flex items-center gap-2 px-5 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50 text-white rounded-xl transition-colors"
            >
              {previewing ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Analyzing...
                </>
              ) : (
                'Preview Import'
              )}
            </button>
            <button
              onClick={handleReset}
              className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
            >
              Clear
            </button>
          </div>
        )}

        {/* Preview Display */}
        {previewData && (
          <ImportPreview
            counts={previewData}
            onConfirm={handleImport}
            onCancel={handleCancelPreview}
            importing={importing}
          />
        )}

        {/* Import Result */}
        {importResult && (
          <div className="space-y-4">
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4">
              <h3 className="text-emerald-400 font-semibold mb-2">Import Successful</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                  <span className="text-foreground-muted">Commodities: </span>
                  <span className="text-foreground">{importResult.commodities}</span>
                </div>
                <div>
                  <span className="text-foreground-muted">Accounts: </span>
                  <span className="text-foreground">{importResult.accounts}</span>
                </div>
                <div>
                  <span className="text-foreground-muted">Transactions: </span>
                  <span className="text-foreground">{importResult.transactions}</span>
                </div>
                <div>
                  <span className="text-foreground-muted">Splits: </span>
                  <span className="text-foreground">{importResult.splits}</span>
                </div>
                <div>
                  <span className="text-foreground-muted">Prices: </span>
                  <span className="text-foreground">{importResult.prices}</span>
                </div>
                <div>
                  <span className="text-foreground-muted">Budgets: </span>
                  <span className="text-foreground">{importResult.budgets}</span>
                </div>
                <div>
                  <span className="text-foreground-muted">Budget Amounts: </span>
                  <span className="text-foreground">{importResult.budgetAmounts}</span>
                </div>
              </div>
            </div>

            {importResult.warnings.length > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                <h4 className="text-amber-400 font-medium text-sm mb-2">
                  Warnings ({importResult.warnings.length})
                </h4>
                <ul className="text-xs text-amber-300/80 space-y-1 max-h-40 overflow-y-auto">
                  {importResult.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {importResult.skipped.length > 0 && (
              <div className="bg-surface/50 border border-border rounded-lg p-4">
                <h4 className="text-foreground-secondary font-medium text-sm mb-2">
                  Skipped ({importResult.skipped.length})
                </h4>
                <ul className="text-xs text-foreground-muted space-y-1 max-h-40 overflow-y-auto">
                  {importResult.skipped.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}

            <button
              onClick={handleReset}
              className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
            >
              Import Another File
            </button>
          </div>
        )}
      </section>

      {/* Export Section */}
      <section className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl p-6 space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Export</h2>
          <p className="text-sm text-foreground-secondary mt-1">
            Download your current book as a gzip-compressed GnuCash XML file.
          </p>
        </div>

        {exportError && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4 text-sm text-rose-400">
            {exportError}
          </div>
        )}

        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-2 px-5 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50 text-white rounded-xl transition-colors"
        >
          {exporting ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Exporting...
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12M12 16.5V3" />
              </svg>
              Export Current Book
            </>
          )}
        </button>
      </section>
    </div>
  );
}
