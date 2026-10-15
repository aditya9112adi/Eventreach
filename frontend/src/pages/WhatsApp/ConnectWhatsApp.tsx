import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, RefreshCw, ShieldCheck, Smartphone, Unplug } from 'lucide-react';
import api from '../../services/api';
import { loadFacebookSdk } from '../../services/facebookSdk';
import { useToast } from '../../components/ui/Toast';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { formatDateTime } from '../../utils/datetime';
import {
  FLOW_DISPLAY,
  ONBOARDING_API,
  assignmentNote,
  codeFromLoginResponse,
  decideSignupOutcome,
  embeddedSignupLoginOptions,
  isValidPin,
  onboardingErrorMessage,
  parseSignupMessage,
  senderStatusDisplay,
  type FlowState,
  type SignupMessage,
} from '../../utils/embeddedSignup';

type Config = { configured: boolean; appId: string | null; configId: string | null; apiVersion: string; missing: string[] };
type ConnectedSender = {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
  phoneNumberIdMasked: string;
  onboardingStatus: string | null;
  metaStatus: string | null;
  qualityRating: string | null;
  nextAction: string | null;
  nextActionMessage: string | null;
  lastError: { message: string; at: string | null } | null;
  enabled: boolean;
  lastVerifiedAt: string | null;
  connectedAt: string | null;
  assignment: { available: boolean; reasons: string[] };
};

/** How long to wait for the popup's message after FB.login answers (it normally arrives first). */
const MESSAGE_GRACE_MS = 3000;

/**
 * "My WhatsApp number": an Admin or Super Admin connects their business's own
 * WhatsApp number through Meta's Embedded Signup, finishes registration, and
 * sees what the server verified. Nothing here decides an outcome: every state
 * shown comes from the server, which checks everything with Meta itself.
 */
