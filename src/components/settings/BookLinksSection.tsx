'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { useBooks } from '@/contexts/BookContext';
import { CollapsibleConfigSection } from '@/components/ui/CollapsibleConfigSection';

interface BookLinkWithNames {
  businessBookGuid: string;
  householdBookGuid: string;
  ownershipPercent: number;
  businessBookName: string | null;
  householdBookName: string | null;
  businessEntityType: string | null;
  businessEntityName: string | null;
}

interface BookLinksPayload {
  entityType: string;
  linkable: boolean;
  outgoing: BookLinkWithNames[];
  incoming: BookLinkWithNames[];
  candidates: Array<{ guid: string; name: string | null }>;
}

/** Editable row state — percent kept as raw input text while editing. */
interface DraftLink {
  householdBookGuid: string;
  name: string | null;
  ownershipPercent: string;
}

const ENTITY_TYPE_LABELS: Record<string, string> = {
  sole_prop: 'Sole Proprietorship',
  llc_single: 'Single-Member LLC',
  llc_partnership: 'Partnership LLC',
  s_corp: 'S-Corp',
  c_corp: 'C-Corp',
};

function toDraft(outgoing: BookLinkWithNames[]): DraftLink[] {
  return outgoing.map((link) => ({
    householdBookGuid: link.householdBookGuid,
    name: link.householdBookName,
    ownershipPercent: String(link.ownershipPercent),
  }));
}

/**
 * "Linked household books" settings card — entity-level links from a business
 * book to the household book(s) of its owner(s), with an ownership percent.
 * Linking sends the business's profit share into the household's tax estimate
 * and gives the S-corp analyzer the household's tax context. On household
 * books with incoming links, renders a read-only "Linked business books" card
 * instead. Admin-only editing, same pattern as BookFeaturesSection.
 */
