import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2, RefreshCw, Send, ShieldAlert, Trash2 } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/ui/Toast';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { formatDateTime } from '../../utils/datetime';
import {
  EMPTY_SELECTION,
  POC_API,
  activeRecipients,
  canPreview,
  canReconcile,
  canSend,
  deliveryDisplay,
  outcomeDisplay,
  parsePocRecipients,
  parsePocSenders,
  parsePocTemplates,
  parsePreview,
  parseTestSends,
  previewRequest,
  problemText,
  retryAdvice,
  selectableTemplates,
  selectionKey,
  sendNoAnswer,
  sendRequest,
  senderSelectable,
  valueErrors,
  type AuditEntryView,
  type PocConfigView,
  type PocRecipientView,
  type PocSenderView,
  type PocTemplateView,
  type PreviewView,
  type Selection,
  type TestSendView,
} from '../../utils/pocTestSend';

const inputClass =
  'block w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all';
const labelClass = 'block text-[11px] font-bold uppercase tracking-wider text-foreground/60 mb-1.5';
const card = 'bg-surface rounded-xl border border-border p-5 space-y-4';

/**
 * Send one approved template to one consenting person from the POC sender.
 * Nothing on this page sends by itself: loading, refreshing and checking
 * status are reads. A message goes out only from "Send test message", for a
 * preview of exactly the current selection, after an explicit confirmation.
 */
