'use client';

import { useState, useRef, useCallback } from 'react';
import { useIsMobile } from '@/lib/hooks/useIsMobile';

interface ReceiptUploadZoneProps {
  transactionGuid?: string | null;
  onUploadComplete: (results: { id: number; filename: string; status: string }[]) => void;
}

interface UploadProgress {
  filename: string;
  status: 'uploading' | 'success' | 'error';
  message?: string;
}

export function ReceiptUploadZone({ transactionGuid, onUploadComplete }: ReceiptUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    setUploads(fileArray.map(f => ({ filename: f.name, status: 'uploading' })));

    const formData = new FormData();
    if (transactionGuid) {
      formData.append('transaction_guid', transactionGuid);
    }
    for (const file of fileArray) {
      formData.append('files', file);
    }

    try {
      const response = await fetch('/api/receipts/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json();
        setUploads(fileArray.map(f => ({ filename: f.name, status: 'error', message: err.error || 'Upload failed' })));
        return;
      }

      const data = await response.json();
      setUploads(data.results.map((r: { filename: string; status: string }) => ({
        filename: r.filename,
        status: r.status === 'uploaded' ? 'success' : 'error',
        message: r.status !== 'uploaded' ? r.status : undefined,
      })));
      onUploadComplete(data.results);
    } catch {
      setUploads(fileArray.map(f => ({ filename: f.name, status: 'error', message: 'Network error' })));
    }
  }, [transactionGuid, onUploadComplete]);

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
        aria-label="Upload receipt"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
        className={`flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${
          isDragging
            ? 'border-primary bg-primary/10'
            : 'border-border hover:border-primary-hover hover:bg-surface-hover'
        }`}
      >
        <svg className="w-10 h-10 text-foreground-secondary mb-3" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
        </svg>
        <p className="text-sm text-foreground-secondary">
          {isMobile ? 'Tap to select files' : 'Drag & drop receipts here, or click to browse'}
        </p>
        <p className="text-xs text-foreground-secondary mt-1">JPEG, PNG, or PDF up to 10MB</p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && handleFiles(e.target.files)}
      />

      {isMobile && (
        <>
          <button
            onClick={() => cameraInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors text-sm font-medium min-h-[44px]"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
            </svg>
            Take Photo
          </button>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
        </>
      )}

      {uploads.length > 0 && (
        <div className="space-y-2" aria-live="polite">
          {uploads.map((upload, i) => (
            <div key={i} className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${
              upload.status === 'uploading' ? 'bg-blue-500/10 text-blue-400' :
              upload.status === 'success' ? 'bg-primary/10 text-primary' :
              'bg-red-500/10 text-red-400'
            }`}>
              {upload.status === 'uploading' && (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
              {upload.status === 'success' && '✓'}
              {upload.status === 'error' && '✕'}
              <span className="truncate">{upload.filename}</span>
              {upload.message && <span className="text-xs ml-auto">{upload.message}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
