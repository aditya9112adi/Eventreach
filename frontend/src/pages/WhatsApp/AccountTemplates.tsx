import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CloudDownload, RefreshCw } from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../store/authStore';
import { useToast } from '../../components/ui/Toast';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { formatDateTime } from '../../utils/datetime';
import { canOfferLink, linkToast, markLinked } from '../../utils/linkMetaTemplate';
import { LinkMetaTemplateDialog } from './LinkMetaTemplateDialog';
import {
  TEMPLATES_API,
  accountListParams,
  accountUsabilityNote,
  appendAccountPage,
  metaStatusDisplay,
  parseAccountPage,
  toApiProblem,
  type AccountPage,
  type AccountTemplateView,
  type ApiProblem,
} from '../../utils/whatsappTemplates';

/**
 * The WhatsApp Business Account's own list of templates, read from Meta only
 * when the person asks - never on page load, never on a timer. It is a view of
 * Meta's records: nothing here is created, changed or sent, and a template
 * shows as usable from EventReach only when EventReach also holds it as
 * approved.
 *
 * An approved template EventReach does not hold can be linked to an event ("Link to EventReach"): EventReach then
 * records it, as WhatsApp approved it, so the Message tab can offer it for that event. That reads from WhatsApp too;
 * nothing is created, changed or resubmitted there.
 */
const AccountTemplates = () => {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [page, setPage] = useState<AccountPage | null>(null);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState<AccountTemplateView | null>(null);

  /** The row becomes "Open in EventReach" straight away, from the server's answer, without asking WhatsApp again. */
  const linked = (result: any) => {
    const target = linking;
    setLinking(null);
    if (target && typeof result?.template?.id === 'string') {
      setPage((current) => (current ? { ...current, templates: current.templates.map((t) => (t.id === target.id ? markLinked(t, result.template.id) : t)) } : current));
    }
    const toast = linkToast(result ?? {});
    showToast(toast.type, toast.message);
  };

  const load = async (cursor: string | null) => {
    setLoading(true);
    setProblem(null);
    try {
      const response = await api.get(`${TEMPLATES_API}/meta`, { params: accountListParams(cursor) });
      const next = parseAccountPage(response.data);
      setPage((current) => (cursor ? appendAccountPage(current, next) : next));
    } catch (error) {
      // A failed load keeps what was already shown.
      setProblem(toApiProblem(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden animate-fade-up">
      <div className="p-4 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-foreground">Templates at WhatsApp</h3>
          <p className="text-xs text-foreground/50">
            Meta's own list for the configured Business Account, read when you ask. Statuses here are Meta's; EventReach changes nothing.
          </p>
        </div>
        <div className="flex gap-2">
          {page ? (
            <Button variant="secondary" onClick={() => load(null)} disabled={loading} isLoading={loading}>
              <RefreshCw className="w-4 h-4 mr-2" />Refresh from WhatsApp
            </Button>
          ) : (
            <Button onClick={() => load(null)} disabled={loading} isLoading={loading}>
              <CloudDownload className="w-4 h-4 mr-2" />Load from WhatsApp
            </Button>
          )}
        </div>
      </div>

      {problem && (
        <div className="m-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <span>{problem.message}</span>
        </div>
      )}

      {!page && !problem && <p className="p-6 text-sm text-foreground/50">Nothing has been requested from WhatsApp yet.</p>}

      {page && (
        <>
          <p className="px-4 pt-3 text-[11px] text-foreground/40">
            {page.fetchedAt ? `Read from WhatsApp at ${formatDateTime(page.fetchedAt)}. ` : ''}
            {page.templates.length} shown{page.nextCursor ? ', more available' : ''}.
            {page.skipped > 0 ? ` ${page.skipped} entr${page.skipped === 1 ? 'y' : 'ies'} could not be read and ${page.skipped === 1 ? 'was' : 'were'} skipped.` : ''}
          </p>
          {page.templates.length === 0 ? (
            <p className="p-6 text-sm text-foreground/50">WhatsApp lists no templates for this account.</p>
          ) : (
            <div className="table-scroll">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-foreground/50 border-b border-border">
                    <th className="py-2 px-4">Template</th>
                    <th className="py-2 px-4">Language</th>
                    <th className="py-2 px-4">Category</th>
                    <th className="py-2 px-4">Status at Meta</th>
                    <th className="py-2 px-4">In EventReach</th>
                  </tr>
                </thead>
                <tbody>
                  {page.templates.map((t) => {
                    const status = metaStatusDisplay(t.status);
                    const note = accountUsabilityNote(t);
                    return (
                      <tr key={t.id} className="border-b border-border/50 last:border-0 align-top">
                        <td className="py-3 px-4">
                          <span className="font-mono text-foreground">{t.name}</span>
                          {t.bodyText && <p className="text-xs text-foreground/50 mt-1 line-clamp-2 max-w-md">{t.bodyText}</p>}
                          {t.rejectedReason && t.rejectedReason !== 'NONE' && <p className="text-xs text-destructive mt-1">Reason: {t.rejectedReason}</p>}
                        </td>
                        <td className="py-3 px-4 font-mono">{t.language}</td>
                        <td className="py-3 px-4">{t.category ? t.category.charAt(0) + t.category.slice(1).toLowerCase() : '—'}</td>
                        <td className="py-3 px-4"><Badge variant={status.variant}>{status.label}</Badge></td>
                        <td className="py-3 px-4 text-xs">
                          {t.localTemplateId ? (
                            <Link to={`/whatsapp/templates/${t.localTemplateId}`} className="text-accent hover:underline">Open in EventReach</Link>
                          ) : (
                            <span className="text-foreground/50">Not in EventReach</span>
                          )}
                          {t.sendableFromHere ? (
                            <p className="text-accent mt-1">Approved here and at Meta</p>
                          ) : (
                            note && <p className="text-foreground/50 mt-1 max-w-xs">{note}</p>
                          )}
                          {canOfferLink(t, user) && (
                            <button type="button" className="mt-2 text-accent hover:underline font-semibold" onClick={() => setLinking(t)}>
                              Link to EventReach
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {page.nextCursor && (
            <div className="p-4 border-t border-border flex justify-center">
              <Button variant="secondary" onClick={() => load(page.nextCursor)} disabled={loading} isLoading={loading}>Load more</Button>
            </div>
          )}
        </>
      )}
      {linking && <LinkMetaTemplateDialog template={linking} onClose={() => setLinking(null)} onLinked={linked} />}
    </div>
  );
};

export default AccountTemplates;
