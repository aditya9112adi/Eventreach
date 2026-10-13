import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, Info, Lock, Save, ShieldAlert } from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../store/authStore';
import { useToast } from '../../components/ui/Toast';
import { Button } from '../../components/ui/Button';
import { useUnsavedChangesGuard } from '../../components/useUnsavedChangesGuard';
import {
  COMMON_TEMPLATE_LANGUAGES,
  EMPTY_FORM,
  TEMPLATES_API,
  WHATSAPP_TEMPLATE_CATEGORIES,
  WHATSAPP_TEMPLATE_LIMITS,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCES,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCE_LABELS,
  buildTemplatePayload,
  counter,
  formFromTemplate,
  isFormDirty,
  renderPreview,
  suggestTemplateName,
  syncVariableRows,
  templateActions,
  toApiProblem,
  validateForm,
  type ApiProblem,
  type TemplateForm,
  type TemplateView,
  type VariableRow,
} from '../../utils/whatsappTemplates';

interface EventOption {
  _id: string;
  eventName: string;
  adminId?: string | null;
  createdBy?: string | null;
}

interface AdminOption {
  _id: string;
  name: string;
  email: string;
  canManageWhatsAppTemplates?: boolean;
}

const inputClass =
  'block w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent transition-all';
const labelClass = 'block text-[11px] font-bold uppercase tracking-wider text-foreground/60 mb-1.5';

const FieldError = ({ message }: { message?: string }) =>
  message ? <p className="mt-1 text-xs text-destructive" role="alert">{message}</p> : null;

const Counter = ({ value, limit }: { value: string; limit: number }) => {
  const c = counter(value, limit);
  return <span className={`text-[11px] ${c.over ? 'text-destructive font-semibold' : 'text-foreground/40'}`}>{c.used}/{c.limit}</span>;
};

