import { useEffect, useState } from 'react';
import { useAuth } from '../../store/authStore';
import api from '../../services/api';
import { Button } from './Button';
import { useToast } from './Toast';
import { formatDateTime } from '../../utils/datetime';
import { pocSourceLabel, senderChoices, senderSourceLabel, senderStatusNote, type EffectiveSender } from '../../utils/eventContactDisplay';

type Sender = { _id: string; displayPhoneNumber: string; verifiedName: string; enabled: boolean; listedInMeta: boolean; metaStatus: string | null };
type ContactData = { effectiveSender?: EffectiveSender | null; localPoc: { name: string; mobile: string; email?: string; responsibility?: string } | null; localWhatsAppSenderId: string | null; poc: any; whatsappSenderId: string | null; assignmentSource: string; pocSource: string; environmentSenderConfigured?: boolean };

export function EventContactSettings({ eventId, parentEventId }: { eventId: string; parentEventId?: string | null }) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const canEdit = user?.role === 'SuperAdmin' || user?.role === 'Admin';
  const [contact, setContact] = useState<ContactData | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [responsibility, setResponsibility] = useState('');
  const [senderId, setSenderId] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async () => {
    try {
      const [contactRes, senderRes] = await Promise.all([api.get(`/events/${eventId}/contact`), api.get('/whatsapp-senders')]);
      const c = contactRes.data as ContactData;
      setContact(c);
      const poc = c.localPoc;
      setName(poc?.name || ''); setMobile(poc?.mobile || ''); setEmail(poc?.email || '');
      setResponsibility(poc?.responsibility || ''); setSenderId(c.localWhatsAppSenderId || '');
      setSenders(senderRes.data.senders || []);
    } catch { showToast('error', 'Could not load event contact settings.'); }
  };
  useEffect(() => { void load(); }, [eventId]);
  const save = async () => {
    setLoading(true);
    try {
      await api.put(`/events/${eventId}/contact`, {
        poc: name.trim() ? { name: name.trim(), mobile: mobile.trim(), ...(email.trim() ? { email: email.trim() } : {}), ...(responsibility.trim() ? { responsibility: responsibility.trim() } : {}) } : null,
        whatsappSenderId: senderId || null,
      });
      await load(); showToast('success', 'Event contact settings saved.');
    } catch (e: any) { showToast('error', e.response?.data?.error || 'Could not save event contact settings.'); }
    finally { setLoading(false); }
  };
  if (!contact) return <section className="rounded-xl border border-border bg-surface p-6"><p className="text-sm text-foreground/60">Loading contact settings…</p></section>;
  return <section className="rounded-xl border border-border bg-surface p-6 space-y-5">
    <div><h2 className="text-xl font-bold">Point of Contact & WhatsApp Sender</h2><p className="text-sm text-foreground/60 mt-1">POC details are separate from the event organizer. An empty sub-event assignment inherits from its Main Event; otherwise the environment sender is used.</p></div>
    <div className="rounded-lg bg-background border border-border p-4">
      <p className="text-xs uppercase tracking-wide text-foreground/50 mb-2">Effective point of contact {pocSourceLabel(contact.pocSource) ? `(${pocSourceLabel(contact.pocSource)})` : ''}</p>
      {contact.poc ? <p className="font-medium">{contact.poc.name} · {contact.poc.mobile}{contact.poc.email ? ` · ${contact.poc.email}` : ''}{contact.poc.responsibility ? ` · ${contact.poc.responsibility}` : ''}</p> : <p className="text-sm text-foreground/50">No point of contact assigned.</p>}
      <p className="text-xs uppercase tracking-wide text-foreground/50 mt-4 mb-1">Effective sender ({senderSourceLabel(contact.assignmentSource)})</p>
      {contact.effectiveSender && <p className="text-sm font-medium">{contact.effectiveSender.displayPhoneNumber} — {contact.effectiveSender.verifiedName}</p>}
      {(() => {
        const note = senderStatusNote(contact.effectiveSender, contact.assignmentSource, Boolean(contact.environmentSenderConfigured));
        const tone = note.tone === 'ok' ? 'text-accent' : note.tone === 'warning' ? 'text-amber-500' : 'text-foreground/50';
        return <p className={`text-xs mt-1 ${tone}`}>{note.text}{note.checkedAt ? ` (checked ${formatDateTime(note.checkedAt)})` : ''}</p>;
      })()}
    </div>
    {canEdit && <div className="grid md:grid-cols-2 gap-4">
      <label className="text-sm">POC name<input className="mt-1 block w-full rounded-lg border border-border bg-background p-2" value={name} onChange={e => setName(e.target.value)} maxLength={100} placeholder="Contact name" /></label>
      <label className="text-sm">POC mobile (international allowed)<input className="mt-1 block w-full rounded-lg border border-border bg-background p-2" value={mobile} onChange={e => setMobile(e.target.value)} maxLength={40} placeholder="+919876543210" /></label>
      <label className="text-sm">POC email (optional)<input className="mt-1 block w-full rounded-lg border border-border bg-background p-2" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} placeholder="contact@example.com" /></label>
      <label className="text-sm">Responsibility (optional)<input className="mt-1 block w-full rounded-lg border border-border bg-background p-2" value={responsibility} onChange={e => setResponsibility(e.target.value)} maxLength={120} placeholder="Venue coordination" /></label>
      <label className="text-sm md:col-span-2">WhatsApp sender<select className="mt-1 block w-full rounded-lg border border-border bg-background p-2" value={senderId} onChange={e => setSenderId(e.target.value)}><option value="">{parentEventId ? 'Inherit Main Event / environment sender' : 'Use environment sender'}</option>{senderChoices(senders, contact.localWhatsAppSenderId).map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select><span className="text-xs text-foreground/50">Only enabled, listed, CONNECTED senders available to your account can be newly assigned. The status is verified with Meta when you save.</span></label>
      <div className="md:col-span-2"><Button onClick={save} disabled={loading}>{loading ? 'Saving…' : 'Save contact settings'}</Button></div>
    </div>}
  </section>;
}
