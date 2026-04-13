'use client';

import { useState, useRef, useCallback } from 'react';

interface PayslipUploadZoneProps {
  onUploadComplete?: (results: Array<{ id: number; filename: string; status: string }>) => void;
}

interface UploadProgress {
  filename: string;
  status: 'uploading' | 'success' | 'error';
  message?: string;
}

export function PayslipUploadZone({ onUploadComplete }: PayslipUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    setUploads(fileArray.map(f => ({ filename: f.name, status: 'uploading' })));

    const formData = new FormData();
    for (const file of fileArray) {
      formData.append('files', file);
    }

    try {
      const response = await fetch('/api/payslips/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json();
        setUploads(fileArray.map(f => ({
          filename: f.name,
          status: 'error' as const,
          message: err.error || 'Upload failed',
        })));
        return;
      }

      const data = await response.json();
      setUploads(data.results.map((r: { filename: string; status: string }) => ({
        filename: r.filename,
        status: r.status === 'uploaded' ? 'success' : 'error',
        message: r.status !== 'uploaded' ? r.status : undefined,
      })));
      onUploadComplete?.(data.results);
    } catch {
      setUploads(fileArray.map(f => ({
        filename: f.name,
        status: 'error' as const,
        message: 'Network error',
      })));
    }
  }, [onUploadComplete]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  return (
    <div className="space-y-3">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        aria-label="Upload payslip PDF"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
        className={`flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${
          isDragging
            ? 'border-primary bg-primary/10'
            : 'border-border hover:border-primary hover:bg-surface-hover'
        }`}
      >
        <svg className="w-10 h-10 text-foreground-muted mb-3" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
        <p className="text-sm text-foreground-muted">
          Drag &amp; drop payslip PDFs here, or click to browse
        </p>
        <p className="text-xs text-foreground-muted mt-1">PDF files only</p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && handleFiles(e.target.files)}
      />

      {uploads.length > 0 && (
        <div className="space-y-2" aria-live="polite">
          {uploads.map((upload, i) => (
            <div
              key={i}
              className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${
                upload.status === 'uploading' ? 'bg-blue-500/10 text-blue-400' :
                upload.status === 'success' ? 'bg-primary/10 text-primary' :
                'bg-red-500/10 text-red-400'
              }`}
            >
              {upload.status === 'uploading' && (
                <svg className="w-4 h-4 animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
              {upload.status === 'success' && <span className="flex-shrink-0">✓</span>}
              {upload.status === 'error' && <span className="flex-shrink-0">✕</span>}
              <span className="truncate">{upload.filename}</span>
              {upload.message && <span className="text-xs ml-auto flex-shrink-0">{upload.message}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
