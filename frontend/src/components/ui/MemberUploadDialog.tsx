import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, RotateCcw, Upload, X, XCircle } from 'lucide-react';
import type { Event, MemberUploadRow } from '@eventreach/shared';
import api from '../../services/api';
import { Button } from './Button';
import { Badge } from './Badge';
import { FileUpload } from './FileUpload';
import { useToast } from './Toast';
import { getSerialNumber } from '../../utils/pagination';
import {
  ADD_MEMBERS_BATCH_SIZE,
  chunkIds,
  emptyOutcome,
  mergeBatchFailure,
  mergeBatchResponse,
  retryableIds,
  type AddMembersOutcome,
} from '../../utils/subEventMembers';
import {
  MEMBER_UPLOAD_ACCEPT,
  MEMBER_UPLOAD_MAX_BYTES,
  checkMemberUploadFile,
  describeUploadResult,
  summarizeRows,
  validContactIds,
  withoutStatus,
  type UploadCounts,
  type UploadResult,
} from '../../utils/memberUpload';

/**
 * Upload a file of guests onto ONE Sub-Event's member list, the way the Contact
 * Bulk upload works: choose a file, review a preview, confirm.
 *
 * A Sub-Event's members are existing contacts, so each row is matched to one
 * (the server does it, and saves nothing at the preview step). Confirming adds
 * the matched contacts to this Sub-Event through the same call as Add Members;
 * numbers that are not contacts are skipped, never created. The Main Event and
 * every other Sub-Event are untouched.
 */

interface MemberUploadDialogProps {
  subEvent: Event;
  open: boolean;
  onClose: () => void;
  /** Called after members were added, so the list can refresh. */
  onAdded: (outcome: AddMembersOutcome) => void;
}

type Step = 'select' | 'preview' | 'result';

const statusIcon = (row: MemberUploadRow) => {
  if (row.status === 'Valid') return <span title="Will be added"><CheckCircle2 className="w-5 h-5 text-emerald-500" /></span>;
  if (row.status === 'Invalid') return <span title={row.validationReason}><XCircle className="w-5 h-5 text-red-500" /></span>;
  return <span title={row.validationReason}><AlertTriangle className="w-5 h-5 text-amber-500" /></span>;
};

const reasonColor = (status: MemberUploadRow['status']) =>
  status === 'Valid' ? 'text-accent' : status === 'Invalid' ? 'text-destructive' : 'text-amber-500';

