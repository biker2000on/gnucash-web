'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { useBooks } from '@/contexts/BookContext';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';
import { Modal } from '@/components/ui/Modal';
import { Abbr } from '@/components/ui/Abbr';
import { INPUT, LABEL, SELECT, TEXTAREA, TNUM } from '@/components/ui/form';
import { readErrorBody } from '@/lib/api-error';
import {
  ELECTION_FORM_LABELS,
  LEGAL_FORMS,
  LEGAL_FORM_LABELS,
  TAX_CLASSIFICATION_LABELS,
  VALID_CLASSIFICATIONS,
  describeStatus,
  describeAffectedYears,
  isInceptionDate,
  isMidYear,
  type ElectionForm,
  type EntityStatusRow,
  type LegalForm,
  type TaxClassification,
} from '@/lib/entity-status';

/** Row as returned by /api/entity/status (EntityStatusRowView). */
export interface EntityStatusRowView extends EntityStatusRow {
  entityType: string;
  effectiveTo: string | null;
  sinceInception: boolean;
  future: boolean;
  awaitingAcceptance: boolean;
  planned: boolean;
}

interface StatusPayload {
  today: string;
  synthesized: boolean;
  history: EntityStatusRowView[];
  current: EntityStatusRowView | null;
}

interface VaultDocument {
  id: number;
  title: string | null;
  filename: string;
}

/** Editor state: dates and ids as raw input strings. */
interface DraftRow {
  effectiveFrom: string;
  legalForm: LegalForm;
  taxClassification: TaxClassification;
  electionForm: '' | ElectionForm;
  electionFiledOn: string;
  electionAcceptedOn: string;
  electionDocumentId: string;
  acceptanceDocumentId: string;
  shortYearConfirmed: boolean;
  notes: string;
}

type EditorMode = { kind: 'change' } | { kind: 'correct'; id: number };

interface PendingMutation {
  title: string;
  message: string;
  affectedYears: number[];
  comparedYears: { fromYear: number; toYear: number };
  confirmLabel: string;
  run: () => Promise<Response>;
}

function draftFrom(row: EntityStatusRow | null, today: string): DraftRow {
  return {
    effectiveFrom: row ? row.effectiveFrom : `${Number(today.slice(0, 4)) + 1}-01-01`,
    legalForm: row?.legalForm ?? 'llc_single_member',
    taxClassification: row?.taxClassification ?? 'disregarded',
    electionForm: row?.electionForm ?? '',
    electionFiledOn: row?.electionFiledOn ?? '',
    electionAcceptedOn: row?.electionAcceptedOn ?? '',
    electionDocumentId: row?.electionDocumentId != null ? String(row.electionDocumentId) : '',
    acceptanceDocumentId: row?.acceptanceDocumentId != null ? String(row.acceptanceDocumentId) : '',
    shortYearConfirmed: row?.shortYearConfirmed ?? false,
    notes: row?.notes ?? '',
  };
}

/** A new change starts from today's status, effective next January 1. */
function newChangeDraft(payload: StatusPayload): DraftRow {
  return {
    ...draftFrom(null, payload.today),
    legalForm: payload.current?.legalForm ?? 'llc_single_member',
    taxClassification: payload.current?.taxClassification ?? 'disregarded',
  };
}

function bodyFrom(draft: DraftRow, dryRun: boolean) {
  return {
    effectiveFrom: draft.effectiveFrom,
    legalForm: draft.legalForm,
    taxClassification: draft.taxClassification,
    electionForm: draft.electionForm || null,
    electionFiledOn: draft.electionForm ? draft.electionFiledOn || null : null,
    electionAcceptedOn: draft.electionForm ? draft.electionAcceptedOn || null : null,
    electionDocumentId: draft.electionDocumentId ? Number(draft.electionDocumentId) : null,
    acceptanceDocumentId: draft.acceptanceDocumentId ? Number(draft.acceptanceDocumentId) : null,
    shortYearConfirmed: draft.shortYearConfirmed,
    notes: draft.notes.trim() || null,
    dryRun,
  };
}

