import { useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import {
  EVENT_BUSINESS_ID_PLACEHOLDER,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCES,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCE_LABELS,
} from '@eventreach/shared';
import api from '../../services/api';
import { Button } from '../../components/ui/Button';
import { TEMPLATES_API, toApiProblem, type AccountTemplateView } from '../../utils/whatsappTemplates';
import {
  buildLinkRequest,
  createSingleFlight,
  headerNote,
  initialLinkForm,
  linkBlockers,
  validateLinkForm,
  withSource,
  type LinkForm,
} from '../../utils/linkMetaTemplate';

/**
 * "Link to EventReach": records a template that already exists, approved, at WhatsApp as an EventReach template tied
 * to one event, so the Message tab can offer it for that event.
 *
 * What it asks for is only what WhatsApp cannot tell us: the event (by its Event ID) and what fills each placeholder.
 * The server reads the template from WhatsApp itself and decides; nothing is created, changed or resubmitted there.
 */

interface LinkMetaTemplateDialogProps {
  template: AccountTemplateView;
  onClose: () => void;
  /** Called with the server's answer ({ template, created, changed, previousEventId }) once the link is made. */
  onLinked: (result: any) => void;
}

const inputClass =
  'block w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent';

const FieldError = ({ message }: { message?: string }) =>
  message ? <p className="mt-1 text-xs text-destructive" role="alert">{message}</p> : null;

export const LinkMetaTemplateDialog = ({ template, onClose, onLinked }: LinkMetaTemplateDialogProps) => {
  const [form, setForm] = useState<LinkForm>(() => initialLinkForm(template));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  // `busy` shows the wait; this stops a second click made before the next render, when `busy` is still false.
  const [singleFlight] = useState(createSingleFlight);
  const blockers = linkBlockers(template);
  const note = headerNote(template.headerFormat);

  const clear = (...keys: string[]) =>
    setErrors((current) => {
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });

  const submit = () => singleFlight(send);

  const send = async () => {
    if (busy || blockers.length > 0) return;
    const problems = validateLinkForm(form);
    setErrors(problems);
    setBanner('');
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    try {
      const response = await api.post(`${TEMPLATES_API}/link-meta`, buildLinkRequest(template, form));
      onLinked(response.data);
    } catch (error) {
      // A refusal from the server lands on the same field when it names one, and is also said in words above.
      const problem = toApiProblem(error);
      setErrors(problem.fieldErrors);
      setBanner(problem.message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="link-meta-title">
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-full overflow-y-auto animate-spring-up">
        <div className="p-5 border-b border-border flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 id="link-meta-title" className="text-xl font-bold text-foreground">Link to EventReach</h3>
            <p className="text-sm text-foreground/60 mt-1 break-words">
              <span className="font-mono">{template.name}</span> · {template.language}
              {template.category ? ` · ${template.category.charAt(0) + template.category.slice(1).toLowerCase()}` : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-foreground/50 hover:text-foreground" disabled={busy}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <form
          className="p-5 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {banner && (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{banner}</span>
            </div>
          )}

          {blockers.length > 0 && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-400 space-y-1" role="alert">
              <p className="font-semibold">This template cannot be linked:</p>
              <ul className="list-disc pl-5">{blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </div>
          )}

          <div className="rounded-lg border border-border bg-background p-3 space-y-2">
            {template.headerText && <p className="text-sm font-semibold text-foreground">{template.headerText}</p>}
            <p className="text-sm text-foreground whitespace-pre-wrap break-words">{template.bodyText}</p>
            {template.footerText && <p className="text-xs text-foreground/50">{template.footerText}</p>}
            {note && <p className="text-xs text-accent">{note}</p>}
          </div>

          <div>
            <label htmlFor="link-event-id" className="block text-[11px] font-bold uppercase tracking-wider text-foreground/60 mb-1.5">
              Event ID <span className="text-destructive" aria-hidden="true">*</span>
            </label>
            <input
              id="link-event-id"
              className={`${inputClass} font-mono`}
              value={form.eventId}
              onChange={(e) => {
                setForm((f) => ({ ...f, eventId: e.target.value }));
                clear('eventId');
              }}
              onBlur={() => form.eventId !== form.eventId.trim() && setForm((f) => ({ ...f, eventId: f.eventId.trim() }))}
              placeholder={EVENT_BUSINESS_ID_PLACEHOLDER}
              required
              aria-required="true"
              aria-invalid={errors.eventId ? true : undefined}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            <p className="mt-1 text-[11px] text-foreground/40">The event this template will be offered for. It can be moved to another event later.</p>
            <FieldError message={errors.eventId} />
          </div>

          {form.rows.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-foreground">What fills each placeholder</p>
              {form.rows.map((row) => {
                const key = `variables.${row.position}`;
                return (
                  <div key={row.position} className="grid grid-cols-1 sm:grid-cols-[3.5rem_1fr_1fr] gap-2 items-start">
                    <span className="font-mono text-sm text-foreground/60 pt-2">{`{{${row.position}}}`}</span>
                    <div>
                      <input
                        className={inputClass}
                        value={row.label}
                        aria-label={`Name of {{${row.position}}}`}
                        placeholder="Name (e.g. Guest name)"
                        onChange={(e) => {
                          setForm((f) => ({ ...f, rows: f.rows.map((r) => (r.position === row.position ? { ...r, label: e.target.value } : r)) }));
                          clear(`${key}.label`);
                        }}
                        disabled={busy}
                      />
                      <FieldError message={errors[`${key}.label`]} />
                    </div>
                    <div>
                      <select
                        className={inputClass}
                        value={row.source}
                        aria-label={`What fills {{${row.position}}}`}
                        onChange={(e) => {
                          setForm((f) => ({ ...f, rows: f.rows.map((r) => (r.position === row.position ? withSource(r, e.target.value as typeof row.source) : r)) }));
                          clear(`${key}.source`, `${key}.label`);
                        }}
                        disabled={busy}
                      >
                        <option value="">Choose…</option>
                        {WHATSAPP_TEMPLATE_VARIABLE_SOURCES.map((source) => (
                          <option key={source} value={source}>{WHATSAPP_TEMPLATE_VARIABLE_SOURCE_LABELS[source]}</option>
                        ))}
                      </select>
                      <FieldError message={errors[`${key}.source`]} />
                      {row.source === 'fixed' && (
                        <>
                          <input
                            className={`${inputClass} mt-2`}
                            value={row.fixedValue}
                            aria-label={`Fixed text for {{${row.position}}}`}
                            placeholder="Text sent to every guest"
                            onChange={(e) => {
                              setForm((f) => ({ ...f, rows: f.rows.map((r) => (r.position === row.position ? { ...r, fixedValue: e.target.value } : r)) }));
                              clear(`${key}.fixedValue`);
                            }}
                            disabled={busy}
                          />
                          <FieldError message={errors[`${key}.fixedValue`]} />
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <p className="text-xs text-foreground/50">
            EventReach keeps its own record of this template, exactly as WhatsApp approved it. Nothing is created, changed or resubmitted at WhatsApp.
            The Message tab will still offer it only while it is approved, and send only for an upcoming event.
          </p>

          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || blockers.length > 0} isLoading={busy}>Link to EventReach</Button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
};