export function BookLinksSection() {
  const { success, error: showError } = useToast();
  const { books, activeBookGuid } = useBooks();
  const isAdmin = books.find((b) => b.guid === activeBookGuid)?.role === 'admin';

  const [payload, setPayload] = useState<BookLinksPayload | null>(null);
  const [draft, setDraft] = useState<DraftLink[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/book-links')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data && Array.isArray(data.outgoing)) {
            setPayload(data);
            setDraft(toDraft(data.outgoing));
            setDirty(false);
          }
        })
        .catch(() => { /* card stays hidden on failure */ });
    };
    load();
    // Linkability follows the entity type — re-resolve after it changes.
    window.addEventListener('entity-updated', load);
    return () => {
      cancelled = true;
      window.removeEventListener('entity-updated', load);
    };
  }, []);

  if (!payload) return null;

  /* ---- Read-only card: household book receiving business profit ---- */
  if (!payload.linkable) {
    if (payload.incoming.length === 0) return null;
    return (
      <CollapsibleConfigSection
        title="Linked business books"
        summary={`${payload.incoming.length} business${payload.incoming.length === 1 ? '' : 'es'} linked`}
        configured
        storageKey="settings.bookLinksOpen"
      >
        <div className="space-y-4">
          <p className="text-sm text-foreground-muted">
            This book&apos;s tax estimate includes its share of these businesses&apos; profit.
            Links are managed from each business book&apos;s settings.
          </p>
          <div className="space-y-2">
            {payload.incoming.map((link) => (
              <div
                key={link.businessBookGuid}
                className="flex flex-wrap items-center justify-between gap-3 p-3 bg-background-tertiary rounded-lg"
              >
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <span className="text-sm font-medium text-foreground">
                    {link.businessEntityName || link.businessBookName || 'Business book'}
                  </span>
                  {link.businessEntityType && (
                    <span className="text-[10px] uppercase tracking-wider text-foreground-muted border border-border rounded-full px-2 py-0.5">
                      {ENTITY_TYPE_LABELS[link.businessEntityType] ?? link.businessEntityType}
                    </span>
                  )}
                </div>
                <span className="text-sm text-foreground-secondary font-mono shrink-0">
                  {link.ownershipPercent}% ownership
                </span>
              </div>
            ))}
          </div>
        </div>
      </CollapsibleConfigSection>
    );
  }

  /* ---- Editable card: business book linking to household books ---- */

  const linkedGuids = new Set(draft.map((l) => l.householdBookGuid));
  const available = payload.candidates.filter((c) => !linkedGuids.has(c.guid));

  const parsed = draft.map((l) => parseFloat(l.ownershipPercent));
  const total = parsed.reduce((sum, p) => sum + (isNaN(p) ? 0 : p), 0);
  const hasInvalidPercent = parsed.some((p) => isNaN(p) || p <= 0 || p > 100);
  const overTotal = total > 100;

  const summary =
    draft.length === 0
      ? 'None linked'
      : `${draft.length} household book${draft.length === 1 ? '' : 's'} linked`;

  const updatePercent = (guid: string, value: string) => {
    setDraft((prev) =>
      prev.map((l) => (l.householdBookGuid === guid ? { ...l, ownershipPercent: value } : l)),
    );
    setDirty(true);
  };

  const removeLink = (guid: string) => {
    setDraft((prev) => prev.filter((l) => l.householdBookGuid !== guid));
    setDirty(true);
  };

  const addLink = (guid: string) => {
    const candidate = payload.candidates.find((c) => c.guid === guid);
    if (!candidate) return;
    // Default the new link to whatever ownership is still unassigned.
    const remaining = Math.max(0, Math.round((100 - total) * 100) / 100);
    setDraft((prev) => [
      ...prev,
      {
        householdBookGuid: guid,
        name: candidate.name,
        ownershipPercent: String(remaining > 0 ? remaining : 100),
      },
    ]);
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/book-links', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          links: draft.map((l) => ({
            householdBookGuid: l.householdBookGuid,
            ownershipPercent: parseFloat(l.ownershipPercent),
          })),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Failed to save book links');
      }
      const data: { outgoing: BookLinkWithNames[] } = await res.json();
      setPayload((prev) => (prev ? { ...prev, outgoing: data.outgoing } : prev));
      setDraft(toDraft(data.outgoing));
      setDirty(false);
      success('Linked household books saved');
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Failed to save book links');
    } finally {
      setSaving(false);
    }
  };

  return (
    <CollapsibleConfigSection
      title="Linked household books"
      summary={summary}
      configured
      storageKey="settings.bookLinksOpen"
    >
      <div className="space-y-4">
        <p className="text-sm text-foreground-muted">
          Linking sends this book&apos;s profit share to the household book&apos;s tax estimate
          (Schedule C for pass-throughs, K-1 for S-corps) and gives the S-corp analyzer the
          household&apos;s tax context. For a partnership, split ownership across each
          partner&apos;s household book.
        </p>

        {!isAdmin && (
          <p className="text-xs text-foreground-muted border border-border rounded-lg px-3 py-2 bg-background-tertiary">
            Only book admins can change linked household books.
          </p>
        )}

        {draft.length === 0 ? (
          <p className="text-sm text-foreground-muted px-3 py-2 bg-background-tertiary rounded-lg">
            No household books linked yet.
          </p>
        ) : (
          <div className="space-y-2">
            {draft.map((link) => (
              <div
                key={link.householdBookGuid}
                className="flex flex-wrap items-center gap-2 p-3 bg-background-tertiary rounded-lg"
              >
                <span className="flex-1 min-w-32 text-sm font-medium text-foreground truncate">
                  {link.name || 'Household book'}
                </span>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={link.ownershipPercent}
                    onChange={(e) => updatePercent(link.householdBookGuid, e.target.value)}
                    disabled={!isAdmin || saving}
                    placeholder="100"
                    className="w-20 bg-input-bg border border-border rounded-lg px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-60 disabled:cursor-not-allowed"
                    aria-label={`Ownership percent for ${link.name || 'household book'}`}
                  />
                  <span className="text-xs text-foreground-muted">%</span>
                </div>
                {isAdmin && (
                  <button
                    onClick={() => removeLink(link.householdBookGuid)}
                    disabled={saving}
                    className="text-foreground-muted hover:text-rose-500 transition-colors p-1 disabled:opacity-50"
                    aria-label={`Remove link to ${link.name || 'household book'}`}
                    title="Remove link"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {draft.length > 0 && (
          <p className={`text-xs ${overTotal ? 'text-warning' : 'text-foreground-muted'}`}>
            Total ownership: {Math.round(total * 100) / 100}%
            {overTotal && ' — total across linked households cannot exceed 100%'}
            {!overTotal && hasInvalidPercent && ' — each link needs a percent between 0 and 100'}
          </p>
        )}

        {isAdmin && available.length > 0 && (
          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">Add household book</label>
            <select
              value=""
              onChange={(e) => { if (e.target.value) addLink(e.target.value); }}
              disabled={saving}
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-60"
            >
              <option value="">Select a household book…</option>
              {available.map((c) => (
                <option key={c.guid} value={c.guid}>
                  {c.name || c.guid}
                </option>
              ))}
            </select>
          </div>
        )}

        {isAdmin && payload.candidates.length === 0 && draft.length === 0 && (
          <p className="text-xs text-foreground-muted">
            No household books available to link. You need access to at least one other book
            with a Household entity type.
          </p>
        )}

        {isAdmin && (
          <button
            onClick={handleSave}
            disabled={saving || !dirty || hasInvalidPercent || overTotal}
            className="w-full bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-primary-foreground font-medium px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {saving && (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
            <span>{saving ? 'Saving...' : 'Save linked books'}</span>
          </button>
        )}
      </div>
    </CollapsibleConfigSection>
  );
}
