import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, PhoneCall, ShieldCheck } from 'lucide-react';
import api from '../../services/api';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { useToast } from '../../components/ui/Toast';
import {
  bulkPocOutcome,
  canConfirmBulkPoc,
  plural,
  pocMobileProblem,
  type BulkPocPreview,
  type BulkPocResult,
} from '../../utils/bulkPoc';

/**
 * One POC mobile number for every event in the caller's scope: every event
 * for a Super Admin, the events they own for an Admin. Review first - the
 * server counts what would change - then confirm once.
 */
const BulkPocUpdate = () => {
  const { showToast } = useToast();
  const [mobile, setMobile] = useState('');
  const [includePast, setIncludePast] = useState(false);
  const [mobileError, setMobileError] = useState('');
  const [preview, setPreview] = useState<BulkPocPreview | null>(null);
  const [result, setResult] = useState<BulkPocResult | null>(null);
  const [isReviewing, setIsReviewing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const applyingRef = useRef(false);

  // Any change to what was reviewed means reviewing again.
  const resetReview = () => { setPreview(null); setResult(null); };

  const review = async () => {
    const problem = pocMobileProblem(mobile);
    setMobileError(problem);
    if (problem) return;
    setIsReviewing(true);
    setResult(null);
    try {
      const res = await api.post('/events/poc-bulk/preview', { mobile, includePast });
      setPreview(res.data);
    } catch (e: any) {
      setPreview(null);
      const message = e.response?.data?.error || 'Could not count the affected events.';
      if (e.response?.data?.code === 'INVALID_MOBILE') setMobileError(message);
      else showToast('error', message);
    } finally {
      setIsReviewing(false);
    }
  };

  const confirm = async () => {
    if (applyingRef.current || !canConfirmBulkPoc(preview, isApplying) || !preview) return;
    applyingRef.current = true;
    setIsApplying(true);
    try {
      const res = await api.post('/events/poc-bulk', { mobile, includePast, expectedCount: preview.counts.willUpdate, scopeToken: preview.scopeToken });
      setResult(res.data);
      setPreview(null);
      const outcome = bulkPocOutcome(res.data);
      showToast(outcome.tone, outcome.text);
    } catch (e: any) {
      const data = e.response?.data;
      if (data?.code === 'SCOPE_CHANGED' && data.preview) {
        setPreview(data.preview);
        showToast('warning', data.error);
      } else if (data && typeof data.updated === 'number') {
        // Every batch failed: still a result to show, not a success.
        setResult(data);
        setPreview(null);
        showToast('error', bulkPocOutcome(data).text);
      } else {
        showToast('error', data?.error || 'The POC numbers could not be updated.');
      }
    } finally {
      applyingRef.current = false;
      setIsApplying(false);
    }
  };

  return <div className="max-w-3xl mx-auto space-y-6">
    <div className="flex items-center gap-3">
      <Link to="/events" className="p-2 rounded-full hover:bg-surfaceHover text-foreground/60" aria-label="Back to events"><ArrowLeft className="w-5 h-5" /></Link>
      <div>
        <h1 className="text-3xl font-bold uppercase tracking-wider">Update POC number</h1>
        <p className="text-sm text-foreground/60">Set one point-of-contact mobile number on every event in your scope.</p>
      </div>
    </div>

    <section className="rounded-xl border border-border bg-surface p-5 space-y-4">
      <Input
        label="New POC mobile number"
        value={mobile}
        onChange={(e) => { setMobile(e.target.value); setMobileError(''); resetReview(); }}
        placeholder="9876543210"
        inputMode="tel"
        error={mobileError}
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={includePast} onChange={(e) => { setIncludePast(e.target.checked); resetReview(); }} />
        Also update completed and cancelled events
      </label>
      <p className="text-xs text-foreground/60">
        Only the POC mobile number changes, on events that have their own POC. The POC name, email and responsibility, WhatsApp senders, guests and everything else stay as they are. Sub-Events without their own POC show their Main Event's.
      </p>
      <Button variant="secondary" onClick={review} isLoading={isReviewing} disabled={!mobile.trim()}>
        <PhoneCall className="w-4 h-4 mr-2" />Review affected events
      </Button>
    </section>

    {preview && <section className="rounded-xl border border-border bg-surface p-5 space-y-3" aria-live="polite">
      <h2 className="font-semibold flex items-center gap-2"><ShieldCheck className="w-4 h-4" />Scope: {preview.scope.label}</h2>
      <ul className="text-sm space-y-1">
        <li>{plural(preview.counts.inScope, 'event')} in scope</li>
        <li><strong>{plural(preview.counts.willUpdate, 'event')} will get {preview.mobile}</strong></li>
        <li>{plural(preview.counts.alreadySet, 'event')} already {preview.counts.alreadySet === 1 ? 'has' : 'have'} this number</li>
        <li>{plural(preview.counts.noLocalPoc, 'event')} without their own POC ({plural(preview.counts.inheritingSubEvents, 'Sub-Event')} among them show their Main Event's)</li>
      </ul>
      {preview.counts.willUpdate === 0
        ? <p className="text-sm text-foreground/60">Nothing to update.</p>
        : <Button onClick={confirm} isLoading={isApplying} disabled={!canConfirmBulkPoc(preview, isApplying)}>
            Update {plural(preview.counts.willUpdate, 'event')}
          </Button>}
    </section>}

    {result && <section className="rounded-xl border border-border bg-surface p-5 space-y-2 text-sm" role="status" aria-live="polite">
      <h2 className="font-semibold">{bulkPocOutcome(result).text}</h2>
      <p>Already had the number: {result.skipped.alreadySet} · No POC of their own: {result.skipped.noLocalPoc} · Changed by someone else meanwhile: {result.skipped.changedMeanwhile}</p>
      {result.failed > 0 && <p className="text-red-500">{plural(result.failed, 'event')} could not be updated. Review again to retry the rest - events already updated are skipped.</p>}
      <p className="text-xs text-foreground/50">Reference: {result.bulkOperationId}</p>
    </section>}
  </div>;
};

export default BulkPocUpdate;
