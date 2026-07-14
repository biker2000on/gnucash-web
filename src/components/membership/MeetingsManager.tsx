'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { HouseholdBookBanner } from '@/components/business/HouseholdBookBanner';
import type { AttendanceStatus } from '@/lib/membership';
import type { MeetingDTO, MeetingDetailDTO } from '@/lib/services/membership.service';

const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}

interface MeetingForm {
    title: string;
    meetingDate: string;
    location: string;
    notes: string;
}

const EMPTY_FORM: MeetingForm = { title: '', meetingDate: todayIso(), location: '', notes: '' };

const STATUS_BUTTONS: Array<{ value: AttendanceStatus; label: string; activeClass: string }> = [
    { value: 'present', label: 'Present', activeClass: 'bg-positive/15 text-positive border-positive/40' },
    { value: 'absent', label: 'Absent', activeClass: 'bg-negative/10 text-negative border-negative/40' },
    { value: 'excused', label: 'Excused', activeClass: 'bg-warning/10 text-warning border-warning/40' },
];

function attendancePct(present: number, total: number): string {
    if (total === 0) return '—';
    return `${Math.round((present / total) * 100)}%`;
}

// ============================================
// Roll-call modal
// ============================================

function RollCallModal({ meetingId, onClose, onSaved }: {
    meetingId: number;
    onClose: () => void;
    onSaved: () => void;
}) {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();
    const [detail, setDetail] = useState<MeetingDetailDTO | null>(null);
    const [marks, setMarks] = useState<Map<number, AttendanceStatus>>(new Map());
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/membership/meetings/${meetingId}`)
            .then(res => {
                if (!res.ok) throw new Error('Failed to load meeting');
                return res.json();
            })
            .then((data: MeetingDetailDTO) => {
                if (cancelled) return;
                setDetail(data);
                setMarks(new Map(
                    data.roster
                        .filter(r => r.status !== null)
                        .map(r => [r.memberId, r.status as AttendanceStatus])
                ));
            })
            .catch(err => {
                error(err instanceof Error ? err.message : 'Failed to load meeting');
                onClose();
            });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meetingId]);

    const setMark = (memberId: number, status: AttendanceStatus) => {
        setMarks(prev => {
            const next = new Map(prev);
            // Clicking the already-selected status unmarks the member.
            if (next.get(memberId) === status) next.delete(memberId);
            else next.set(memberId, status);
            return next;
        });
    };

    const markAllPresent = () => {
        if (!detail) return;
        setMarks(new Map(detail.roster.map(r => [r.memberId, 'present' as AttendanceStatus])));
    };

    const stats = useMemo(() => {
        let present = 0;
        for (const status of marks.values()) if (status === 'present') present++;
        const total = detail?.roster.length ?? 0;
        return { present, marked: marks.size, total };
    }, [marks, detail]);

    const handleSave = async () => {
        setSaving(true);
        try {
            const entries = [...marks.entries()].map(([memberId, status]) => ({ memberId, status }));
            const res = await fetch(`/api/membership/meetings/${meetingId}/attendance`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to save attendance');
            }
            success('Attendance saved');
            onSaved();
            onClose();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save attendance');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={detail ? `Roll call — ${detail.title}` : 'Roll call'}
            size="lg"
        >
            <div className="p-6 space-y-4">
                {!detail ? (
                    <div className="p-8 flex items-center justify-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading roster...</span>
                    </div>
                ) : (
                    <>
                        <div className="flex flex-wrap items-center gap-3">
                            <span className="font-mono tabular-nums text-sm text-foreground-secondary">{detail.meetingDate}</span>
                            {detail.location && <span className="text-sm text-foreground-muted">{detail.location}</span>}
                            <button
                                type="button"
                                onClick={markAllPresent}
                                disabled={isReadonly || detail.roster.length === 0}
                                title={isReadonly ? READONLY_TOOLTIP : undefined}
                                className="ml-auto px-3 py-1.5 text-xs bg-surface-hover hover:bg-border text-foreground rounded-md transition-colors disabled:opacity-50"
                            >
                                Mark all present
                            </button>
                        </div>

                        {detail.roster.length === 0 ? (
                            <p className="text-sm text-foreground-muted py-4 text-center">
                                No active members to take roll for. Add members on the Members page first.
                            </p>
                        ) : (
                            <ul className="divide-y divide-border border border-border rounded-lg">
                                {detail.roster.map(r => {
                                    const current = marks.get(r.memberId);
                                    return (
                                        <li key={r.memberId} className="flex items-center gap-3 px-3 py-2">
                                            <span className="flex-1 min-w-0 truncate text-sm text-foreground">
                                                {r.name}
                                                {r.memberStatus !== 'active' && (
                                                    <span className="ml-2 text-xs text-foreground-muted">({r.memberStatus})</span>
                                                )}
                                            </span>
                                            <div className="flex gap-1 shrink-0">
                                                {STATUS_BUTTONS.map(b => (
                                                    <button
                                                        key={b.value}
                                                        type="button"
                                                        onClick={() => setMark(r.memberId, b.value)}
                                                        disabled={isReadonly}
                                                        title={isReadonly ? READONLY_TOOLTIP : undefined}
                                                        className={`px-2.5 py-1 text-xs rounded-md border transition-colors disabled:opacity-50 ${
                                                            current === b.value
                                                                ? b.activeClass
                                                                : 'border-border text-foreground-muted hover:text-foreground hover:bg-surface-hover'
                                                        }`}
                                                    >
                                                        {b.label}
                                                    </button>
                                                ))}
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}

                        <div className="flex items-center gap-3 pt-2 border-t border-border">
                            <span className="text-sm text-foreground-secondary font-mono tabular-nums">
                                {stats.present} of {stats.total} present ({attendancePct(stats.present, stats.total)})
                                {stats.marked < stats.total && ` · ${stats.total - stats.marked} unmarked`}
                            </span>
                            <button
                                type="button"
                                onClick={onClose}
                                className="ml-auto px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={saving || isReadonly}
                                title={isReadonly ? READONLY_TOOLTIP : undefined}
                                className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                            >
                                {saving ? 'Saving...' : 'Save attendance'}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}

// ============================================
// Main page component
// ============================================

export function MeetingsManager() {
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();

    const [meetings, setMeetings] = useState<MeetingDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<'new' | MeetingDTO | null>(null);
    const [form, setForm] = useState<MeetingForm>(EMPTY_FORM);
    const [saving, setSaving] = useState(false);
    const [rollCallId, setRollCallId] = useState<number | null>(null);
    const [deleting, setDeleting] = useState<MeetingDTO | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);

    const fetchMeetings = useCallback(async () => {
        try {
            const res = await fetch('/api/membership/meetings');
            if (!res.ok) throw new Error('Failed to load meetings');
            setMeetings(await res.json());
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load meetings');
        } finally {
            setLoading(false);
        }
    }, [error]);

    useEffect(() => { fetchMeetings(); }, [fetchMeetings]);

    const openCreate = () => {
        setForm({ ...EMPTY_FORM, meetingDate: todayIso() });
        setEditing('new');
    };

    const openEdit = (m: MeetingDTO) => {
        setForm({
            title: m.title,
            meetingDate: m.meetingDate,
            location: m.location ?? '',
            notes: m.notes ?? '',
        });
        setEditing(m);
    };

    const handleSave = async () => {
        if (!form.title.trim()) {
            error('Title is required');
            return;
        }
        setSaving(true);
        try {
            const isNew = editing === 'new';
            const url = isNew
                ? '/api/membership/meetings'
                : `/api/membership/meetings/${(editing as MeetingDTO).id}`;
            const res = await fetch(url, {
                method: isNew ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: form.title.trim(),
                    meetingDate: form.meetingDate,
                    location: form.location.trim() || null,
                    notes: form.notes || null,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to save meeting');
            }
            const saved: MeetingDTO = await res.json();
            success(isNew ? 'Meeting created' : 'Meeting updated');
            setEditing(null);
            await fetchMeetings();
            // Jump straight into roll call for a freshly created meeting.
            if (isNew) setRollCallId(saved.id);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to save meeting');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!deleting) return;
        setIsDeleting(true);
        try {
            const res = await fetch(`/api/membership/meetings/${deleting.id}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || 'Failed to delete meeting');
            }
            success(`Deleted "${deleting.title}"`);
            setDeleting(null);
            await fetchMeetings();
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to delete meeting');
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <div className="space-y-4">
            <PageHeader
                title="Meetings"
                subtitle="Meeting log and attendance roll call."
                actions={
                    <button
                        type="button"
                        onClick={openCreate}
                        disabled={isReadonly}
                        title={isReadonly ? READONLY_TOOLTIP : 'New meeting'}
                        className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors whitespace-nowrap"
                    >
                        + New meeting
                    </button>
                }
            />

            <HouseholdBookBanner />

            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                {loading ? (
                    <div className="p-12 flex items-center justify-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading meetings...</span>
                    </div>
                ) : meetings.length === 0 ? (
                    <div className="p-12 text-center space-y-2">
                        <p className="text-foreground-muted">No meetings yet.</p>
                        <p className="text-sm text-foreground-muted">
                            Create a meeting, then click it to take roll for your members.
                        </p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className="px-4 py-2 font-semibold">Date</th>
                                    <th className="px-4 py-2 font-semibold">Title</th>
                                    <th className="px-4 py-2 font-semibold">Location</th>
                                    <th className="px-4 py-2 font-semibold text-right">Attendance</th>
                                    <th className="px-4 py-2 font-semibold text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {meetings.map(m => (
                                    <tr
                                        key={m.id}
                                        onClick={() => setRollCallId(m.id)}
                                        className="hover:bg-surface-hover/50 transition-colors cursor-pointer"
                                    >
                                        <td className="px-4 py-3 text-sm font-mono tabular-nums text-foreground-secondary">{m.meetingDate}</td>
                                        <td className="px-4 py-3 text-sm text-foreground">{m.title}</td>
                                        <td className="px-4 py-3 text-sm text-foreground-secondary max-w-xs truncate">
                                            {m.location || <span className="text-foreground-muted">—</span>}
                                        </td>
                                        <td className="px-4 py-3 text-sm font-mono tabular-nums text-right text-foreground-secondary">
                                            {m.recordedCount === 0
                                                ? <span className="text-foreground-muted">not taken</span>
                                                : `${m.presentCount} / ${m.recordedCount} (${attendancePct(m.presentCount, m.recordedCount)})`}
                                        </td>
                                        <td className="px-4 py-3 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                                            <button
                                                type="button"
                                                onClick={() => setRollCallId(m.id)}
                                                className="px-2 py-1 text-xs rounded-md text-primary hover:bg-primary-light transition-colors"
                                            >
                                                Roll call
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => openEdit(m)}
                                                className="ml-1 px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                                            >
                                                Edit
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setDeleting(m)}
                                                disabled={isReadonly}
                                                title={isReadonly ? READONLY_TOOLTIP : undefined}
                                                className="ml-1 px-2 py-1 text-xs rounded-md text-negative hover:bg-negative/10 transition-colors disabled:opacity-50"
                                            >
                                                Delete
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Create / edit meeting modal */}
            <Modal
                isOpen={!!editing}
                onClose={() => setEditing(null)}
                title={editing === 'new' ? 'New meeting' : 'Edit meeting'}
                size="md"
            >
                <form
                    className="p-6 space-y-3"
                    onSubmit={(e) => { e.preventDefault(); handleSave(); }}
                >
                    <div>
                        <label className={labelClass}>Title *</label>
                        <input type="text" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} className={inputClass} placeholder="e.g. Monthly general meeting" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className={labelClass}>Date *</label>
                            <input type="date" value={form.meetingDate} onChange={e => setForm({ ...form, meetingDate: e.target.value })} className={`${inputClass} font-mono`} />
                        </div>
                        <div>
                            <label className={labelClass}>Location</label>
                            <input type="text" value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} className={inputClass} placeholder="Optional" />
                        </div>
                    </div>
                    <div>
                        <label className={labelClass}>Notes</label>
                        <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} className={`${inputClass} resize-none`} placeholder="Agenda, minutes link..." />
                    </div>
                    <div className="flex justify-end gap-3 pt-2 border-t border-border">
                        <button
                            type="button"
                            onClick={() => setEditing(null)}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={saving || isReadonly || !form.title.trim() || !form.meetingDate}
                            title={isReadonly ? READONLY_TOOLTIP : undefined}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                        >
                            {saving ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </form>
            </Modal>

            {rollCallId !== null && (
                <RollCallModal
                    meetingId={rollCallId}
                    onClose={() => setRollCallId(null)}
                    onSaved={fetchMeetings}
                />
            )}

            <ConfirmationDialog
                isOpen={!!deleting}
                onConfirm={handleDelete}
                onCancel={() => setDeleting(null)}
                title="Delete meeting"
                message={deleting
                    ? `Delete "${deleting.title}" (${deleting.meetingDate})? Its attendance records will be deleted too.`
                    : ''}
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={isDeleting}
            />
        </div>
    );
}