export const MemberUploadDialog = ({ subEvent, open, onClose, onAdded }: MemberUploadDialogProps) => {
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>('select');
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<MemberUploadRow[]>([]);
  const [error, setError] = useState('');
  const [isReading, setIsReading] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<AddMembersOutcome | null>(null);
  const [counts, setCounts] = useState<UploadCounts | null>(null);

  const busy = isReading || isAdding;

  // A fresh start each time the dialog is opened.
  useEffect(() => {
    if (!open) return;
    setStep('select');
    setFile(null);
    setRows([]);
    setError('');
    setOutcome(null);
    setCounts(null);
    setProgress(null);
  }, [open]);

  // Escape closes, except while a request is in flight.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  const live = useMemo(() => summarizeRows(rows), [rows]);

  const pickFile = useCallback((picked: File) => {
    const problem = checkMemberUploadFile(picked);
    setError(problem ?? '');
    setFile(problem ? null : picked);
  }, []);

  const readFile = useCallback(async () => {
    if (!file || busy) return;
    setIsReading(true);
    setError('');
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await api.post(`/events/${subEvent._id}/members/upload`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      setRows(Array.isArray(res.data?.rows) ? res.data.rows : []);
      setStep('preview');
    } catch (err: any) {
      setError(err?.response?.data?.error || 'The file could not be processed. Try again.');
    } finally {
      setIsReading(false);
    }
  }, [file, busy, subEvent._id]);

  const runAdd = useCallback(async (ids: string[], summary: UploadCounts, carried: AddMembersOutcome) => {
    if (isAdding || ids.length === 0) return;
    setIsAdding(true);
    const batches = chunkIds(ids, ADD_MEMBERS_BATCH_SIZE);
    let result = carried;
    setProgress({ done: 0, total: batches.length });
    for (let i = 0; i < batches.length; i++) {
      try {
        const res = await api.post(`/events/${subEvent._id}/members`, { contactIds: batches[i] });
        result = mergeBatchResponse(result, res.data);
      } catch (err: any) {
        const body = err?.response?.data;
        // A refused batch still reports each id; only one with no answer fails as a whole.
        result = body && (Array.isArray(body.rejected) || Array.isArray(body.failed))
          ? mergeBatchResponse(result, body)
          : mergeBatchFailure(result, batches[i], body?.error || 'Could not reach the server. Try again.');
      }
      setProgress({ done: i + 1, total: batches.length });
    }
    setOutcome(result);
    setCounts(summary);
    setProgress(null);
    setIsAdding(false);
    setStep('result');
    const described = describeUploadResult(summary, result);
    showToast(described.tone, described.message);
    if (result.added.length > 0) onAdded(result);
  }, [isAdding, subEvent._id, showToast, onAdded]);

  const confirm = () => runAdd(validContactIds(rows), live, emptyOutcome());

  if (!open) return null;

  const result: UploadResult | null = outcome && counts ? describeUploadResult(counts, outcome) : null;
  const retryIds = outcome ? retryableIds(outcome) : [];
  const nameOf = (id: string) => rows.find((r) => r.contactId === id)?.matchedName ?? rows.find((r) => r.contactId === id)?.fullName;

  return createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-upload-title"
        className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col animate-spring-up"
      >
        <div className="p-5 border-b border-border flex items-start justify-between gap-4">
          <div>
            <h3 id="member-upload-title" className="text-xl font-bold text-foreground flex items-center gap-2">
              <Upload className="w-5 h-5" /> Upload Members
            </h3>
            <p className="text-sm text-foreground/50 mt-1">
              Add guests to <span className="font-medium text-foreground/80">{subEvent.eventName}</span> from an Excel or PDF file. Only this sub-event's list changes.
            </p>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close" className="p-1.5 rounded-md text-foreground/50 hover:text-foreground hover:bg-surfaceHover disabled:opacity-40">
            <X className="w-5 h-5" />
          </button>
        </div>

        {step === 'select' && (
          <div className="p-5 space-y-4 overflow-y-auto">
            {error && <div role="alert" className="p-3 bg-destructive/10 border border-destructive/20 text-destructive rounded-md text-sm">{error}</div>}
            <div className="rounded-lg border border-border bg-surface/50 px-4 py-3">
              <p className="text-xs text-foreground/70">The Excel sheet (or PDF table) must have these columns in its first row:</p>
              <p className="mt-1.5 font-mono text-xs text-foreground">
                Sr.No <span className="text-foreground/30">|</span> Guest Name <span className="text-foreground/30">|</span> Contact Number
              </p>
              <p className="mt-2 text-xs text-foreground/50">
                Each Contact Number is matched to a contact you already have (this event's main event, or your other events). Only matches are added; numbers that are not contacts are skipped, and no contact is created.
              </p>
            </div>
            <FileUpload
              onFileSelect={pickFile}
              selectedFile={file}
              onClear={() => { setFile(null); setError(''); }}
              accept={MEMBER_UPLOAD_ACCEPT}
              maxSize={MEMBER_UPLOAD_MAX_BYTES}
              disabled={isReading}
            />
          </div>
        )}

        {step === 'preview' && (
          <div className="p-5 space-y-4 flex flex-col min-h-0">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="success">Will be added: {live.valid}</Badge>
              <Badge variant="warning">Duplicates: {live.duplicate}</Badge>
              <Badge variant="info">Not in contacts: {live.notFound}</Badge>
              <Badge variant="error">Invalid: {live.invalid}</Badge>
              {live.duplicate > 0 && (
                <button onClick={() => setRows((r) => withoutStatus(r, 'Duplicate'))} className="text-xs text-amber-500 hover:text-amber-400 underline">Remove all duplicates</button>
              )}
              {live.notFound > 0 && (
                <button onClick={() => setRows((r) => withoutStatus(r, 'NotFound'))} className="text-xs text-foreground/60 hover:text-foreground underline">Remove all not in contacts</button>
              )}
              {live.invalid > 0 && (
                <button onClick={() => setRows((r) => withoutStatus(r, 'Invalid'))} className="text-xs text-destructive hover:text-red-400 underline">Remove all invalid</button>
              )}
            </div>

            <div className="flex-1 min-h-0 max-h-[50vh] overflow-auto table-scroll border border-border rounded-md">
              <table className="w-full min-w-[640px] text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-black/5 dark:bg-white/5 text-foreground/60 text-xs uppercase tracking-wider font-medium sticky top-0 border-b border-border">
                    <th className="py-2 px-4 w-16 whitespace-nowrap">Sr No</th>
                    <th className="py-2 px-4 w-10"></th>
                    <th className="py-2 px-4">Name</th>
                    <th className="py-2 px-4">Phone Number</th>
                    <th className="py-2 px-4">Status</th>
                    <th className="py-2 px-4 w-12"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row, idx) => (
                    <tr key={row.id} className={row.status !== 'Valid' ? 'bg-surface/50 opacity-80' : 'hover:bg-surfaceHover transition-colors'}>
                      <td className="py-2 px-4 text-foreground/50 tabular-nums whitespace-nowrap">{getSerialNumber(1, rows.length, idx)}</td>
                      <td className="py-2 px-4 text-center">{statusIcon(row)}</td>
                      <td className="py-2 px-4 font-medium text-foreground">
                        {row.fullName || <span className="text-foreground/40">(no name)</span>}
                        {row.matchedName && row.matchedName !== row.fullName && (
                          <span className="block text-xs font-normal text-foreground/50">Contact: {row.matchedName}</span>
                        )}
                      </td>
                      <td className="py-2 px-4 font-mono text-foreground/80">{row.phoneNumber}</td>
                      <td className="py-2 px-4"><span className={`text-xs ${reasonColor(row.status)}`}>{row.validationReason || 'Ready to add'}</span></td>
                      <td className="py-2 px-4">
                        <button onClick={() => setRows((r) => r.filter((_, i) => i !== idx))} className="text-foreground/40 hover:text-destructive transition-colors p-1" title="Remove" aria-label={`Remove row ${idx + 1}`}>
                          <XCircle className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && <div className="p-8 text-center text-foreground/50">No rows left to review.</div>}
            </div>
          </div>
        )}

        {step === 'result' && result && outcome && (
          <div className="p-5 space-y-4 overflow-y-auto" aria-live="polite">
            <div className={`p-4 rounded-md border text-sm ${
              result.tone === 'success' ? 'bg-accent/10 border-accent/20 text-accent'
              : result.tone === 'error' ? 'bg-destructive/10 border-destructive/20 text-destructive'
              : result.tone === 'warning' ? 'bg-amber-500/10 border-amber-500/30 text-amber-500'
              : 'bg-surfaceHover border-border text-foreground/70'
            }`}>
              {result.message}
            </div>
            <dl className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center">
              {[
                ['Added', result.added],
                ['Already members', result.alreadyMembers],
                ['Not in contacts', result.notInContacts],
                ['Invalid', result.invalid],
                ['Failed', result.notAdded],
              ].map(([label, value]) => (
                <div key={label as string} className="rounded-lg border border-border px-3 py-2">
                  <dd className="text-xl font-bold text-foreground tabular-nums">{value}</dd>
                  <dt className="text-xs text-foreground/50">{label}</dt>
                </div>
              ))}
            </dl>
            {[...outcome.rejected, ...outcome.failed].length > 0 && (
              <ul className="text-sm space-y-1 max-h-40 overflow-y-auto">
                {[...outcome.rejected, ...outcome.failed].map((issue) => (
                  <li key={issue.id} className="text-destructive">{nameOf(issue.id) ?? 'A contact'}: {issue.reason}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="p-4 border-t border-border flex items-center justify-between gap-3">
          <span className="text-sm text-foreground/60" aria-live="polite">
            {step === 'preview' && !isAdding && <>Only <strong className="text-accent">{live.valid}</strong> matched contact{live.valid === 1 ? '' : 's'} will be added.</>}
            {isAdding && progress && `Adding… ${progress.done} of ${progress.total}`}
          </span>
          <div className="flex gap-2">
            {step === 'select' && (
              <>
                <Button variant="secondary" onClick={onClose} disabled={isReading}>Cancel</Button>
                <Button onClick={readFile} disabled={!file} isLoading={isReading}>Upload and Preview</Button>
              </>
            )}
            {step === 'preview' && (
              <>
                <Button variant="ghost" onClick={() => { setStep('select'); setError(''); }} disabled={isAdding}>Change File</Button>
                <Button onClick={confirm} disabled={live.valid === 0} isLoading={isAdding}>
                  <Upload className="w-4 h-4 mr-2" /> Add {live.valid} Member{live.valid === 1 ? '' : 's'}
                </Button>
              </>
            )}
            {step === 'result' && (
              <>
                {retryIds.length > 0 && counts && outcome && !isAdding && (
                  <Button variant="secondary" onClick={() => runAdd(retryIds, counts, { ...outcome, failed: [] })}>
                    <RotateCcw className="w-4 h-4 mr-2" /> Retry failed ({retryIds.length})
                  </Button>
                )}
                <Button onClick={onClose}>Done</Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
