import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, CheckCircle2, Pencil, RefreshCw, Send, ShieldAlert, Trash2 } from 'lucide-react';
import { EVENT_BUSINESS_ID_PLACEHOLDER } from '@eventreach/shared';
import api from '../../services/api';
import { useAuth } from '../../store/authStore';
import { useToast } from '../../components/ui/Toast';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { formatDateTime } from '../../utils/datetime';
import {
  TEMPLATES_API,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCE_LABELS,
  formFromTemplate,
  BUTTON_TYPE_LABELS,
  canConfirmSubmission,
  eventLinkConfirmation,
  eventLinkRequest,
  eventLinkToast,
  historyLabel,
  outcomeToast,
  parseReview,
  prettyPayload,
  submitBody,
  renderPreview,
  stateDisplay,
  templateActions,
  toApiProblem,
  type ApiProblem,
  type SubmissionReview,
  type TemplateView,
  type ToastKind,
} from '../../utils/whatsappTemplates';

type Confirming = 'delete' | null;

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 py-2 border-b border-border/50 last:border-0">
    <dt className="sm:w-44 shrink-0 text-[11px] font-bold uppercase tracking-wider text-foreground/50">{label}</dt>
    <dd className="text-sm text-foreground break-words">{children}</dd>
  </div>
);

const TemplateDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { showToast } = useToast();

  const [template, setTemplate] = useState<TemplateView | null>(null);
  const [loadProblem, setLoadProblem] = useState<ApiProblem | null>(null);
  const [actionProblem, setActionProblem] = useState<ApiProblem | null>(null);
  const [outcome, setOutcome] = useState<{ type: ToastKind; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [eventName, setEventName] = useState<string | null>(null);
  // The payload review that precedes any submission to Meta.
  const [review, setReview] = useState<SubmissionReview | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  // Linking the template to an event (or moving it): the typed Event ID, its error, the ID awaiting confirmation.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkInput, setLinkInput] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkConfirm, setLinkConfirm] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadProblem(null);
    try {
      const response = await api.get(`${TEMPLATES_API}/${id}`);
      setTemplate(response.data.template);
    } catch (error) {
      setLoadProblem(toApiProblem(error));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!template?.eventObjectId) {
      setEventName(null);
      return;
    }
    api
      .get(`/events/${template.eventObjectId}`)
      .then((response) => setEventName(response.data?.eventName ?? null))
      .catch(() => setEventName(null));
  }, [template?.eventObjectId]);

  /** Submit, Check status and Refresh status answer 200 with an outcome and the template as stored. */
  const runOutcomeAction = async (path: 'submit' | 'reconcile' | 'refresh', body?: Record<string, unknown>) => {
    setBusy(true);
    setActionProblem(null);
    setOutcome(null);
    try {
      const response = await api.post(`${TEMPLATES_API}/${id}/${path}`, body);
      if (response.data?.template) setTemplate(response.data.template);
      const toast = outcomeToast(response.data);
      setOutcome(toast);
      showToast(toast.type, toast.message);
    } catch (error) {
      const problem = toApiProblem(error);
      setActionProblem(problem);
      // The template may have moved on (submitted elsewhere): show it as it is.
      if (problem.kind === 'conflict') load();
    } finally {
      setBusy(false);
    }
  };

  /** Fetches exactly what a submission would send. Reading it sends nothing to Meta. */
  const openReview = async () => {
    setBusy(true);
    setActionProblem(null);
    setOutcome(null);
    try {
      const response = await api.get(`${TEMPLATES_API}/${id}/payload`);
      const parsed = parseReview(response.data);
      if (!parsed) {
        setActionProblem({ kind: 'unknown', status: null, code: null, message: 'The review could not be read. Nothing was submitted.', fieldErrors: {} });
        return;
      }
      setReview(parsed);
      setAcknowledged(false);
      setReviewOpen(true);
    } catch (error) {
      setActionProblem(toApiProblem(error));
    } finally {
      setBusy(false);
    }
  };

  const closeReview = () => {
    setReviewOpen(false);
    setAcknowledged(false);
  };

  /** Only reachable from the review, once its payload is ticked as reviewed. */
  const submitReviewed = async () => {
    if (!review || !canConfirmSubmission(review, acknowledged, busy)) return;
    closeReview();
    await runOutcomeAction('submit', submitBody(review));
  };

  const remove = async () => {
    setBusy(true);
    setActionProblem(null);
    try {
      await api.delete(`${TEMPLATES_API}/${id}`);
      showToast('success', 'Draft deleted.');
      navigate('/whatsapp/templates');
    } catch (error) {
      setActionProblem(toApiProblem(error));
      setBusy(false);
    }
  };

  const openLink = () => {
    setLinkInput(template?.eventId ?? '');
    setLinkError(null);
    setLinkOpen(true);
  };

  const closeLink = () => {
    setLinkOpen(false);
    setLinkError(null);
    setLinkConfirm(null);
  };

  /** Validates what was typed, then asks for confirmation. Nothing is sent until it is given. */
  const reviewLink = () => {
    const request = eventLinkRequest(linkInput);
    if (!request.ok) {
      setLinkError(request.message);
      return;
    }
    if (template && template.eventId === request.body.eventId) {
      setLinkError(`This template is already linked to ${request.body.eventId}.`);
      return;
    }
    setLinkError(null);
    setLinkConfirm(request.body.eventId);
  };

  /** PUT the confirmed Event ID. The server resolves the event; this never sends an ObjectId and never calls Meta. */
  const saveLink = async () => {
    const eventId = linkConfirm;
    if (!eventId || linkBusy) return;
    setLinkConfirm(null);
    setLinkBusy(true);
    setLinkError(null);
    try {
      const response = await api.put(`${TEMPLATES_API}/${id}/event`, { eventId });
      if (response.data?.template) setTemplate(response.data.template);
      const toast = eventLinkToast(response.data);
      showToast(toast.type, toast.message);
      closeLink();
    } catch (error) {
      const problem = toApiProblem(error);
      // A refused Event ID is shown under the field, in the server's own words.
      setLinkError(problem.fieldErrors.eventId ?? problem.message);
      // The template may have moved on (started submitting): show it as it is.
      if (problem.kind === 'conflict') load();
    } finally {
      setLinkBusy(false);
    }
  };

  const confirm = async () => {
    const action = confirming;
    setConfirming(null);
    if (action === 'delete') await remove();
  };

  if (loadProblem) {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 text-center bg-surface border border-border rounded-xl space-y-3">
        <ShieldAlert className="w-10 h-10 mx-auto text-foreground/30" />
        <p className="font-semibold text-foreground">{loadProblem.message}</p>
        {loadProblem.kind !== 'forbidden' && loadProblem.kind !== 'notFound' && (
          <Button variant="secondary" onClick={load}>Try again</Button>
        )}
        <div><Link to="/whatsapp/templates" className="text-sm text-accent hover:underline">Back to templates</Link></div>
      </div>
    );
  }

  if (!template) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
      </div>
    );
  }

  const status = stateDisplay(template.localState);
  const actions = templateActions(user, template);
  const rows = formFromTemplate(template).variables;

  return (
    <div className="space-y-6">
      <div className="space-y-2 animate-fade-in">
        <Link to="/whatsapp/templates" className="inline-flex items-center text-sm text-foreground/60 hover:text-foreground">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to templates
        </Link>
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">{template.displayName}</h2>
            <div className="flex items-center gap-3 mt-1">
              <span className="font-mono text-sm text-foreground/60">{template.name}</span>
              <Badge variant={status.variant}>{status.label}</Badge>
            </div>
            {status.hint && <p className="text-xs text-foreground/50 mt-1">{status.hint}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {actions.edit && (
              <Link to={`/whatsapp/templates/${template.id}/edit`}>
                <Button variant="secondary" disabled={busy}><Pencil className="w-4 h-4 mr-2" />Edit</Button>
              </Link>
            )}
            {actions.checkStatus && (
              <Button variant="secondary" onClick={() => runOutcomeAction('reconcile')} disabled={busy} isLoading={busy}>
                <RefreshCw className="w-4 h-4 mr-2" />Check status
              </Button>
            )}
            {actions.refresh && (
              <Button variant="secondary" onClick={() => runOutcomeAction('refresh')} disabled={busy} isLoading={busy}>
                <RefreshCw className="w-4 h-4 mr-2" />Refresh status
              </Button>
            )}
            {actions.submit && (
              <Button onClick={openReview} disabled={busy}>
                <Send className="w-4 h-4 mr-2" />Review &amp; submit
              </Button>
            )}
            {actions.delete && (
              <Button variant="danger" onClick={() => setConfirming('delete')} disabled={busy}>
                <Trash2 className="w-4 h-4 mr-2" />Delete draft
              </Button>
            )}
          </div>
        </div>
      </div>

      {outcome && (
        <div
          className={`flex items-start gap-3 rounded-lg border p-4 text-sm ${
            outcome.type === 'success'
              ? 'border-accent/30 bg-accent/10 text-accent'
              : outcome.type === 'error'
                ? 'border-destructive/30 bg-destructive/10 text-destructive'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-600'
          }`}
          role="status"
        >
          {outcome.type === 'success' ? <CheckCircle2 className="w-5 h-5 shrink-0" /> : <AlertTriangle className="w-5 h-5 shrink-0" />}
          <span>{outcome.message}</span>
        </div>
      )}

      {actionProblem && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span>{actionProblem.message}</span>
        </div>
      )}

      {template.rejectionReason && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <p className="font-semibold text-destructive mb-1">
            {template.localState === 'SubmissionFailed' ? 'Why the submission failed' : 'Reason'}
          </p>
          <p className="text-foreground/80">{template.rejectionReason}</p>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
        <div className="space-y-6">
          <section className="bg-surface rounded-xl border border-border p-5">
            <h3 className="font-semibold text-foreground mb-2">Details</h3>
            <dl>
              <Row label="Category">{template.category.charAt(0) + template.category.slice(1).toLowerCase()}</Row>
              {template.metaCategory && template.metaCategory !== template.category && (
                <Row label="Category at WhatsApp">{template.metaCategory}</Row>
              )}
              <Row label="Language"><span className="font-mono">{template.language}</span></Row>
              <Row label="Event">
                <div className="space-y-2">
                  <div>
                    {template.eventId ? (
                      <>
                        <span className="font-mono">{template.eventId}</span>
                        {eventName ? <span className="text-foreground/60"> - {eventName}</span> : null}
                      </>
                    ) : (
                      'No event - not offered in the Message tab until it is linked to one'
                    )}
                  </div>
                  {actions.linkEvent && !linkOpen && (
                    <button type="button" className="text-xs text-accent hover:underline" onClick={openLink} disabled={busy}>
                      {template.eventId ? 'Change event' : 'Link to an event'}
                    </button>
                  )}
                  {actions.linkEvent && linkOpen && (
                    <form
                      className="space-y-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        reviewLink();
                      }}
                    >
                      <label htmlFor="tpl-link-event-id" className="sr-only">Event ID</label>
                      <input
                        id="tpl-link-event-id"
                        className="block w-full max-w-sm rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
                        value={linkInput}
                        onChange={(e) => {
                          setLinkInput(e.target.value);
                          setLinkError(null);
                        }}
                        placeholder={EVENT_BUSINESS_ID_PLACEHOLDER}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={linkError ? true : undefined}
                        disabled={linkBusy}
                      />
                      {linkError && <p className="text-xs text-destructive" role="alert">{linkError}</p>}
                      <div className="flex gap-2">
                        <Button type="submit" disabled={linkBusy} isLoading={linkBusy}>Continue</Button>
                        <Button type="button" variant="secondary" onClick={closeLink} disabled={linkBusy}>Cancel</Button>
                      </div>
                    </form>
                  )}
                </div>
              </Row>
              <Row label="Owner">{template.ownerAdminId ? (template.ownerAdminId === user?.id ? 'You' : 'An Admin') : 'Shared'}</Row>
              <Row label="Status">{status.label}</Row>
              {template.metaStatus && <Row label="WhatsApp status"><span className="font-mono">{template.metaStatus}</span></Row>}
              {template.metaTemplateId && <Row label="WhatsApp template ID"><span className="font-mono">{template.metaTemplateId}</span></Row>}
              {template.wabaId && <Row label="Business Account ID"><span className="font-mono">{template.wabaId}</span></Row>}
              <Row label="Last checked">{template.lastSyncedAt ? formatDateTime(template.lastSyncedAt) : 'Not yet'}</Row>
              <Row label="Submission attempts">{template.submissionAttempts}</Row>
              <Row label="Created">{formatDateTime(template.createdAt)}</Row>
              <Row label="Updated">{formatDateTime(template.updatedAt)}</Row>
            </dl>
          </section>

          <section className="bg-surface rounded-xl border border-border p-5 space-y-3">
            <h3 className="font-semibold text-foreground">Placeholders</h3>
            {rows.length === 0 ? (
              <p className="text-sm text-foreground/50 italic">This template has no placeholders.</p>
            ) : (
              <div className="table-scroll">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-foreground/50 border-b border-border">
                      <th className="py-2 pr-4">Placeholder</th>
                      <th className="py-2 pr-4">Name</th>
                      <th className="py-2 pr-4">Filled with</th>
                      <th className="py-2 pr-4">Example</th>
                      <th className="py-2">If empty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.position} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-4 font-mono text-accent">{`{{${r.position}}}`}</td>
                        <td className="py-2 pr-4">{r.label}</td>
                        <td className="py-2 pr-4">
                          {r.source ? WHATSAPP_TEMPLATE_VARIABLE_SOURCE_LABELS[r.source] : '—'}
                          {r.source === 'fixed' && r.fixedValue ? `: ${r.fixedValue}` : ''}
                        </td>
                        <td className="py-2 pr-4">{r.sample}</td>
                        <td className="py-2">{r.fallback || (r.source === 'guest.name' ? 'Guest' : '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {template.buttons.length > 0 && (
            <section className="bg-surface rounded-xl border border-border p-5 space-y-3" aria-label="Buttons">
              <h3 className="font-semibold text-foreground">Buttons</h3>
              <ul className="space-y-1 text-sm">
                {template.buttons.map((b, i) => (
                  <li key={i}>
                    <span className="text-foreground/50">{BUTTON_TYPE_LABELS[b.type]}:</span> {b.text}
                    {b.url ? <span className="font-mono text-xs text-foreground/60"> · {b.url}</span> : null}
                    {b.phoneNumber ? <span className="font-mono text-xs text-foreground/60"> · {b.phoneNumber}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="bg-surface rounded-xl border border-border p-5 space-y-3">
            <h3 className="font-semibold text-foreground">History</h3>
            {template.history.length === 0 ? (
              <p className="text-sm text-foreground/50 italic">No history recorded.</p>
            ) : (
              <ol className="space-y-2">
                {[...template.history].reverse().map((h, i) => (
                  <li key={`${h.at}-${i}`} className="flex flex-col sm:flex-row sm:gap-4 text-sm">
                    <span className="sm:w-44 shrink-0 text-xs text-foreground/50">{formatDateTime(h.at)}</span>
                    <span className="text-foreground">
                      {historyLabel(h.type)}
                      {h.metaStatus ? <span className="font-mono text-xs text-foreground/60"> · {h.metaStatus}</span> : null}
                      {h.message ? <span className="block text-xs text-foreground/60">{h.message}</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="bg-surface rounded-xl border border-border p-5 space-y-3 xl:sticky xl:top-4">
          <h3 className="font-semibold text-foreground">Preview</h3>
          <div className="rounded-lg bg-[#e7ffdb] text-[#111b21] p-3 text-sm shadow-sm space-y-2" aria-label="Message preview">
            {template.headerText && <p className="font-bold">{template.headerText}</p>}
            <p className="whitespace-pre-wrap break-words">{renderPreview(template.body, rows)}</p>
            {template.footer && <p className="text-xs text-black/50">{template.footer}</p>}
          </div>
          {template.buttons.length > 0 && (
            <div className="space-y-1">
              {template.buttons.map((b, i) => (
                <div key={i} className="rounded-lg bg-white text-[#027eb5] text-sm text-center py-2 shadow-sm">{b.text}</div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-foreground/40">Shown with the example values.</p>
        </aside>
      </div>

      {reviewOpen && review && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Review before submitting">
          <div className="bg-surface border border-border p-6 rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto animate-spring-up space-y-4">
            <h3 className="text-xl font-bold text-foreground">Review before submitting to WhatsApp</h3>
            <p className="text-foreground/70 leading-relaxed text-sm">
              This is exactly what will be sent to Meta, built by the server from the saved template. Submitting asks Meta to review it - it does not send any message.
              Meta decides whether to approve it and in which category, and it can no longer be edited here afterwards.
            </p>
            {review.blockers.length > 0 && (
              <ul className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 space-y-1" role="alert">
                {review.blockers.map((b) => <li key={b}>{b}</li>)}
              </ul>
            )}
            {review.errors && review.errors.length > 0 && (
              <ul className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive space-y-1" role="alert">
                {review.errors.map((e) => <li key={`${e.field}-${e.message}`}>{e.message}</li>)}
              </ul>
            )}
            {review.payload && (
              <pre className="rounded-lg border border-border bg-background p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-words max-h-80" aria-label="Payload sent to Meta">{prettyPayload(review.payload)}</pre>
            )}
            {review.canSubmit && (
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                <span>I have reviewed this payload and want to submit it to WhatsApp for review.</span>
              </label>
            )}
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={closeReview}>Cancel</Button>
              <Button onClick={submitReviewed} disabled={!canConfirmSubmission(review, acknowledged, busy)}>Submit to WhatsApp</Button>
            </div>
          </div>
        </div>
      )}

      {linkConfirm && (() => {
        const ask = eventLinkConfirmation(template, linkConfirm);
        return (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="link-confirm-title">
            <div className="bg-surface border border-border p-6 rounded-xl shadow-2xl max-w-md w-full mx-4 animate-spring-up">
              <h3 id="link-confirm-title" className="text-xl font-bold mb-3 text-foreground">{ask.title}</h3>
              <p className="text-foreground/70 mb-6 leading-relaxed text-sm">{ask.message}</p>
              <div className="flex justify-end gap-3">
                <Button variant="secondary" onClick={() => setLinkConfirm(null)}>Cancel</Button>
                <Button onClick={saveLink}>{ask.confirmLabel}</Button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirming && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center" role="dialog" aria-modal="true">
          <div className="bg-surface border border-border p-6 rounded-xl shadow-2xl max-w-md w-full mx-4 animate-spring-up">
            <h3 className="text-xl font-bold mb-3 text-foreground">Delete this draft?</h3>
            <p className="text-foreground/70 mb-6 leading-relaxed text-sm">
              The draft is deleted from EventReach. It was never sent to WhatsApp. This cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={() => setConfirming(null)}>Cancel</Button>
              <Button variant="danger" onClick={confirm}>Delete</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TemplateDetail;