export default function ConnectWhatsApp() {
  const { showToast } = useToast();
  const [config, setConfig] = useState<Config | null>(null);
  const [senders, setSenders] = useState<ConnectedSender[]>([]);
  const [flow, setFlow] = useState<FlowState>('idle');
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'error'; text: string } | null>(null);
  const [pins, setPins] = useState<Record<string, string>>({});
  const [busySender, setBusySender] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const lastMessage = useRef<SignupMessage | null>(null);
  const messageWaiters = useRef<Array<() => void>>([]);

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.get(`${ONBOARDING_API}/config`), api.get(`${ONBOARDING_API}/senders`)]);
      setConfig(c.data);
      setSenders(Array.isArray(s.data?.senders) ? s.data.senders : []);
    } catch (error) {
      setNotice({ tone: 'error', text: onboardingErrorMessage(error) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The popup's messages: only Meta's origin, only Embedded Signup messages (parseSignupMessage).
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = parseSignupMessage(event);
      if (!message) return;
      lastMessage.current = message;
      messageWaiters.current.splice(0).forEach((wake) => wake());
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const waitForMessage = () =>
    lastMessage.current
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, MESSAGE_GRACE_MS);
          messageWaiters.current.push(() => {
            window.clearTimeout(timer);
            resolve();
          });
        });

  const connect = async () => {
    if (flow !== 'idle' || !config?.configured) return;
    setNotice(null);
    lastMessage.current = null;
    setFlow('starting');
    let sessionId: string;
    let FB: any;
    try {
      const started = await api.post(`${ONBOARDING_API}/sessions`);
      sessionId = started.data.sessionId;
      FB = await loadFacebookSdk(started.data.appId, started.data.apiVersion);
    } catch (error: any) {
      setFlow('idle');
      // An SDK load failure is our own message; an API failure is the server's.
      setNotice({ tone: 'error', text: error?.response ? onboardingErrorMessage(error) : error instanceof Error ? error.message : onboardingErrorMessage(error) });
      return;
    }

    setFlow('authorizing');
    FB.login(async (response: any) => {
      const code = codeFromLoginResponse(response);
      await waitForMessage();
      const outcome = decideSignupOutcome(code, lastMessage.current);
      try {
        if (outcome.kind === 'complete') {
          setFlow('finishing');
          const result = await api.post(`${ONBOARDING_API}/sessions/${sessionId}/complete`, outcome.body);
          setNotice({ tone: result.data.sender?.onboardingStatus === 'connected' ? 'success' : 'warning', text: result.data.message });
          showToast('success', 'WhatsApp number added.');
        } else if (outcome.kind === 'error') {
          const result = await api.post(`${ONBOARDING_API}/sessions/${sessionId}/error`, outcome.body);
          setNotice({ tone: 'error', text: result.data.message });
        } else if (outcome.kind === 'coexistence_unsupported') {
          await api.post(`${ONBOARDING_API}/sessions/${sessionId}/cancel`, { currentStep: 'COEXISTENCE_UNSUPPORTED' });
          setNotice({ tone: 'warning', text: 'That number is a WhatsApp Business app number. Connecting those is not supported yet, so nothing was connected. Use a number for the WhatsApp Cloud API instead.' });
        } else if (outcome.kind === 'no_number') {
          await api.post(`${ONBOARDING_API}/sessions/${sessionId}/cancel`, { currentStep: 'NO_PHONE_NUMBER' });
          setNotice({ tone: 'warning', text: 'The connection finished without a phone number, so nothing was connected. Start again and add or choose a number.' });
        } else {
          await api.post(`${ONBOARDING_API}/sessions/${sessionId}/cancel`, outcome.body);
          setNotice({ tone: 'warning', text: 'The connection was cancelled or the window was closed. Nothing was connected.' });
        }
      } catch (error) {
        setNotice({ tone: 'error', text: onboardingErrorMessage(error) });
      } finally {
        setFlow('idle');
        void load();
      }
    }, embeddedSignupLoginOptions(config.configId!));
  };

  const register = async (sender: ConnectedSender) => {
    const pin = pins[sender.id] ?? '';
    if (!isValidPin(pin) || busySender) return;
    setBusySender(sender.id);
    setFlow('registering');
    try {
      const result = await api.post(`${ONBOARDING_API}/senders/${sender.id}/register`, { pin: pin.trim() });
      setNotice({ tone: result.data.sender?.onboardingStatus === 'connected' ? 'success' : 'warning', text: result.data.message });
    } catch (error) {
      setNotice({ tone: 'error', text: onboardingErrorMessage(error) });
    } finally {
      // The PIN is never kept after the attempt.
      setPins((p) => ({ ...p, [sender.id]: '' }));
      setBusySender(null);
      setFlow('idle');
      void load();
    }
  };

  const verify = async (sender: ConnectedSender) => {
    if (busySender) return;
    setBusySender(sender.id);
    try {
      await api.post(`${ONBOARDING_API}/senders/${sender.id}/verify`);
      showToast('success', 'Status checked with WhatsApp.');
    } catch (error) {
      setNotice({ tone: 'error', text: onboardingErrorMessage(error) });
    } finally {
      setBusySender(null);
      void load();
    }
  };

  const disconnect = async (senderId: string) => {
    setConfirmDisconnect(null);
    setBusySender(senderId);
    try {
      const result = await api.post(`${ONBOARDING_API}/senders/${senderId}/disconnect`);
      const assigned = Number(result.data?.assignedEvents) || 0;
      showToast(assigned ? 'warning' : 'success', assigned
        ? `Number disconnected. ${assigned} event${assigned === 1 ? ' still uses' : 's still use'} it and will not send until you reconnect it or choose another sender.`
        : 'Number disconnected.');
    } catch (error) {
      setNotice({ tone: 'error', text: onboardingErrorMessage(error) });
    } finally {
      setBusySender(null);
      void load();
    }
  };

  const busy = flow !== 'idle';

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold">My WhatsApp number</h1>
        <p className="text-sm text-foreground/60 mt-1 max-w-2xl">
          Connect your business's own WhatsApp number to EventReach. Meta's window guides you through choosing your business, your WhatsApp account and
          your number. EventReach never sees your Meta password, and connecting a number never sends a message.
        </p>
      </div>

      {config && !config.configured && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700" role="alert">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <span>WhatsApp onboarding is not configured on the server yet (missing {config.missing.join(', ')}). Ask a Super Admin.</span>
        </div>
      )}

      {busy && FLOW_DISPLAY[flow] && (
        <div className="flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm" role="status" aria-live="polite">
          <RefreshCw className="w-4 h-4 animate-spin" /> {FLOW_DISPLAY[flow]}
        </div>
      )}

      {notice && (
        <div
          className={`flex items-start gap-3 rounded-lg border p-4 text-sm ${notice.tone === 'success' ? 'border-accent/30 bg-accent/10' : notice.tone === 'warning' ? 'border-amber-500/30 bg-amber-500/10 text-amber-700' : 'border-destructive/30 bg-destructive/10 text-destructive'}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          {notice.tone === 'success' ? <CheckCircle2 className="w-5 h-5 shrink-0" /> : <AlertTriangle className="w-5 h-5 shrink-0" />}
          <span>{notice.text}</span>
        </div>
      )}

      <section className="rounded-xl border border-border bg-surface p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-accent/10 p-3"><Smartphone className="w-5 h-5 text-accent" /></div>
            <div>
              <h2 className="font-semibold">{senders.length ? 'Connect another number' : 'No number connected yet'}</h2>
              <p className="text-xs text-foreground/50">You need a Meta business account and a phone number that can receive a verification code.</p>
            </div>
          </div>
          <Button onClick={connect} disabled={busy || !config?.configured} isLoading={flow === 'starting' || flow === 'authorizing' || flow === 'finishing'}>
            <Link2 className="w-4 h-4 mr-2" />Connect My WhatsApp Number
          </Button>
        </div>
      </section>

      {senders.map((sender) => {
        const status = senderStatusDisplay(sender.onboardingStatus);
        const needsPin = sender.nextAction === 'register' && (sender.onboardingStatus === 'pending_registration' || sender.onboardingStatus === 'action_required');
        return (
          <section key={sender.id} className="rounded-xl border border-border bg-surface p-5 space-y-4" aria-label={`WhatsApp number ${sender.displayPhoneNumber}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">{sender.verifiedName}</h2>
                <p className="font-mono text-sm text-foreground/70">{sender.displayPhoneNumber}</p>
                <p className="text-xs text-foreground/40">Meta phone number ID {sender.phoneNumberIdMasked}</p>
              </div>
              <Badge variant={status.tone}>{status.label}</Badge>
            </div>
            <p className="text-sm text-foreground/70">{status.description}</p>
            {sender.nextActionMessage && <p className="text-sm text-amber-700">{sender.nextActionMessage}</p>}
            {sender.lastError && <p className="text-xs text-destructive">Last problem: {sender.lastError.message}</p>}
            <dl className="grid gap-2 text-xs text-foreground/60 md:grid-cols-3">
              <div><dt className="font-semibold">WhatsApp status</dt><dd>{sender.metaStatus ?? 'Unknown'}</dd></div>
              <div><dt className="font-semibold">Last checked</dt><dd>{sender.lastVerifiedAt ? formatDateTime(sender.lastVerifiedAt) : 'Not yet'}</dd></div>
              <div><dt className="font-semibold">For events</dt><dd><ShieldCheck className="inline w-3 h-3 mr-1" />{assignmentNote(sender)}</dd></div>
            </dl>

            {needsPin && (
              <div className="rounded-lg border border-border p-3 space-y-2">
                <label className="block text-sm font-semibold" htmlFor={`pin-${sender.id}`}>Two-step verification PIN</label>
                <p className="text-xs text-foreground/50">Six digits. If this number already has two-step verification, enter that PIN; otherwise choose a new one and keep it safe. EventReach does not store it.</p>
                <div className="flex gap-2">
                  <input
                    id={`pin-${sender.id}`}
                    type="password"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    className="w-40 rounded-lg border border-input bg-background px-3 py-2 font-mono tracking-widest"
                    value={pins[sender.id] ?? ''}
                    onChange={(e) => setPins((p) => ({ ...p, [sender.id]: e.target.value.replace(/\D/g, '').slice(0, 6) }))}
                  />
                  <Button onClick={() => register(sender)} disabled={!isValidPin(pins[sender.id] ?? '') || busySender !== null} isLoading={busySender === sender.id && flow === 'registering'}>
                    Finish registration
                  </Button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {sender.onboardingStatus !== 'disconnected' && (
                <Button variant="secondary" onClick={() => verify(sender)} disabled={busySender !== null}><RefreshCw className="w-4 h-4 mr-2" />Check status</Button>
              )}
              {sender.onboardingStatus !== 'disconnected' && (
                <Button variant="ghost" onClick={() => setConfirmDisconnect(sender.id)} disabled={busySender !== null}><Unplug className="w-4 h-4 mr-2" />Disconnect</Button>
              )}
            </div>
          </section>
        );
      })}

      {confirmDisconnect && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" role="alertdialog" aria-modal="true">
          <div className="bg-surface border border-border p-6 rounded-xl shadow-2xl max-w-md w-full">
            <h3 className="text-xl font-bold mb-3">Disconnect this number?</h3>
            <p className="text-sm text-foreground/70 mb-6">EventReach stops using it and erases its stored authorization. Events assigned to it will not send until it is reconnected or another sender is chosen. Nothing changes at Meta.</p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setConfirmDisconnect(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => disconnect(confirmDisconnect)}>Disconnect</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
