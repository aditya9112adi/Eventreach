import type { EventOwner } from './eventOwnership';

/**
 * Who may use which WhatsApp sender, for which event - one place, used when a
 * sender is assigned to an event and again at every send (senderResolution).
 *
 * INVENTORY senders (synced from the configured WhatsApp Business Account) keep
 * the existing rule, unchanged: the event's owning Admin must be on the sender's
 * allowed list, and an event owned by a Super Admin cannot use one (decision A).
 *
 * EMBEDDED-SIGNUP senders (a number an account connected itself) belong to the
 * account that connected it. They may be used by:
 *  - events owned by that same account - whether it is an Admin or a Super
 *    Admin. This is the explicit, intended exception to decision A: a Super
 *    Admin's own events may use the number that Super Admin connected, and only
 *    that one; inventory senders stay refused for them;
 *  - events owned by an Admin a Super Admin has put on the sender's allowed list.
 * Nobody else - in particular never another Admin's events because they happen
 * to see the sender.
 *
 * And for either source: a Super Admin must have enabled it, and it must be
 * usable at Meta. Every refusal comes with the reason, so the person sees why a
 * sender is unavailable rather than it simply not being listed.
 */

const ids = (list: unknown): string[] => (Array.isArray(list) ? list.map((id) => String(id)) : []);

export const isEmbeddedSender = (sender: { source?: string | null }) => sender?.source === 'embedded_signup';

/** Whether the event's owner may use this sender at all (ownership and grants only). */
export const ownerMayUseSender = (sender: any, owner: EventOwner): boolean => {
  if (owner.kind === 'unverified') return false;
  const allowed = ids(sender.allowedAdminIds);
  if (isEmbeddedSender(sender)) {
    if (sender.ownerAccountId && String(sender.ownerAccountId) === owner.adminId) return true;
    return owner.kind === 'admin' && allowed.includes(owner.adminId);
  }
  return owner.kind === 'admin' && allowed.includes(owner.adminId);
};

/** The sentence explaining why the event's owner may not use the sender. */
export const ownerRefusal = (sender: any, owner: EventOwner): string => {
  if (owner.kind === 'unverified') return `${owner.reason} An assigned WhatsApp sender is used only for an event with a verified owner.`;
  if (isEmbeddedSender(sender)) {
    return "This WhatsApp number belongs to another account. It can be used only by its owner's events, or by Admins a Super Admin has allowed.";
  }
  if (owner.kind === 'superadmin') {
    return 'This event is owned by a Super Admin, and an inventory WhatsApp sender can be used only by events owned by an Admin on its allowed list. Remove the assignment to send from the default sender.';
  }
  return "The event's owning Admin is not allowed to use this WhatsApp sender.";
};

/**
 * What stops a connected (embedded-signup) number from being used, from what is
 * stored. Empty when nothing stored stands in its way; the live CONNECTED check
 * with Meta happens separately.
 */
export const embeddedSenderProblems = (sender: any, hasCredential: boolean): string[] => {
  const problems: string[] = [];
  switch (sender.onboardingStatus) {
    case 'connected':
      break;
    case 'pending_registration':
      problems.push('This number has not finished registration with WhatsApp yet.');
      break;
    case 'registering':
      problems.push('This number is still being registered with WhatsApp.');
      break;
    case 'action_required':
      problems.push(sender.nextActionMessage || 'WhatsApp reports an action is required for this number.');
      break;
    case 'disconnected':
      problems.push('This number has been disconnected. Its owner must connect it again.');
      break;
    default:
      problems.push('This number has not completed WhatsApp onboarding.');
  }
  if (sender.onboardingStatus !== 'disconnected' && !hasCredential) problems.push('Its stored WhatsApp authorization is missing. Its owner must connect it again.');
  if (!sender.enabled) problems.push('A Super Admin has not enabled this number for events yet.');
  return problems;
};
