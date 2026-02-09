'use client';

import { useState, useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';
import { SavedReport, SavedReportInput, ReportType, ReportFilters } from '@/lib/reports/types';

interface SaveReportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (input: SavedReportInput) => Promise<void>;
  baseReportType: ReportType;
  existingReport?: SavedReport | null;
  currentConfig: Record<string, unknown>;
  currentFilters?: ReportFilters;
}

export default function SaveReportDialog({
  isOpen,
  onClose,
  onSave,
  baseReportType,
  existingReport,
  currentConfig,
  currentFilters,
}: SaveReportDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isStarred, setIsStarred] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isEditMode = !!existingReport;

  useEffect(() => {
    if (isOpen) {
      if (existingReport) {
        setName(existingReport.name);
        setDescription(existingReport.description || '');
        setIsStarred(existingReport.isStarred);
      } else {
        setName('');
        setDescription('');
        setIsStarred(false);
      }
      setError('');
    }
  }, [isOpen, existingReport]);

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    setError('');
    setLoading(true);

    try {
      const input: SavedReportInput = {
        baseReportType,
        name: name.trim(),
        description: description.trim() || undefined,
        config: currentConfig,
        filters: currentFilters,
        isStarred,
      };

      await onSave(input);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save report');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditMode ? 'Update Report Configuration' : 'Save Report Configuration'}
      size="md"
    >
      <div className="p-6 space-y-4">
        <div>
          <label htmlFor="report-name" className="block text-sm font-medium text-foreground mb-1.5">
            Name <span className="text-red-400">*</span>
          </label>
          <input
            id="report-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={255}
            className="w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-foreground placeholder-foreground-tertiary focus:outline-none focus:ring-2 focus:ring-cyan-500"
            placeholder="Report name"
            disabled={loading}
          />
        </div>

        <div>
          <label htmlFor="report-description" className="block text-sm font-medium text-foreground mb-1.5">
            Description
          </label>
          <textarea
            id="report-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 bg-input-bg border border-border rounded-lg text-foreground placeholder-foreground-tertiary focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"
            placeholder="Optional description"
            disabled={loading}
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            id="report-starred"
            type="checkbox"
            checked={isStarred}
            onChange={(e) => setIsStarred(e.target.checked)}
            className="w-4 h-4 rounded border-border bg-input-bg text-cyan-600 focus:ring-cyan-500 focus:ring-2"
            disabled={loading}
          />
          <label htmlFor="report-starred" className="text-sm text-foreground">
            Star this report
          </label>
        </div>

        {error && (
          <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="flex-1 px-4 py-2 text-sm font-medium text-foreground-secondary bg-surface-hover rounded-lg hover:bg-surface-hover/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="flex-1 px-4 py-2 text-sm font-medium text-white bg-cyan-600 rounded-lg hover:bg-cyan-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
