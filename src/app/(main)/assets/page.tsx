'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import { useToast } from '@/contexts/ToastContext';

interface DepreciationScheduleInfo {
  id: number;
  method: string;
  frequency: string;
  isAppreciation: boolean;
  enabled: boolean;
  purchasePrice: number;
  salvageValue: number;
  usefulLifeYears: number;
}

interface FixedAsset {
  guid: string;
  name: string;
  accountPath: string;
  currentBalance: number;
  lastTransactionDate: string | null;
  depreciationSchedule: DepreciationScheduleInfo | null;
}

export default function AssetsPage() {
  const { error: showError } = useToast();
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAssets = useCallback(async () => {
    try {
      const res = await fetch('/api/assets/fixed');
      const data = await res.json();
      if (res.ok) {
        setAssets(data.assets || []);
      } else {
        showError(data.error || 'Failed to load fixed assets');
      }
    } catch {
      showError('Failed to load fixed assets');
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    fetchAssets();
  }, [fetchAssets]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 bg-background-tertiary rounded animate-pulse w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-48 bg-background-tertiary rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Fixed Assets</h1>
          <p className="text-foreground-muted mt-1">
            Track and manage fixed asset depreciation and appreciation
          </p>
        </div>
      </header>

      {/* Empty State */}
      {assets.length === 0 && (
        <div className="bg-background-secondary rounded-lg p-8 border border-border text-center">
          <svg className="w-12 h-12 mx-auto text-foreground-muted mb-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01" />
          </svg>
          <p className="text-foreground-secondary text-lg mb-2">No fixed asset accounts found</p>
          <p className="text-foreground-muted">
            Fixed asset accounts (ASSET type, not investment-related) will appear here once they exist in your GnuCash data.
          </p>
        </div>
      )}

      {/* Asset Cards */}
      {assets.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {assets.map((asset) => (
            <Link
              key={asset.guid}
              href={`/assets/${asset.guid}`}
              className="block bg-background-secondary rounded-lg border border-border p-5 hover:border-cyan-500/40 hover:shadow-lg hover:shadow-cyan-500/5 transition-all duration-200 group"
            >
              {/* Name & Path */}
              <div className="mb-3">
                <h3 className="text-lg font-semibold text-foreground group-hover:text-cyan-400 transition-colors">
                  {asset.name}
                </h3>
                <p className="text-sm text-foreground-muted truncate">
                  {asset.accountPath}
                </p>
              </div>

              {/* Balance */}
              <div className="mb-3">
                <p className="text-2xl font-bold text-foreground">
                  {formatCurrency(asset.currentBalance)}
                </p>
                <p className="text-xs text-foreground-muted">Current Value</p>
              </div>

              {/* Footer Info */}
              <div className="flex items-center justify-between text-sm">
                <div>
                  {asset.lastTransactionDate ? (
                    <span className="text-foreground-secondary">
                      Last activity: {asset.lastTransactionDate}
                    </span>
                  ) : (
                    <span className="text-foreground-muted">No transactions</span>
                  )}
                </div>
                <div>
                  {asset.depreciationSchedule ? (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      asset.depreciationSchedule.enabled
                        ? asset.depreciationSchedule.isAppreciation
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-amber-500/20 text-amber-400'
                        : 'bg-gray-500/20 text-gray-400'
                    }`}>
                      {asset.depreciationSchedule.isAppreciation ? 'Appreciating' : 'Depreciating'}
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/20 text-gray-400">
                      No schedule
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