const TestSend = () => {
  const { showToast } = useToast();
  const [senders, setSenders] = useState<PocSenderView[]>([]);
  const [config, setConfig] = useState<PocConfigView | null>(null);
  const [recipients, setRecipients] = useState<PocRecipientView[]>([]);
  const [templates, setTemplates] = useState<PocTemplateView[]>([]);
  const [history, setHistory] = useState<TestSendView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [preview, setPreview] = useState<PreviewView | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [acknowledgedDuplicate, setAcknowledgedDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<{ send: TestSendView; message: string; audit: AuditEntryView[]; auditSaved: boolean } | null>(null);
  const [consentForm, setConsentForm] = useState({ phone: '', label: '', consentNote: '', consentConfirmed: false });
  const [recipientProblem, setRecipientProblem] = useState<string | null>(null);

  const loadBasics = useCallback(async () => {
    setLoadError(null);
    try {
      const [s, r, h] = await Promise.all([api.get(`${POC_API}/senders`), api.get(`${POC_API}/recipients`), api.get(`${POC_API}/sends`, { params: { limit: 10 } })]);
      const parsed = parsePocSenders(s.data);
      setSenders(parsed.senders);
      setConfig(parsed.config);
      setRecipients(parsePocRecipients(r.data));
      setHistory(parseTestSends(h.data));
    } catch (error: any) {
      if (error?.response?.status === 403) setForbidden(true);
      else setLoadError(problemText(error));
    }
  }, []);

  useEffect(() => {
    void loadBasics();
  }, [loadBasics]);

  const sender = senders.find((s) => s.id === selection.senderId) ?? null;
  const template = templates.find((t) => t.id === selection.templateId) ?? null;
  const currentKey = selectionKey(selection);
  const errors = useMemo(() => valueErrors(template, selection.values), [template, selection.values]);

  /** Any change to the selection makes an earlier preview and its confirmation void. */
  const changeSelection = (next: Selection) => {
    setSelection(next);
    setPreview(null);
    setPreviewKey(null);
    setConfirmed(false);
    setAcknowledgedDuplicate(false);
    setProblem(null);
  };

  const chooseSender = async (senderId: string) => {
    changeSelection({ ...EMPTY_SELECTION, senderId, recipientId: selection.recipientId });
    setTemplates([]);
    if (!senderId) return;
    try {
      const response = await api.get(`${POC_API}/senders/${senderId}/templates`);
      setTemplates(parsePocTemplates(response.data));
    } catch (error) {
      setProblem(problemText(error));
    }
  };

  const chooseTemplate = (templateId: string) => {
    const chosen = templates.find((t) => t.id === templateId);
    changeSelection({ ...selection, templateId, values: chosen ? chosen.variables.map(() => '') : [] });
  };

  const requestPreview = async () => {
    setBusy(true);
    setProblem(null);
    setResult(null);
    try {
      const response = await api.post(`${POC_API}/preview`, previewRequest(selection));
      const parsed = parsePreview(response.data);
      if (!parsed) {
        setProblem('The preview could not be read. Nothing was sent.');
        return;
      }
      setPreview(parsed);
      setPreviewKey(currentKey);
      setConfirmed(false);
      setAcknowledgedDuplicate(false);
    } catch (error) {
      setPreview(null);
      setProblem(problemText(error));
    } finally {
      setBusy(false);
    }
  };

  const loadDetail = async (id: string) => {
    const response = await api.get(`${POC_API}/sends/${id}`);
    return { send: parseTestSends({ sends: [response.data.send] })[0], audit: (response.data.audit ?? []) as AuditEntryView[] };
  };

  const sendNow = async () => {
    if (!preview || !canSend({ preview, previewKey, currentKey, confirmed, acknowledgedDuplicate, busy })) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await api.post(`${POC_API}/send`, sendRequest(selection, preview, acknowledgedDuplicate));
      const send = parseTestSends({ sends: [response.data.send] })[0];
      let audit: AuditEntryView[] = [];
      try { audit = (await loadDetail(send.id)).audit; } catch { /* the trail can be reloaded from the history */ }
      setResult({ send, message: response.data.message, audit, auditSaved: response.data.audit?.completed !== false });
      // The key is spent: a new message needs a new preview.
      setPreview(null);
      setPreviewKey(null);
      setConfirmed(false);
      setAcknowledgedDuplicate(false);
      showToast(response.data.outcome === 'failed' ? 'error' : response.data.outcome === 'unknown' ? 'warning' : 'info', response.data.message);
      void loadBasics();
    } catch (error) {
      // No answer at all: the message may have been sent. Say so, and point at the history.
      setProblem(problemText(error));
      if (sendNoAnswer(error)) void loadBasics();
    } finally {
      setBusy(false);
    }
  };

  /** A read: asks EventReach what it has recorded. Never sends and never asks Meta to send. */
  const checkStatus = async (id: string) => {
    setBusy(true);
    try {
      const detail = await loadDetail(id);
      setResult((current) => ({ send: detail.send, message: detail.send.message, audit: detail.audit, auditSaved: current?.auditSaved ?? true }));
      void loadBasics();
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setBusy(false);
    }
  };

  const reconcile = async (id: string, resolution: 'received' | 'not_received') => {
    setBusy(true);
    try {
      await api.post(`${POC_API}/sends/${id}/reconcile`, { resolution });
      await checkStatus(id);
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setBusy(false);
    }
  };

  const addRecipient = async () => {
    setRecipientProblem(null);
    try {
      await api.post(`${POC_API}/recipients`, consentForm);
      setConsentForm({ phone: '', label: '', consentNote: '', consentConfirmed: false });
      const response = await api.get(`${POC_API}/recipients`);
      setRecipients(parsePocRecipients(response.data));
      showToast('success', 'Recipient added. Nothing was sent.');
    } catch (error) {
      setRecipientProblem(problemText(error));
    }
  };

  const removeRecipient = async (id: string) => {
    try {
      await api.delete(`${POC_API}/recipients/${id}`);
      if (selection.recipientId === id) changeSelection({ ...selection, recipientId: '' });
      const response = await api.get(`${POC_API}/recipients`);
      setRecipients(parsePocRecipients(response.data));
    } catch (error) {
      setRecipientProblem(problemText(error));
    }
  };

  if (forbidden) {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 text-center bg-surface border border-border rounded-xl space-y-3">
        <ShieldAlert className="w-10 h-10 mx-auto text-foreground/30" />
        <p className="font-semibold text-foreground">You do not have permission to send WhatsApp test messages.</p>
        <Link to="/whatsapp/templates" className="text-sm text-accent hover:underline">Back to templates</Link>
      </div>
    );
  }

  const previewReady = !!preview && previewKey === currentKey;
  const sendReady = canSend({ preview, previewKey, currentKey, confirmed, acknowledgedDuplicate, busy });
  const eligibleSenders = senders.filter(senderSelectable);
  const sendable = selectableTemplates(templates);
  const outcome = result ? outcomeDisplay(result.send.outcome) : null;

  return (
    <div className="space-y-6">
      <div className="space-y-2 animate-fade-in">
        <Link to="/whatsapp/templates" className="inline-flex items-center text-sm text-foreground/60 hover:text-foreground">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to templates
        </Link>
        <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">Test send</h2>
        <p className="text-foreground/50 text-sm max-w-3xl">
          Send one approved template to one person who agreed to receive tests, from the proof-of-concept WhatsApp number. Nothing is sent until you
          review the preview and confirm. Creating or submitting a template never sends a message.
        </p>
      </div>

      {config && config.missing.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700" role="alert">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <span>WhatsApp is not fully configured on the server (missing {config.missing.join(', ')}). Test messages cannot be sent until the administrator who manages the deployment sets it.</span>
        </div>
      )}
      {loadError && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" /><span>{loadError}</span>
          <Button variant="secondary" onClick={loadBasics}>Try again</Button>
        </div>
      )}
      {problem && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" /><span>{problem}</span>
        </div>
      )}

      <section className={card} aria-label="POC sender">
        <h3 className="font-semibold text-foreground">1. POC sender</h3>
        {senders.length === 0 ? (
          <p className="text-sm text-foreground/50">No POC sender is available to you. A Super Admin designates one on the WhatsApp Senders page and adds you to its allowed Admins.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {senders.map((s) => {
              const selectable = senderSelectable(s);
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={!selectable}
                  onClick={() => chooseSender(s.id)}
                  aria-pressed={selection.senderId === s.id}
                  className={`text-left rounded-lg border p-4 transition-colors ${selection.senderId === s.id ? 'border-accent bg-accent/5' : 'border-border'} ${selectable ? 'hover:border-accent/60' : 'opacity-60 cursor-not-allowed'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">{s.label}</span>
                    <Badge variant={s.capabilities.connected ? 'success' : 'warning'}>{s.metaStatus ?? 'Unknown'}</Badge>
                  </div>
                  <p className="font-mono text-sm text-foreground/70 mt-1">{s.displayPhoneNumberMasked}</p>
                  <p className="text-[11px] text-foreground/50 mt-1">
                    {s.statusCheckedAt ? `Status checked ${formatDateTime(s.statusCheckedAt)}${s.statusFresh ? '' : ' (older than 15 minutes: re-checked with WhatsApp before sending)'}` : 'Status not checked yet'}
                  </p>
                  <ul className="text-[11px] mt-2 space-y-0.5">
                    <li className={s.capabilities.inConfiguredAccount ? 'text-accent' : 'text-destructive'}>{s.capabilities.inConfiguredAccount ? '✓' : '✗'} In the configured WhatsApp Business Account</li>
                    <li className={s.capabilities.enabled ? 'text-accent' : 'text-destructive'}>{s.capabilities.enabled ? '✓' : '✗'} Enabled</li>
                    <li className={s.capabilities.allowedForYou ? 'text-accent' : 'text-destructive'}>{s.capabilities.allowedForYou ? '✓' : '✗'} You may use it</li>
                  </ul>
                  {s.reasons.length > 0 && <p className="text-xs text-destructive mt-2">{s.reasons[0]}</p>}
                </button>
              );
            })}
          </div>
        )}
        {senders.length > 0 && eligibleSenders.length === 0 && <p className="text-xs text-foreground/50">None of the POC senders can be used right now.</p>}
      </section>

      <section className={card} aria-label="Template">
        <h3 className="font-semibold text-foreground">2. Approved template</h3>
        {!sender ? (
          <p className="text-sm text-foreground/50">Choose a sender first. Only templates approved in that sender's WhatsApp Business Account are offered.</p>
        ) : templates.length === 0 ? (
          <p className="text-sm text-foreground/50">No templates in this sender's account.</p>
        ) : (
          <>
            <select className={inputClass} value={selection.templateId} onChange={(e) => chooseTemplate(e.target.value)} aria-label="Template">
              <option value="">{sendable.length === 0 ? 'No approved template available' : 'Choose a template'}</option>
              {sendable.map((t) => <option key={t.id} value={t.id}>{t.displayName} · {t.name} ({t.language})</option>)}
            </select>
            {templates.filter((t) => !t.sendable).length > 0 && (
              <details className="text-xs text-foreground/60">
                <summary className="cursor-pointer">{templates.filter((t) => !t.sendable).length} template(s) that cannot be sent, and why</summary>
                <ul className="mt-2 space-y-1">
                  {templates.filter((t) => !t.sendable).map((t) => <li key={t.id}><span className="font-mono">{t.name}</span>: {t.reasons[0] ?? 'Not available.'}</li>)}
                </ul>
              </details>
            )}
          </>
        )}
      </section>

      <section className={card} aria-label="Recipient">
        <h3 className="font-semibold text-foreground">3. Recipient who agreed to receive tests</h3>
        {activeRecipients(recipients).length === 0 ? (
          <p className="text-sm text-foreground/50">No recipients yet. Add someone below, recording how they agreed.</p>
        ) : (
          <ul className="space-y-2">
            {activeRecipients(recipients).map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
                <label className="flex items-start gap-2 flex-1">
                  <input type="radio" name="recipient" checked={selection.recipientId === r.id} onChange={() => changeSelection({ ...selection, recipientId: r.id })} className="mt-1" />
                  <span>
                    <span className="font-semibold text-foreground">{r.label}</span> <span className="font-mono text-foreground/60">{r.phoneMasked}</span>
                    <span className="block text-xs text-foreground/50">Consent: {r.consentNote}</span>
                  </span>
                </label>
                <button type="button" className="text-foreground/50 hover:text-destructive" aria-label={`Remove ${r.label}`} onClick={() => removeRecipient(r.id)}><Trash2 className="w-4 h-4" /></button>
              </li>
            ))}
          </ul>
        )}
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-sm font-semibold text-foreground">Add a recipient</summary>
          <div className="grid gap-3 md:grid-cols-2 mt-3">
            <div><label className={labelClass} htmlFor="rc-label">Name</label><input id="rc-label" className={inputClass} value={consentForm.label} onChange={(e) => setConsentForm({ ...consentForm, label: e.target.value })} /></div>
            <div><label className={labelClass} htmlFor="rc-phone">Mobile number</label><input id="rc-phone" className={inputClass} inputMode="tel" value={consentForm.phone} onChange={(e) => setConsentForm({ ...consentForm, phone: e.target.value })} placeholder="9876543210" /></div>
            <div className="md:col-span-2"><label className={labelClass} htmlFor="rc-note">How they agreed</label><input id="rc-note" className={inputClass} value={consentForm.consentNote} onChange={(e) => setConsentForm({ ...consentForm, consentNote: e.target.value })} placeholder="Agreed by message on 12 Oct" /></div>
            <label className="md:col-span-2 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={consentForm.consentConfirmed} onChange={(e) => setConsentForm({ ...consentForm, consentConfirmed: e.target.checked })} /><span>This person agreed to receive WhatsApp test messages from this number.</span></label>
          </div>
          {recipientProblem && <p className="text-xs text-destructive mt-2" role="alert">{recipientProblem}</p>}
          <div className="mt-3"><Button variant="secondary" onClick={addRecipient} disabled={!consentForm.consentConfirmed}>Add recipient</Button></div>
        </details>
      </section>

      {template && (
        <section className={card} aria-label="Values">
          <h3 className="font-semibold text-foreground">4. Values</h3>
          {template.variables.length === 0 ? (
            <p className="text-sm text-foreground/50">This template has no placeholders.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {template.variables.map((v, i) => (
                <div key={v.position}>
                  <label className={labelClass} htmlFor={`val-${i}`}>{`{{${v.position}}}`} {v.label}</label>
                  <input id={`val-${i}`} className={inputClass} value={selection.values[i] ?? ''} placeholder={v.sample} onChange={(e) => changeSelection({ ...selection, values: selection.values.map((x, j) => (j === i ? e.target.value : x)) })} />
                  {selection.values[i] ? errors[i] && <p className="mt-1 text-xs text-destructive" role="alert">{errors[i]}</p> : null}
                </div>
              ))}
            </div>
          )}
          <Button onClick={requestPreview} disabled={!canPreview(selection, template, busy)} isLoading={busy && !previewReady}>Preview (sends nothing)</Button>
        </section>
      )}

      {previewReady && preview && (
        <section className={`${card} border-accent/40`} aria-label="Preview">
          <h3 className="font-semibold text-foreground">5. Review and confirm</h3>
          <dl className="grid gap-2 text-sm md:grid-cols-3">
            <div><dt className={labelClass}>From</dt><dd>{preview.preview.sender.label} <span className="font-mono text-foreground/60">{preview.preview.sender.numberMasked}</span></dd></div>
            <div><dt className={labelClass}>To</dt><dd>{preview.preview.recipient.label} <span className="font-mono text-foreground/60">{preview.preview.recipient.numberMasked}</span></dd></div>
            <div><dt className={labelClass}>Template</dt><dd><span className="font-mono">{preview.preview.template.name}</span> ({preview.preview.template.language}) · {preview.preview.template.status}</dd></div>
          </dl>
          <div className="rounded-lg bg-[#e7ffdb] text-[#111b21] p-3 text-sm shadow-sm space-y-2 max-w-md" aria-label="Message preview">
            <p className="whitespace-pre-wrap break-words">{preview.preview.renderedBody}</p>
            {preview.preview.footer && <p className="text-xs text-black/50">{preview.preview.footer}</p>}
          </div>
          {preview.preview.buttons.length > 0 && <p className="text-xs text-foreground/60">Buttons: {preview.preview.buttons.map((b) => b.text).join(', ')}</p>}
          {preview.duplicateRisk && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 space-y-2" role="alert">
              <p>An earlier attempt at this same message ({preview.duplicateRisk.state}) {preview.duplicateRisk.state === 'Accepted' ? 'was accepted a few minutes ago' : 'has no clear result and may have arrived'}. Sending again could deliver it twice.</p>
              <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={acknowledgedDuplicate} onChange={(e) => setAcknowledgedDuplicate(e.target.checked)} /><span>I understand it may be delivered twice and want to send it again.</span></label>
            </div>
          )}
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I have reviewed this message and want to send it now to {preview.preview.recipient.label}.</span>
          </label>
          <Button onClick={sendNow} disabled={!sendReady} isLoading={busy}><Send className="w-4 h-4 mr-2" />Send test message</Button>
        </section>
      )}

      {result && outcome && (
        <section className={`${card} ${outcome.tone === 'error' ? 'border-destructive/40' : outcome.tone === 'warning' ? 'border-amber-500/40' : 'border-accent/40'}`} aria-label="Result" role="status">
          <div className="flex items-center gap-2">
            {outcome.tone === 'success' || result.send.outcome === 'accepted' ? <CheckCircle2 className="w-5 h-5 text-accent" /> : <AlertTriangle className="w-5 h-5" />}
            <h3 className="font-semibold text-foreground">Result</h3>
            <Badge variant={outcome.variant}>{outcome.label}</Badge>
          </div>
          <p className="text-sm text-foreground/80">{result.message}</p>
          <dl className="grid gap-2 text-sm md:grid-cols-3">
            <div><dt className={labelClass}>Message ID</dt><dd className="font-mono break-all">{result.send.messageId ?? 'None: WhatsApp gave none'}</dd></div>
            <div><dt className={labelClass}>Delivery</dt><dd><Badge variant={deliveryDisplay(result.send.delivery).variant}>{deliveryDisplay(result.send.delivery).label}</Badge></dd></div>
            <div><dt className={labelClass}>To</dt><dd className="font-mono">{result.send.recipient.numberMasked}</dd></div>
          </dl>
          {result.send.errorCategory && <p className="text-xs text-destructive">Reason: {result.send.errorCategory}{result.send.metaErrorCode ? ` (WhatsApp code ${result.send.metaErrorCode})` : ''}</p>}
          {!result.auditSaved && <p className="text-xs text-amber-600" role="alert">The final audit entry could not be saved. The result above is what WhatsApp returned.</p>}
          <p className="text-xs text-foreground/50">{retryAdvice(result.send).text}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => checkStatus(result.send.id)} disabled={busy}><RefreshCw className="w-4 h-4 mr-2" />Check delivery status</Button>
            {canReconcile(result.send) && (
              <>
                <Button variant="secondary" onClick={() => reconcile(result.send.id, 'received')} disabled={busy}>They received it</Button>
                <Button variant="secondary" onClick={() => reconcile(result.send.id, 'not_received')} disabled={busy}>They did not receive it</Button>
              </>
            )}
          </div>
          {result.audit.length > 0 && (
            <div>
              <h4 className={labelClass}>Audit trail</h4>
              <ol className="space-y-1 text-xs text-foreground/70">
                {result.audit.map((a, i) => <li key={`${a.at}-${i}`}>{formatDateTime(a.at)} · {a.description}{a.by ? ` · ${a.by}` : ''}</li>)}
              </ol>
            </div>
          )}
        </section>
      )}

      <section className={card} aria-label="History">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-foreground">Recent test sends</h3>
          <Button variant="secondary" onClick={loadBasics} disabled={busy}><RefreshCw className="w-4 h-4 mr-2" />Refresh</Button>
        </div>
        {history.length === 0 ? (
          <p className="text-sm text-foreground/50">No test messages yet.</p>
        ) : (
          <ul className="divide-y divide-border/50">
            {history.map((h) => (
              <li key={h.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span><span className="font-mono">{h.template.name}</span> → <span className="font-mono">{h.recipient.numberMasked}</span> <span className="text-xs text-foreground/50">{formatDateTime(h.claimedAt)}</span></span>
                <span className="flex items-center gap-2">
                  <Badge variant={outcomeDisplay(h.outcome).variant}>{outcomeDisplay(h.outcome).label}</Badge>
                  {h.delivery && <Badge variant={deliveryDisplay(h.delivery).variant}>{deliveryDisplay(h.delivery).label}</Badge>}
                  <button type="button" className="text-xs text-accent hover:underline" onClick={() => checkStatus(h.id)}>Details</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

export default TestSend;
