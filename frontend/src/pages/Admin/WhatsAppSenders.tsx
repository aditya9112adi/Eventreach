import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/ui/Toast';
import { Button } from '../../components/ui/Button';
import { formatDateTime } from '../../utils/datetime';
import { isStatusFresh, senderRefreshMessage } from '../../utils/eventContactDisplay';

type Sender = {
  _id: string; phoneNumberId: string; wabaId: string; isEnvironmentSender?: boolean; displayPhoneNumber: string;
  verifiedName: string; qualityRating?: string | null; metaStatus?: string | null;
  listedInMeta: boolean; enabled: boolean; pocTestEnabled?: boolean; label?: string; allowedAdminIds: string[];
  lastSyncedAt?: string | null;
  statusCheckedAt?: string | null;
};
type AdminOption = { _id: string; name: string; email: string };

export default function WhatsAppSenders() {
  const [senders, setSenders] = useState<Sender[]>([]);
  const [admins, setAdmins] = useState<AdminOption[]>([]);
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();
  const load = useCallback(async () => {
    try {
      const [senderRes, adminRes] = await Promise.all([
        api.get('/whatsapp-senders'),
        api.get('/admin/users/assignable-admins').catch(() => ({ data: [] })),
      ]);
      setSenders(senderRes.data.senders || []);
      setAdmins((adminRes.data || []).filter((a: any) => a.role === 'Admin'));
    } catch { showToast('error', 'Failed to load WhatsApp senders.'); }
  }, [showToast]);
  useEffect(() => { void load(); }, [load]);

  const sync = async () => {
    setBusy(true);
    try { await api.post('/whatsapp-senders/sync'); await load(); showToast('success', 'Sender list synced from Meta. New senders remain disabled.'); }
    catch (e: any) { showToast('error', e.response?.data?.error || 'Sender sync failed.'); }
    finally { setBusy(false); }
  };
  const save = async (sender: Sender, patch: Partial<Sender>) => {
    try { await api.patch(`/whatsapp-senders/${sender._id}`, patch); await load(); showToast('success', 'Sender settings saved.'); }
    catch (e: any) { showToast('error', e.response?.data?.error || 'Could not save sender settings.'); }
  };
  const refresh = async (sender: Sender) => {
    // Only a real answer from Meta is reported as a refresh (senderRefreshMessage).
    try { const res = await api.post(`/whatsapp-senders/${sender._id}/refresh-status`); await load(); const m = senderRefreshMessage(res.status, res.data); showToast(m.type, m.text); }
    catch (e: any) { await load(); const m = senderRefreshMessage(e.response?.status ?? 0, e.response?.data); showToast(m.type, m.text); }
  };

  return <div className="max-w-6xl mx-auto space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-3xl font-bold">WhatsApp Senders</h1><p className="text-sm text-foreground/60 mt-1">Only phone numbers returned by Meta can be managed here. Newly synced senders start disabled.</p></div>
      <Button onClick={sync} disabled={busy}><RefreshCw className={`w-4 h-4 mr-2 ${busy ? 'animate-spin' : ''}`} />{busy ? 'Syncing…' : 'Sync from Meta'}</Button>
    </div>
    {senders.length === 0 ? <div className="rounded-xl border border-border bg-surface p-8 text-center text-foreground/60">No senders synced yet. Use “Sync from Meta” to discover phone numbers in the configured WhatsApp Business Account.</div> :
      <div className="space-y-4">{senders.map(sender => <section key={sender._id} className="rounded-xl border border-border bg-surface p-5 space-y-4">
        <div className="flex flex-wrap justify-between gap-3"><div className="flex gap-3"><div className="rounded-lg bg-accent/10 p-3 h-fit"><Smartphone className="w-5 h-5 text-accent" /></div><div><h2 className="font-semibold">{sender.displayPhoneNumber} · {sender.verifiedName} {sender.isEnvironmentSender && <span className="text-xs font-normal rounded bg-accent/10 text-accent px-2 py-1 ml-1">Environment sender</span>}</h2><p className="text-xs text-foreground/50 break-all">Phone Number ID: {sender.phoneNumberId}</p><p className="text-sm mt-1">Meta status: <strong>{sender.metaStatus || 'Unknown'}</strong>{sender.metaStatus ? (isStatusFresh(sender.statusCheckedAt) ? ` (checked ${formatDateTime(sender.statusCheckedAt)})` : ' (not verified in the last 15 minutes)') : ''} · Quality: {sender.qualityRating || 'Unknown'} · {sender.listedInMeta ? 'Listed in Meta' : 'Not listed in latest sync'}</p></div></div><Button variant="secondary" onClick={() => refresh(sender)}><RefreshCw className="w-4 h-4 mr-2" />Refresh status</Button></div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm">Internal label<input className="mt-1 block w-full rounded-lg border border-border bg-background p-2" defaultValue={sender.label || ''} onBlur={e => { if (e.target.value !== (sender.label || '')) void save(sender, { label: e.target.value }); }} placeholder="e.g. Wedding Team" /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sender.enabled} onChange={e => void save(sender, { enabled: e.target.checked })} /> Enabled for assignment <span className="text-xs text-foreground/50">(an enabled sender can be assigned and used only while Meta reports it CONNECTED)</span></label>
          <label className="flex items-center gap-2 text-sm md:col-span-2"><input type="checkbox" checked={sender.pocTestEnabled === true} onChange={e => void save(sender, { pocTestEnabled: e.target.checked })} /> POC test sender <span className="text-xs text-foreground/50">(lets the Admins allowed below send approved templates, one at a time, to people who agreed to receive tests - from the Test send page. It is not used for events or campaigns.)</span></label>
        </div>
        <div><p className="text-sm font-medium mb-2"><ShieldCheck className="inline w-4 h-4 mr-1" />Admins allowed to assign this sender</p><div className="flex flex-wrap gap-3">{admins.map(admin => <label key={admin._id} className="flex gap-2 items-center text-sm"><input type="checkbox" checked={sender.allowedAdminIds.includes(admin._id)} onChange={e => { const next = e.target.checked ? [...sender.allowedAdminIds, admin._id] : sender.allowedAdminIds.filter(id => id !== admin._id); void save(sender, { allowedAdminIds: next }); }} />{admin.name || admin.email}</label>)}</div>{admins.length === 0 && <p className="text-xs text-foreground/50">Admin list unavailable or no Admin accounts found.</p>}</div>
      </section>)}</div>}
  </div>;
}