const TemplateEditor = () => {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { showToast } = useToast();
  const isSuperAdmin = user?.role === 'SuperAdmin';

  const [form, setForm] = useState<TemplateForm>(EMPTY_FORM);
  const [saved, setSaved] = useState<TemplateForm>(EMPTY_FORM);
  const [loaded, setLoaded] = useState<TemplateView | null>(null);
  const [loading, setLoading] = useState(isEdit);
  const [loadProblem, setLoadProblem] = useState<ApiProblem | null>(null);
  const [saveProblem, setSaveProblem] = useState<ApiProblem | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [nameTouched, setNameTouched] = useState(isEdit);
  const [languageOther, setLanguageOther] = useState(false);
  const [placeholderError, setPlaceholderError] = useState<string | null>(null);
  const [previewBlankGuest, setPreviewBlankGuest] = useState(false);
  const [events, setEvents] = useState<EventOption[]>([]);
  const [admins, setAdmins] = useState<AdminOption[]>([]);

  const dirty = isFormDirty(form, saved);
  useUnsavedChangesGuard(dirty && !saving);

  useEffect(() => {
    api
      .get('/events', { params: { includeSubEvents: 'true' } })
      .then((response) => setEvents(Array.isArray(response.data) ? response.data : []))
      .catch(() => setEvents([]));
  }, []);

  // A Super Admin may create a template for a particular Admin.
  useEffect(() => {
    if (!isSuperAdmin || isEdit) return;
    api
      .get('/admin/users/access-records')
      .then((response) => {
        const rows = Array.isArray(response.data) ? response.data : [];
        setAdmins(rows.filter((r: any) => r.type === 'Admin' && r.role === 'Admin'));
      })
      .catch(() => setAdmins([]));
  }, [isSuperAdmin, isEdit]);

  useEffect(() => {
    if (!isEdit || !id) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await api.get(`${TEMPLATES_API}/${id}`);
        if (cancelled) return;
        const template: TemplateView = response.data.template;
        const initial = formFromTemplate(template);
        setLoaded(template);
        setForm(initial);
        setSaved(initial);
        setLanguageOther(!COMMON_TEMPLATE_LANGUAGES.some((l) => l.code === template.language));
      } catch (error) {
        if (!cancelled) setLoadProblem(toApiProblem(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, isEdit]);

  /** Events the chosen owner holds - the API refuses another owner's event. */
  const eventOptions = useMemo(() => {
    const owner = isEdit ? loaded?.ownerAdminId ?? '' : isSuperAdmin ? form.ownerAdminId : user?.id ?? '';
    if (!owner) return events;
    return events.filter((e) => String(e.adminId ?? e.createdBy ?? '') === owner);
  }, [events, form.ownerAdminId, isEdit, isSuperAdmin, loaded, user]);

  const update = (patch: Partial<TemplateForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
  };

  const onDisplayName = (value: string) => update(nameTouched ? { displayName: value } : { displayName: value, name: suggestTemplateName(value) });

  const onBody = (value: string) => {
    const sync = syncVariableRows(value, form.variables);
    setPlaceholderError(sync.placeholderError);
    setForm((f) => ({ ...f, body: value, variables: sync.rows }));
    setErrors((e) => {
      const next = { ...e };
      delete next.body;
      return next;
    });
  };

  const updateRow = (position: number, patch: Partial<VariableRow>) => {
    setForm((f) => ({ ...f, variables: f.variables.map((r) => (r.position === position ? { ...r, ...patch } : r)) }));
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[`variables.${position}.${key}`];
      delete next[`variables.${position}`];
      return next;
    });
  };

  const save = async () => {
    setSaveProblem(null);
    const local = validateForm(form);
    if (Object.keys(local).length > 0) {
      setErrors(local);
      return;
    }
    setSaving(true);
    try {
      const payload = buildTemplatePayload(form, { includeOwner: isSuperAdmin && !isEdit });
      const response = isEdit ? await api.patch(`${TEMPLATES_API}/${id}`, payload) : await api.post(TEMPLATES_API, payload);
      const template: TemplateView = response.data.template;
      setSaved(form);
      showToast('success', isEdit ? 'Template saved.' : 'Template created as a draft.');
      navigate(`/whatsapp/templates/${template.id}`);
    } catch (error) {
      const problem = toApiProblem(error);
      setErrors(problem.fieldErrors);
      setSaveProblem(problem);
    } finally {
      setSaving(false);
    }
  };

  const back = (
    <Link to={isEdit ? `/whatsapp/templates/${id}` : '/whatsapp/templates'} className="inline-flex items-center text-sm text-foreground/60 hover:text-foreground">
      <ArrowLeft className="w-4 h-4 mr-1" /> {isEdit ? 'Back to template' : 'Back to templates'}
    </Link>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
      </div>
    );
  }

  if (loadProblem) {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 text-center bg-surface border border-border rounded-xl space-y-3">
        <ShieldAlert className="w-10 h-10 mx-auto text-foreground/30" />
        <p className="font-semibold text-foreground">{loadProblem.message}</p>
        <Link to="/whatsapp/templates" className="text-sm text-accent hover:underline">Back to templates</Link>
      </div>
    );
  }

  // The API accepts edits only to a Draft or a failed submission, by its manager.
  if (isEdit && loaded && !templateActions(user, loaded).edit) {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 text-center bg-surface border border-border rounded-xl space-y-3">
        <Lock className="w-10 h-10 mx-auto text-foreground/30" />
        <p className="font-semibold text-foreground">This template can no longer be edited here.</p>
        <p className="text-sm text-foreground/60">
          Only a draft, or a template whose submission failed, can be edited - and a shared template only by a Super Admin.
        </p>
        <Link to={`/whatsapp/templates/${id}`} className="text-sm text-accent hover:underline">View the template</Link>
      </div>
    );
  }

  const preview = renderPreview(form.body, form.variables, { blankGuestName: previewBlankGuest });
  const hasGuestName = form.variables.some((v) => v.source === 'guest.name');

  return (
    <div className="space-y-6">
      <div className="space-y-2 animate-fade-in">
        {back}
        <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">
          {isEdit ? 'Edit template' : 'Create template'}
        </h2>
        <p className="text-foreground/50 text-sm">Saved as a draft. Submit it to WhatsApp from the template page when it is ready.</p>
      </div>

      {saveProblem && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <span>{saveProblem.message}</span>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
        <div className="space-y-6">
          <section className="bg-surface rounded-xl border border-border p-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className={labelClass} htmlFor="tpl-display-name">Display name</label>
                <input id="tpl-display-name" className={inputClass} value={form.displayName} onChange={(e) => onDisplayName(e.target.value)} placeholder="Wedding invitation" />
                <div className="flex justify-end mt-1"><Counter value={form.displayName} limit={WHATSAPP_TEMPLATE_LIMITS.displayName} /></div>
                <FieldError message={errors.displayName} />
              </div>
              <div>
                <label className={labelClass} htmlFor="tpl-name">Template name (WhatsApp)</label>
                <input
                  id="tpl-name"
                  className={`${inputClass} font-mono`}
                  value={form.name}
                  onChange={(e) => {
                    setNameTouched(true);
                    update({ name: e.target.value });
                  }}
                  placeholder="wedding_invitation"
                />
                <p className="mt-1 text-[11px] text-foreground/40">Lowercase letters, digits and underscores.</p>
                <FieldError message={errors.name} />
              </div>
              <div>
                <label className={labelClass} htmlFor="tpl-language">Language</label>
                <select
                  id="tpl-language"
                  className={inputClass}
                  value={languageOther ? '__other' : form.language}
                  onChange={(e) => {
                    if (e.target.value === '__other') {
                      setLanguageOther(true);
                      update({ language: '' });
                    } else {
                      setLanguageOther(false);
                      update({ language: e.target.value });
                    }
                  }}
                >
                  {COMMON_TEMPLATE_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.label} ({l.code})</option>
                  ))}
                  <option value="__other">Other language code…</option>
                </select>
                {languageOther && (
                  <input
                    className={`${inputClass} font-mono mt-2`}
                    value={form.language}
                    onChange={(e) => update({ language: e.target.value })}
                    placeholder="e.g. pt_BR"
                    aria-label="Language code"
                  />
                )}
                <FieldError message={errors.language} />
              </div>
              <div>
                <label className={labelClass} htmlFor="tpl-category">Category</label>
                <select id="tpl-category" className={inputClass} value={form.category} onChange={(e) => update({ category: e.target.value })}>
                  {WHATSAPP_TEMPLATE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-foreground/40">
                  Meta makes the final category decision. Templates are submitted with category changes turned off, so Meta cannot move it to another category.
                </p>
                <FieldError message={errors.category} />
              </div>
              {isSuperAdmin && !isEdit && (
                <div>
                  <label className={labelClass} htmlFor="tpl-owner">Owner</label>
                  <select id="tpl-owner" className={inputClass} value={form.ownerAdminId} onChange={(e) => update({ ownerAdminId: e.target.value, eventId: '' })}>
                    <option value="">Shared (read-only for Admins)</option>
                    {admins.map((a) => (
                      <option key={a._id} value={a._id}>
                        {a.name} ({a.email}){a.canManageWhatsAppTemplates ? '' : ' - no template access'}
                      </option>
                    ))}
                  </select>
                  <FieldError message={errors.ownerAdminId} />
                </div>
              )}
              <div>
                <label className={labelClass} htmlFor="tpl-event">Event</label>
                <select id="tpl-event" className={inputClass} value={form.eventId} onChange={(e) => update({ eventId: e.target.value })}>
                  <option value="">Reusable across events</option>
                  {eventOptions.map((e) => (
                    <option key={e._id} value={e._id}>{e.eventName}</option>
                  ))}
                </select>
                <FieldError message={errors.eventId} />
              </div>
            </div>
          </section>

          <section className="bg-surface rounded-xl border border-border p-5 space-y-4">
            <div>
              <div className="flex items-center justify-between">
                <label className={labelClass} htmlFor="tpl-header">Header (optional)</label>
                <Counter value={form.headerText} limit={WHATSAPP_TEMPLATE_LIMITS.headerText} />
              </div>
              <input id="tpl-header" className={inputClass} value={form.headerText} onChange={(e) => update({ headerText: e.target.value })} placeholder="You are invited" />
              <p className="mt-1 text-[11px] text-foreground/40">Plain text. Placeholders are not supported in the header.</p>
              <FieldError message={errors.headerText} />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label className={labelClass} htmlFor="tpl-body">Message body</label>
                <Counter value={form.body} limit={WHATSAPP_TEMPLATE_LIMITS.body} />
              </div>
              <textarea
                id="tpl-body"
                className={`${inputClass} min-h-[180px] font-mono`}
                value={form.body}
                onChange={(e) => onBody(e.target.value)}
                placeholder={'Dear {{1}},\n\nYou are invited to …'}
              />
              <p className="mt-1 text-[11px] text-foreground/40">
                Use {'{{1}}'}, {'{{2}}'}, … for values filled in for each guest, numbered in the order they appear.
              </p>
              <FieldError message={placeholderError ?? errors.body} />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <label className={labelClass} htmlFor="tpl-footer">Footer (optional)</label>
                <Counter value={form.footer} limit={WHATSAPP_TEMPLATE_LIMITS.footer} />
              </div>
              <input id="tpl-footer" className={inputClass} value={form.footer} onChange={(e) => update({ footer: e.target.value })} placeholder="With love, the family" />
              <FieldError message={errors.footer} />
            </div>
          </section>

          <section className="bg-surface rounded-xl border border-border p-5 space-y-4">
            <div>
              <h3 className="font-semibold text-foreground">Placeholders</h3>
              <p className="text-xs text-foreground/50">One row for each placeholder in the body. Meta needs an example value for each.</p>
            </div>
            {hasGuestName && (
              <div className="flex items-start gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-foreground/70">
                <Info className="w-4 h-4 shrink-0 text-blue-400" />
                <span>If a guest has no name, "Guest" is used instead - so "Dear {'{{1}}'}," reads "Dear Guest,".</span>
              </div>
            )}
            <FieldError message={errors.variables} />
            {form.variables.length === 0 ? (
              <p className="text-sm text-foreground/50 italic">No placeholders in the body.</p>
            ) : (
              <div className="space-y-4">
                {form.variables.map((row) => {
                  const key = `variables.${row.position}`;
                  return (
                    <div key={row.position} className="rounded-lg border border-border p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-bold text-accent">{`{{${row.position}}}`}</span>
                        <FieldError message={errors[key]} />
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className={labelClass} htmlFor={`${key}.label`}>Name</label>
                          <input id={`${key}.label`} className={inputClass} value={row.label} onChange={(e) => updateRow(row.position, { label: e.target.value })} placeholder="Guest name" />
                          <FieldError message={errors[`${key}.label`]} />
                        </div>
                        <div>
                          <label className={labelClass} htmlFor={`${key}.source`}>Filled with</label>
                          <select id={`${key}.source`} className={inputClass} value={row.source} onChange={(e) => updateRow(row.position, { source: e.target.value as VariableRow['source'] })}>
                            <option value="">Choose…</option>
                            {WHATSAPP_TEMPLATE_VARIABLE_SOURCES.map((s) => (
                              <option key={s} value={s}>{WHATSAPP_TEMPLATE_VARIABLE_SOURCE_LABELS[s]}</option>
                            ))}
                          </select>
                          <FieldError message={errors[`${key}.source`]} />
                        </div>
                        {row.source === 'fixed' && (
                          <div className="md:col-span-2">
                            <label className={labelClass} htmlFor={`${key}.fixedValue`}>Fixed text</label>
                            <input id={`${key}.fixedValue`} className={inputClass} value={row.fixedValue} onChange={(e) => updateRow(row.position, { fixedValue: e.target.value })} />
                            <FieldError message={errors[`${key}.fixedValue`]} />
                          </div>
                        )}
                        <div>
                          <label className={labelClass} htmlFor={`${key}.sample`}>Example for Meta</label>
                          <input id={`${key}.sample`} className={inputClass} value={row.sample} onChange={(e) => updateRow(row.position, { sample: e.target.value })} placeholder="Riya" />
                          <FieldError message={errors[`${key}.sample`]} />
                        </div>
                        {row.source !== 'fixed' && (
                          <div>
                            <label className={labelClass} htmlFor={`${key}.fallback`}>If empty, use (optional)</label>
                            <input
                              id={`${key}.fallback`}
                              className={inputClass}
                              value={row.fallback}
                              onChange={(e) => updateRow(row.position, { fallback: e.target.value })}
                              placeholder={row.source === 'guest.name' ? 'Guest' : ''}
                            />
                            <FieldError message={errors[`${key}.fallback`]} />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <div className="flex justify-end gap-3">
            <Link to={isEdit ? `/whatsapp/templates/${id}` : '/whatsapp/templates'}>
              <Button variant="secondary" type="button">Cancel</Button>
            </Link>
            <Button onClick={save} isLoading={saving} disabled={saving}>
              <Save className="w-4 h-4 mr-2" />{isEdit ? 'Save changes' : 'Save draft'}
            </Button>
          </div>
        </div>

        <aside className="bg-surface rounded-xl border border-border p-5 space-y-3 xl:sticky xl:top-4">
          <h3 className="font-semibold text-foreground">Preview</h3>
          {hasGuestName && (
            <label className="flex items-center gap-2 text-xs text-foreground/70">
              <input type="checkbox" checked={previewBlankGuest} onChange={(e) => setPreviewBlankGuest(e.target.checked)} />
              Show a guest with no name
            </label>
          )}
          <div className="rounded-lg bg-[#e7ffdb] text-[#111b21] p-3 text-sm shadow-sm space-y-2" aria-label="Message preview">
            {form.headerText.trim() && <p className="font-bold">{form.headerText.trim()}</p>}
            <p className="whitespace-pre-wrap break-words">{preview || <span className="text-black/40">Your message appears here.</span>}</p>
            {form.footer.trim() && <p className="text-xs text-black/50">{form.footer.trim()}</p>}
          </div>
          <p className="text-[11px] text-foreground/40">Shown with the example values. Each guest receives their own details.</p>
        </aside>
      </div>
    </div>
  );
};

export default TemplateEditor;
