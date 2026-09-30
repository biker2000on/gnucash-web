'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { INPUT, LABEL } from '@/components/ui/form';
import { readErrorBody } from '@/lib/api-error';
import {
  coerceLegacyEntityType,
  describeStatus,
  describeAffectedYears,
  isMidYear,
  type EntityStatusRow,
} from '@/lib/entity-status';
import type { EntityType } from '@/lib/services/entity.service';

type Choice = 'change' | 'correct';

interface Preview {
  /** The status the change records (legal form kept when compatible). */
  status: { legalForm: EntityStatusRow['legalForm']; taxClassification: EntityStatusRow['taxClassification'] };
  affectedYears: number[];
  comparedYears: { fromYear: number; toYear: number };
  commit: () => Promise<{ currentEntityType: EntityType }>;
}

/**
 * Asked when the single-field Entity Type in the profile editor changes:
 * is this a change that took (or will take) effect on a date — a new history
 * row — or a correction of a mistake in the status in effect today, which
 * rewrites past years? Either way the affected tax years are previewed before
 * anything is written. `onApplied` receives the type in effect today
 * afterwards, which is what the profile editor then saves.
 */
export function EntityTypeChangeDialog(props: {
  isOpen: boolean;
  fromLabel: string;
  toType: EntityType;
  toLabel: string;
  onCancel: () => void;
  onApplied: (currentEntityType: EntityType) => void;
}) {
  const { isOpen, fromLabel, toType, toLabel, onCancel, onApplied } = props;
  const [choice, setChoice] = useState<Choice>('change');
  const [effectiveFrom, setEffectiveFrom] = useState(`${new Date().getFullYear() + 1}-01-01`);
  const [shortYearConfirmed, setShortYearConfirmed] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setChoice('change');
    setEffectiveFrom(`${new Date().getFullYear() + 1}-01-01`);
    setShortYearConfirmed(false);
    setPreview(null);
    setError(null);
  }, [isOpen, toType]);

  const midYear = choice === 'change' && effectiveFrom.length === 10 && isMidYear(effectiveFrom);

  const buildPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const statusRes = await fetch('/api/entity/status');
      if (!statusRes.ok) throw new Error(await readErrorBody(statusRes, 'Could not load the status history'));
      const status = (await statusRes.json()) as { current: EntityStatusRow | null };
      const current = status.current;
      const next = coerceLegacyEntityType(current, toType);

      if (choice === 'correct' && (!current || current.id === null)) {
        // Nothing persisted yet: the profile save itself is the correction.
        setPreview({
          status: next,
          affectedYears: [],
          comparedYears: { fromYear: 0, toYear: 0 },
          commit: async () => ({ currentEntityType: toType }),
        });
        return;
      }

      let request: (dryRun: boolean) => Promise<Response>;
      if (choice === 'change' || !current || current.id === null) {
        const isLlc =
          next.legalForm === 'llc_single_member' || next.legalForm === 'llc_multi_member';
        const body = {
          effectiveFrom,
          ...next,
          // S status always needs Form 2553; an LLC electing C-corp status files 8832.
          electionForm:
            next.taxClassification === 's_corp'
              ? '2553'
              : next.taxClassification === 'c_corp' && isLlc
                ? '8832'
                : null,
          shortYearConfirmed,
        };
        request = (dryRun) =>
          fetch('/api/entity/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, dryRun }),
          });
      } else {
        const classificationChanged = next.taxClassification !== current.taxClassification;
        const body = {
          ...current,
          ...next,
          ...(classificationChanged
            ? { electionForm: null, electionFiledOn: null, electionAcceptedOn: null }
            : {}),
        };
        request = (dryRun) =>
          fetch(`/api/entity/status/${current.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, dryRun }),
          });
      }

      const dry = await request(true);
      if (!dry.ok) throw new Error(await readErrorBody(dry, 'The change could not be previewed'));
      const data = (await dry.json()) as {
        affectedYears: number[];
        comparedYears: { fromYear: number; toYear: number };
      };
      setPreview({
        status: next,
        affectedYears: data.affectedYears,
        comparedYears: data.comparedYears,
        commit: async () => {
          const res = await request(false);
          if (!res.ok) throw new Error(await readErrorBody(res, 'The change could not be saved'));
          return (await res.json()) as { currentEntityType: EntityType };
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The change could not be previewed');
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const { currentEntityType } = await preview.commit();
      window.dispatchEvent(new CustomEvent('entity-status-updated'));
      onApplied(currentEntityType);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The change could not be saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onCancel} title="Change entity type" size="md">
      <div className="space-y-4 p-4">
        <p className="text-sm text-foreground">
          From <span className="font-medium">{fromLabel}</span> to{' '}
          <span className="font-medium">{toLabel}</span>. Tax years are treated by the status in
          effect for them, so tell us which kind of change this is.
        </p>

        {!preview ? (
          <>
            <fieldset className="space-y-2">
              <label className="flex items-start gap-2 rounded-md border border-border p-3 text-sm">
                <input
                  type="radio"
                  name="entity-type-change"
                  checked={choice === 'change'}
                  onChange={() => setChoice('change')}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium text-foreground">It changed on a date</span>
                  <span className="block text-foreground-muted">
                    For example, an S election effective next January 1. Earlier years keep their
                    treatment.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 rounded-md border border-border p-3 text-sm">
                <input
                  type="radio"
                  name="entity-type-change"
                  checked={choice === 'correct'}
                  onChange={() => setChoice('correct')}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium text-foreground">Correct a mistake</span>
                  <span className="block text-foreground-muted">
                    The current status was recorded wrong. This rewrites every tax year it covers.
                  </span>
                </span>
              </label>
            </fieldset>

            {choice === 'change' && (
              <label className="block">
                <span className={LABEL}>Effective from</span>
                <input
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => {
                    setEffectiveFrom(e.target.value);
                    setShortYearConfirmed(false);
                  }}
                  className={INPUT}
                />
              </label>
            )}

            {midYear && (
              <label className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={shortYearConfirmed}
                  onChange={(e) => setShortYearConfirmed(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  A mid-year date splits {effectiveFrom.slice(0, 4)} into short tax years. I will
                  confirm the filings with my tax preparer.
                </span>
              </label>
            )}
          </>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-foreground">
              {describeStatus(preview.status)}
              {choice === 'change' ? ` from ${effectiveFrom}.` : ' (correction).'}
            </p>
            <p
              className={`rounded-md border p-3 text-sm ${
                preview.affectedYears.length > 0
                  ? 'border-warning/40 bg-warning/10 text-foreground'
                  : 'border-border text-foreground-secondary'
              }`}
            >
              {describeAffectedYears(preview.affectedYears, preview.comparedYears)}
            </p>
            <p className="text-xs text-foreground-muted">
              Record the election filing and IRS acceptance in Tax Status History afterwards.
            </p>
          </div>
        )}

        {error && <p className="text-sm text-error">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={preview ? () => setPreview(null) : onCancel}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground-secondary hover:bg-surface-hover"
          >
            {preview ? 'Back' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={preview ? commit : buildPreview}
            disabled={busy || (midYear && !shortYearConfirmed)}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? 'Working…' : preview ? 'Save' : 'Preview'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
