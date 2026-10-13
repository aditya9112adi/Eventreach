import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, X, ShieldAlert, AlertTriangle, RotateCcw, FileText, Eye, Pencil } from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../store/authStore';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { PaginationControls } from '../../components/ui/PaginationControls';
import { formatDateTime } from '../../utils/datetime';
import {
  COMMON_TEMPLATE_LANGUAGES,
  EMPTY_FILTERS,
  TEMPLATES_API,
  WHATSAPP_TEMPLATE_CATEGORIES,
  WHATSAPP_TEMPLATE_STATES,
  hasActiveFilters,
  listParams,
  listViewState,
  parseTemplatePage,
  stateDisplay,
  templateActions,
  toApiProblem,
  type ApiProblem,
  type TemplateFilters,
  type TemplatePage,
} from '../../utils/whatsappTemplates';

const SEARCH_DEBOUNCE_MS = 300;
const selectClass =
  'w-full min-w-0 rounded-md border border-border bg-surface/50 px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-white/20 transition-all';

const Templates = () => {
  const { user } = useAuth();
  const [filters, setFilters] = useState<TemplateFilters>(EMPTY_FILTERS);
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [result, setResult] = useState<TemplatePage | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<{ _id: string; eventName: string }[]>([]);

  // Typing settles before the list is fetched again.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((f) => (f.q === searchInput ? f : { ...f, q: searchInput }));
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      const response = await api.get(TEMPLATES_API, { params: listParams(filters, page, limit) });
      setResult(parseTemplatePage(response.data));
    } catch (error) {
      setProblem(toApiProblem(error));
    } finally {
      setLoading(false);
    }
  }, [filters, page, limit]);

  useEffect(() => {
    load();
  }, [load]);

  // For the event filter and the Event column. A failure only leaves ids unnamed.
  useEffect(() => {
    api
      .get('/events', { params: { includeSubEvents: 'true' } })
      .then((response) => setEvents(Array.isArray(response.data) ? response.data : []))
      .catch(() => setEvents([]));
  }, []);

  const eventName = useMemo(() => new Map(events.map((e) => [e._id, e.eventName])), [events]);
  const filtered = hasActiveFilters(filters);
  const view = listViewState({ loading, error: problem, page: result, hasFilters: filtered });

  const setFilter = (key: keyof TemplateFilters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };

  const clearAll = () => {
    setSearchInput('');
    setFilters(EMPTY_FILTERS);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 animate-fade-in">
        <div>
          <h2 className="text-3xl font-sans font-bold text-foreground uppercase tracking-wider">WhatsApp Templates</h2>
          <p className="text-foreground/50 text-sm mt-1">
            Create message templates and submit them to WhatsApp for approval. Meta reviews every template.
          </p>
        </div>
        {view !== 'forbidden' && (
          <Link to="/whatsapp/templates/new">
            <Button><Plus className="w-4 h-4 mr-2" />Create template</Button>
          </Link>
        )}
      </div>

      {view === 'notConfigured' && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-600" role="alert">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <span>{problem?.message} Ask the administrator who manages the deployment.</span>
        </div>
      )}

      <div className="bg-surface rounded-xl border border-border overflow-hidden animate-fade-up stagger-1">
        <div className="p-4 border-b border-border space-y-3">
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40 pointer-events-none" />
              <input
                type="text"
                placeholder="Search by display name or template name..."
                value={searchInput}
                maxLength={100}
                onChange={(e) => setSearchInput(e.target.value)}
                aria-label="Search templates"
                className="w-full rounded-md border border-border bg-surface/50 pl-9 pr-4 py-2.5 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:ring-2 focus:ring-white/20 focus:border-white/40 transition-all duration-200"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <select value={filters.category} onChange={(e) => setFilter('category', e.target.value)} className={selectClass} aria-label="Category">
              <option value="">All categories</option>
              {WHATSAPP_TEMPLATE_CATEGORIES.map((c) => (
                <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>
              ))}
            </select>
            <select value={filters.language} onChange={(e) => setFilter('language', e.target.value)} className={selectClass} aria-label="Language">
              <option value="">All languages</option>
              {COMMON_TEMPLATE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label} ({l.code})</option>
              ))}
            </select>
            <select value={filters.eventId} onChange={(e) => setFilter('eventId', e.target.value)} className={selectClass} aria-label="Event">
              <option value="">All events</option>
              {events.map((e) => (
                <option key={e._id} value={e._id}>{e.eventName}</option>
              ))}
            </select>
            <select value={filters.state} onChange={(e) => setFilter('state', e.target.value)} className={selectClass} aria-label="Status">
              <option value="">All statuses</option>
              {WHATSAPP_TEMPLATE_STATES.map((s) => (
                <option key={s} value={s}>{stateDisplay(s).label}</option>
              ))}
            </select>
            </div>
          </div>
          {filtered && (
            <button onClick={clearAll} className="flex items-center gap-1 text-xs text-foreground/50 hover:text-destructive transition-colors">
              <X className="w-3 h-3" /> Clear all filters
            </button>
          )}
        </div>

        {view === 'loading' && (
          <div className="p-4 space-y-3 animate-pulse" aria-busy="true" aria-label="Loading templates">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-10 rounded bg-foreground/5" />
            ))}
          </div>
        )}

        {view === 'forbidden' && (
          <div className="p-10 text-center space-y-2">
            <ShieldAlert className="w-10 h-10 mx-auto text-foreground/30" />
            <p className="font-semibold text-foreground">You do not have permission to manage WhatsApp templates.</p>
            <p className="text-sm text-foreground/60">A Super Admin can grant it on the Just Access page.</p>
          </div>
        )}

        {view === 'error' && (
          <div className="p-10 text-center space-y-3">
            <p className="text-foreground/70">{problem?.message}</p>
            <Button variant="secondary" onClick={load}><RotateCcw className="w-4 h-4 mr-2" />Try again</Button>
          </div>
        )}

        {view === 'empty' && (
          <div className="p-10 text-center space-y-3">
            <FileText className="w-10 h-10 mx-auto text-foreground/30" />
            <p className="font-semibold text-foreground">No templates yet</p>
            <p className="text-sm text-foreground/60">Create your first template and submit it to WhatsApp for approval.</p>
            <Link to="/whatsapp/templates/new">
              <Button><Plus className="w-4 h-4 mr-2" />Create template</Button>
            </Link>
          </div>
        )}

        {view === 'noMatches' && <div className="p-10 text-center text-foreground/60">No templates match your search or filters.</div>}

        {view === 'ready' && result && (
          <>
            <div className="table-scroll">
              <table className="w-full min-w-[980px] text-left border-collapse">
                <thead>
                  <tr className="bg-surfaceHover text-foreground/60 font-medium border-b border-border uppercase tracking-wide text-xs">
                    <th className="py-3 px-4">Template</th>
                    <th className="py-3 px-4">Category</th>
                    <th className="py-3 px-4">Language</th>
                    <th className="py-3 px-4">Event</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Updated</th>
                    <th className="py-3 px-4">Last checked</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className={loading ? 'opacity-60' : ''}>
                  {result.data.map((t) => {
                    const status = stateDisplay(t.localState);
                    const actions = templateActions(user, t);
                    return (
                      <tr key={t.id} className="border-b border-border/60 hover:bg-surfaceHover/50 text-sm">
                        <td className="py-3 px-4">
                          <div className="font-semibold text-foreground">{t.displayName}</div>
                          <div className="text-xs text-foreground/50 font-mono">{t.name}</div>
                          {!t.ownerAdminId && <div className="text-[10px] uppercase font-bold text-accent mt-0.5">Shared</div>}
                        </td>
                        <td className="py-3 px-4 text-foreground/80">{t.category.charAt(0) + t.category.slice(1).toLowerCase()}</td>
                        <td className="py-3 px-4 text-foreground/80 font-mono text-xs">{t.language}</td>
                        <td className="py-3 px-4 text-foreground/80">
                          {t.eventId ? eventName.get(t.eventId) ?? 'Event' : <span className="text-foreground/40 italic">Reusable</span>}
                        </td>
                        <td className="py-3 px-4">
                          <Badge variant={status.variant} title={t.metaStatus ? `${status.hint} WhatsApp status: ${t.metaStatus}` : status.hint}>
                            {status.label}
                          </Badge>
                        </td>
                        <td className="py-3 px-4 text-xs text-foreground/70">{formatDateTime(t.updatedAt)}</td>
                        <td className="py-3 px-4 text-xs text-foreground/70">{t.lastSyncedAt ? formatDateTime(t.lastSyncedAt) : '—'}</td>
                        <td className="py-3 px-4">
                          <div className="flex justify-end gap-2">
                            <Link to={`/whatsapp/templates/${t.id}`} className="inline-flex items-center px-2.5 py-1.5 bg-accent/10 text-accent hover:bg-accent/20 font-bold uppercase tracking-wide text-[10px] rounded transition-colors">
                              <Eye className="w-3 h-3 mr-1" /> View
                            </Link>
                            {actions.edit && (
                              <Link to={`/whatsapp/templates/${t.id}/edit`} className="inline-flex items-center px-2.5 py-1.5 bg-surfaceHover text-foreground hover:bg-white/10 font-bold uppercase tracking-wide text-[10px] rounded transition-colors">
                                <Pencil className="w-3 h-3 mr-1" /> Edit
                              </Link>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <PaginationControls
              currentPage={result.pagination.page}
              rowsPerPage={limit}
              totalItems={result.pagination.total}
              onPageChange={setPage}
              onRowsChange={(rows) => {
                setLimit(rows);
                setPage(1);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default Templates;
