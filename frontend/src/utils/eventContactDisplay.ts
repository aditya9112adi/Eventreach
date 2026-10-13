/**
 * What the event contact panel says about its point of contact and WhatsApp
 * sender. Pure, so it is tested without a browser
 * (frontend/src/utils/eventContactDisplay.test.ts).
 */

export type AssignmentSource = 'event' | 'main-event' | 'environment';
export type PocSource = 'event' | 'main-event' | 'none';

export interface EffectiveSender {
  _id?: string;
  displayPhoneNumber: string;
  verifiedName: string;
  metaStatus: string | null;
  enabled?: boolean;
  listedInMeta?: boolean;
  statusCheckedAt?: string | null;
  statusFresh?: boolean;
}

export interface SenderOption {
  _id: string;
  displayPhoneNumber: string;
  verifiedName: string;
  enabled: boolean;
  listedInMeta: boolean;
  metaStatus: string | null;
}

/** Same rule as the server (whatsappSenderPolicy): fresh for under 15 minutes. */
export const SENDER_STATUS_FRESHNESS_MS = 15 * 60 * 1000;
export const isStatusFresh = (checkedAt: string | null | undefined, now = Date.now()): boolean => {
  const at = checkedAt ? new Date(checkedAt).getTime() : NaN;
  return Number.isFinite(at) && now - at < SENDER_STATUS_FRESHNESS_MS;
};

export const senderSourceLabel = (source: string): string =>
  source === 'event' ? 'Assigned to this event'
    : source === 'main-event' ? 'Inherited from the Main Event'
      : 'Default environment sender';

export const pocSourceLabel = (source: string): string =>
  source === 'event' ? 'Set on this event'
    : source === 'main-event' ? 'Inherited from the Main Event'
      : '';

export type NoteTone = 'ok' | 'warning' | 'muted';

/**
 * The sender's state, worded so that nothing unverified reads as working:
 * CONNECTED is shown as connected only when it was confirmed within the
 * freshness window, and only for a listed sender (enabled too, unless it is
 * the environment sender, which needs no enabling to send as it does today).
 */
export const senderStatusNote = (
  sender: EffectiveSender | null | undefined,
  source: string,
  environmentSenderConfigured: boolean
): { tone: NoteTone; text: string; checkedAt: string | null } => {
  if (!sender) {
    if (source === 'environment') {
      return environmentSenderConfigured
        ? { tone: 'muted', text: 'The environment sender has not been synced from Meta yet, so its number and name are not available.', checkedAt: null }
        : { tone: 'warning', text: 'No environment sender is configured on the server.', checkedAt: null };
    }
    return { tone: 'warning', text: 'The assigned sender was not found in the sender inventory.', checkedAt: null };
  }
  if (sender.listedInMeta === false) return { tone: 'warning', text: "Not listed in Meta's latest sync.", checkedAt: null };
  if (source !== 'environment' && sender.enabled === false) return { tone: 'warning', text: 'Disabled in the sender inventory.', checkedAt: null };
  if (!sender.metaStatus) return { tone: 'muted', text: 'Status unknown.', checkedAt: null };
  if (!sender.statusFresh) {
    return { tone: 'warning', text: `Last known status ${sender.metaStatus}, not verified in the last 15 minutes.`, checkedAt: sender.statusCheckedAt ?? null };
  }
  if (sender.metaStatus === 'CONNECTED') return { tone: 'ok', text: 'Connected', checkedAt: sender.statusCheckedAt ?? null };
  return { tone: 'warning', text: `Meta status: ${sender.metaStatus}.`, checkedAt: sender.statusCheckedAt ?? null };
};

/**
 * Senders offered in the dropdown: those that can be assigned now, plus the
 * event's current local assignment even if it no longer qualifies - so the
 * form never silently shows a different choice than the one stored.
 */
export const senderChoices = (senders: SenderOption[], localSenderId: string | null) => {
  const assignable = senders.filter((s) => s.enabled && s.listedInMeta && s.metaStatus === 'CONNECTED');
  const choices = assignable.map((s) => ({ value: s._id, label: `${s.displayPhoneNumber} — ${s.verifiedName}`, available: true }));
  if (localSenderId && !assignable.some((s) => s._id === localSenderId)) {
    const current = senders.find((s) => s._id === localSenderId);
    choices.unshift({
      value: localSenderId,
      label: current ? `${current.displayPhoneNumber} — ${current.verifiedName} (current, not available for new assignment)` : 'Current sender (not available for new assignment)',
      available: false,
    });
  }
  return choices;
};