function periodLabel(row: EntityStatusRowView): string {
  const from = isInceptionDate(row.effectiveFrom) ? 'Since inception' : row.effectiveFrom;
  return row.effectiveTo ? `${from} → ${row.effectiveTo}` : `${from} → present`;
}


/** Summary line for the collapsed section header. */
export function entityStatusSummary(payload: StatusPayload | null): string | undefined {
  if (!payload?.current) return undefined;
  const upcoming = payload.history.find((r) => r.future);
  const base = describeStatus(payload.current);
  return upcoming ? `${base} · change planned ${upcoming.effectiveFrom}` : base;
}

/**
 * "Tax status history" — the effective-dated legal form and federal tax
 * classification of the active book (src/lib/entity-status.ts). Records a
 * change effective on a date (e.g. a planned S election), corrects or removes
 * a row with a preview of the tax years whose treatment changes, and links
 * the election and IRS acceptance letter from the Document Vault.
 */
export function EntityStatusSection({ onChanged }: { onChanged?: () => void }) {
  const { success, error: showError } = useToast();
  const { books, activeBookGuid } = useBooks();
  const role = books.find((b) => b.guid === activeBookGuid)?.role;
  const canEdit = role === 'edit' || role === 'admin';

  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [documents, setDocuments] = useState<VaultDocument[]>([]);
  const [editor, setEditor] = useState<{ mode: EditorMode; draft: DraftRow } | null>(null);
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/entity/status');
      if (res.ok) setPayload(await res.json());
    } catch (err) {
      console.error('Failed to load entity status history:', err);
    }
  }, []);

  useEffect(() => {
    load();
    const onUpdated = () => load();
    window.addEventListener('entity-updated', onUpdated);
    return () => window.removeEventListener('entity-updated', onUpdated);
  }, [load, activeBookGuid]);

  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    fetch('/api/documents?limit=200')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && Array.isArray(data.documents)) setDocuments(data.documents);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [editor]);

  const documentName = useMemo(() => {
    const map = new Map(documents.map((d) => [d.id, d.title || d.filename]));
    return (id: number | null) => (id == null ? null : map.get(id) ?? `Document #${id}`);
  }, [documents]);

  const afterMutation = useCallback(
    async (message: string) => {
      success(message);
      setPending(null);
      setEditor(null);
      await load();
      onChanged?.();
      window.dispatchEvent(new CustomEvent('entity-status-updated'));
    },
    [load, onChanged, success]
  );

  /** Dry-run first, then ask for confirmation with the affected years. */
  const preview = async (
    request: (dryRun: boolean) => Promise<Response>,
    copy: { title: string; message: string; confirmLabel: string; done: string }
  ) => {
    setBusy(true);
    try {
      const res = await request(true);
      if (!res.ok) throw new Error(await readErrorBody(res, 'The change could not be previewed'));
      const data = (await res.json()) as {
        affectedYears: number[];
        comparedYears: { fromYear: number; toYear: number };
      };
      setPending({
        title: copy.title,
        message: copy.message,
        affectedYears: data.affectedYears,
        comparedYears: data.comparedYears,
        confirmLabel: copy.confirmLabel,
        run: async () => {
          const committed = await request(false);
          if (committed.ok) await afterMutation(copy.done);
          return committed;
        },
      });
    } catch (e) {
      showError(e instanceof Error ? e.message : 'The change could not be previewed');
    } finally {
      setBusy(false);
    }
  };

  const submitEditor = () => {
    if (!editor) return;
    const { mode, draft } = editor;
    if (mode.kind === 'change') {
      preview(
        (dryRun) =>
          fetch('/api/entity/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyFrom(draft, dryRun)),
          }),
        {
          title: 'Record status change',
          message: `From ${draft.effectiveFrom} the entity will be ${describeStatus(draft)}. Earlier dates keep their current treatment.`,
          confirmLabel: 'Record change',
          done: 'Status change recorded',
        }
      );
    } else {
      preview(
        (dryRun) =>
          fetch(`/api/entity/status/${mode.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyFrom(draft, dryRun)),
          }),
        {
          title: 'Correct history',
          message:
            'A correction rewrites how past tax years are treated. Use it to fix a mistake, not to record a change that happened on a date.',
          confirmLabel: 'Save correction',
          done: 'Status history corrected',
        }
      );
    }
  };

  const removeRow = (row: EntityStatusRowView) => {
    preview(
      (dryRun) =>
        fetch(`/api/entity/status/${row.id}${dryRun ? '?dryRun=1' : ''}`, { method: 'DELETE' }),
      {
        title: 'Remove status row',
        message: `Remove "${describeStatus(row)}" effective ${periodLabel(row)}. The previous status then continues through that period.`,
        confirmLabel: 'Remove',
        done: 'Status row removed',
      }
    );
  };

  const confirmPending = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await pending.run();
      if (!res.ok) throw new Error(await readErrorBody(res, 'The change could not be saved'));
    } catch (e) {
      showError(e instanceof Error ? e.message : 'The change could not be saved');
    } finally {
      setBusy(false);
    }
  };

  const setDraft = (patch: Partial<DraftRow>) =>
    setEditor((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));

  const history = payload?.history ?? [];
  const draft = editor?.draft ?? null;
  const allowedClassifications = draft ? VALID_CLASSIFICATIONS[draft.legalForm] : [];
  const editingInception =
    editor?.mode.kind === 'correct' &&
    history.find((r) => r.id === (editor.mode as { id: number }).id)?.sinceInception === true;
  const showShortYear =
    draft !== null && !editingInception && draft.effectiveFrom.length === 10 && isMidYear(draft.effectiveFrom);

  return (
    <div id="entity-status" className="scroll-mt-20">
      <CollapsibleConfigSection
        title="Tax Status History"
        summary={entityStatusSummary(payload)}
        configured
        storageKey="settings.entityStatusOpen"
      >
        {!payload ? (
          <p className="py-2 text-sm text-foreground-secondary">Loading tax status history...</p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-foreground-muted">
              How this entity is organized and taxed, by date. Tax reports, deadlines, and the
              household return use the status in effect for each tax year, so an election that
              takes effect next January does not change this year. Record elections such as an{' '}
              <Abbr term="LLC" /> choosing S-corporation status here.
            </p>

            <ol className="divide-y divide-border rounded-md border border-border">
              {history.map((row) => (
                <li key={row.id ?? 'synthesized'} className="flex flex-wrap items-start gap-3 p-3">
                  <div className="min-w-[13rem] font-mono text-xs text-foreground-secondary" style={TNUM}>
                    {periodLabel(row)}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{describeStatus(row)}</span>
                      {payload.current?.effectiveFrom === row.effectiveFrom && (
                        <span className="rounded-sm border border-primary/40 bg-primary-light px-1.5 py-0.5 text-[11px] font-medium text-primary">
                          Current
                        </span>
                      )}
                      {row.future && (
                        <span className="rounded-sm border border-secondary/40 bg-secondary-light px-1.5 py-0.5 text-[11px] font-medium text-secondary">
                          Planned
                        </span>
                      )}
                      {row.awaitingAcceptance && (
                        <span className="rounded-sm border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                          {row.electionFiledOn ? 'Awaiting IRS acceptance' : 'Election not filed'}
                        </span>
                      )}
                    </div>
                    {row.electionForm && (
                      <p className="text-xs text-foreground-secondary">
                        {ELECTION_FORM_LABELS[row.electionForm]}
                        {' · '}filed {row.electionFiledOn ?? '—'}
                        {' · '}accepted {row.electionAcceptedOn ?? '—'}
                      </p>
                    )}
                    {(row.electionDocumentId != null || row.acceptanceDocumentId != null) && (
                      <p className="flex flex-wrap gap-3 text-xs">
                        {row.electionDocumentId != null && (
                          <a
                            href={`/api/business/documents/${row.electionDocumentId}/download`}
                            className="text-primary hover:underline"
                          >
                            Election filing
                          </a>
                        )}
                        {row.acceptanceDocumentId != null && (
                          <a
                            href={`/api/business/documents/${row.acceptanceDocumentId}/download`}
                            className="text-primary hover:underline"
                          >
                            Acceptance letter
                          </a>
                        )}
                      </p>
                    )}
                    {row.notes && <p className="text-xs text-foreground-muted">{row.notes}</p>}
                  </div>
                  {canEdit && row.id !== null && (
                    <div className="flex gap-3 text-xs">
                      <button
                        type="button"
                        className="text-foreground-secondary hover:text-foreground"
                        onClick={() =>
                          setEditor({
                            mode: { kind: 'correct', id: row.id! },
                            draft: draftFrom(row, payload.today),
                          })
                        }
                        disabled={busy}
                      >
                        Correct
                      </button>
                      {history.length > 1 && (
                        <button
                          type="button"
                          className="text-foreground-muted hover:text-error"
                          onClick={() => removeRow(row)}
                          disabled={busy}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>

            {canEdit && (
              <button
                type="button"
                onClick={() => setEditor({ mode: { kind: 'change' }, draft: newChangeDraft(payload) })}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-surface-hover"
              >
                Record a status change…
              </button>
            )}
          </div>
        )}
      </CollapsibleConfigSection>

      <Modal
        isOpen={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.mode.kind === 'correct' ? 'Correct status row' : 'Record a status change'}
        size="lg"
      >
        {draft && editor && (
          <form
            className="space-y-4 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              submitEditor();
            }}
          >
            <p className="text-sm text-foreground-muted">
              {editor.mode.kind === 'correct'
                ? 'Correct a mistake in this row. This rewrites history for every tax year it covers; you will see which years change before anything is saved.'
                : 'Record a change that takes effect on a date, such as an S election effective January 1. Earlier years keep their treatment.'}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={LABEL}>Effective from</span>
                {editingInception ? (
                  <span className="block py-2 text-sm text-foreground-secondary">Since inception</span>
                ) : (
                  <input
                    type="date"
                    required
                    value={draft.effectiveFrom}
                    onChange={(e) => setDraft({ effectiveFrom: e.target.value, shortYearConfirmed: false })}
                    className={INPUT}
                  />
                )}
              </label>
              <label className="block">
                <span className={LABEL}>Legal form</span>
                <select
                  value={draft.legalForm}
                  onChange={(e) => {
                    const legalForm = e.target.value as LegalForm;
                    const allowed = VALID_CLASSIFICATIONS[legalForm];
                    setDraft({
                      legalForm,
                      taxClassification: allowed.includes(draft.taxClassification)
                        ? draft.taxClassification
                        : allowed[0],
                    });
                  }}
                  className={SELECT}
                >
                  {LEGAL_FORMS.map((form) => (
                    <option key={form} value={form}>
                      {LEGAL_FORM_LABELS[form]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block sm:col-span-2">
                <span className={LABEL}>Federal tax classification</span>
                <select
                  value={draft.taxClassification}
                  onChange={(e) => {
                    const taxClassification = e.target.value as TaxClassification;
                    setDraft({
                      taxClassification,
                      electionForm:
                        draft.electionForm === '2553' && taxClassification !== 's_corp'
                          ? ''
                          : draft.electionForm,
                    });
                  }}
                  className={SELECT}
                >
                  {allowedClassifications.map((cls) => (
                    <option key={cls} value={cls}>
                      {TAX_CLASSIFICATION_LABELS[cls]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={LABEL}>Election form</span>
                <select
                  value={draft.electionForm}
                  onChange={(e) => setDraft({ electionForm: e.target.value as DraftRow['electionForm'] })}
                  className={SELECT}
                >
                  <option value="">None</option>
                  {draft.taxClassification === 's_corp' && (
                    <option value="2553">{ELECTION_FORM_LABELS['2553']}</option>
                  )}
                  <option value="8832">{ELECTION_FORM_LABELS['8832']}</option>
                </select>
              </label>
              {draft.electionForm && (
                <>
                  <label className="block">
                    <span className={LABEL}>Filed on</span>
                    <input
                      type="date"
                      value={draft.electionFiledOn}
                      onChange={(e) => setDraft({ electionFiledOn: e.target.value })}
                      className={INPUT}
                    />
                  </label>
                  <label className="block">
                    <span className={LABEL}>IRS acceptance date</span>
                    <input
                      type="date"
                      value={draft.electionAcceptedOn}
                      onChange={(e) => setDraft({ electionAcceptedOn: e.target.value })}
                      className={INPUT}
                    />
                  </label>
                  <label className="block">
                    <span className={LABEL}>Election filing (Document Vault)</span>
                    <select
                      value={draft.electionDocumentId}
                      onChange={(e) => setDraft({ electionDocumentId: e.target.value })}
                      className={SELECT}
                    >
                      <option value="">None</option>
                      {documents.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.title || d.filename}
                        </option>
                      ))}
                      {draft.electionDocumentId &&
                        !documents.some((d) => String(d.id) === draft.electionDocumentId) && (
                          <option value={draft.electionDocumentId}>
                            {documentName(Number(draft.electionDocumentId))}
                          </option>
                        )}
                    </select>
                  </label>
                  <label className="block">
                    <span className={LABEL}>Acceptance letter (Document Vault)</span>
                    <select
                      value={draft.acceptanceDocumentId}
                      onChange={(e) => setDraft({ acceptanceDocumentId: e.target.value })}
                      className={SELECT}
                    >
                      <option value="">None</option>
                      {documents.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.title || d.filename}
                        </option>
                      ))}
                      {draft.acceptanceDocumentId &&
                        !documents.some((d) => String(d.id) === draft.acceptanceDocumentId) && (
                          <option value={draft.acceptanceDocumentId}>
                            {documentName(Number(draft.acceptanceDocumentId))}
                          </option>
                        )}
                    </select>
                  </label>
                </>
              )}
              <label className="block sm:col-span-2">
                <span className={LABEL}>Notes</span>
                <textarea
                  rows={2}
                  value={draft.notes}
                  onChange={(e) => setDraft({ notes: e.target.value })}
                  className={TEXTAREA}
                />
              </label>
            </div>

            {showShortYear && (
              <label className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={draft.shortYearConfirmed}
                  onChange={(e) => setDraft({ shortYearConfirmed: e.target.checked })}
                  className="mt-0.5"
                />
                <span>
                  {draft.effectiveFrom} is not January 1, so {draft.effectiveFrom.slice(0, 4)} splits
                  into short tax years that may each need a return. I understand; the app applies the
                  year-end status to that year and I will confirm the filings with my tax preparer.
                </span>
              </label>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditor(null)}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground-secondary hover:bg-surface-hover"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
              >
                {busy ? 'Checking…' : 'Preview'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        title={pending?.title}
        size="md"
      >
        {pending && (
          <div className="space-y-4 p-4">
            <p className="text-sm text-foreground">{pending.message}</p>
            <p
              className={`rounded-md border p-3 text-sm ${
                pending.affectedYears.length > 0
                  ? 'border-warning/40 bg-warning/10 text-foreground'
                  : 'border-border text-foreground-secondary'
              }`}
            >
              {describeAffectedYears(pending.affectedYears, pending.comparedYears)}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPending(null)}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground-secondary hover:bg-surface-hover"
              >
                Back
              </button>
              <button
                type="button"
                onClick={confirmPending}
                disabled={busy}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
              >
                {busy ? 'Saving…' : pending.confirmLabel}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
