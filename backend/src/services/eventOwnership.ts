import mongoose from 'mongoose';
import { Admin } from '../models/Admin';
import { Event } from '../models/Event';

/**
 * Who owns an event, for the rules that hinge on the owner rather than on the
 * caller: which Admin's sender allowlist governs it (Stage 6b, decision A),
 * and who may edit its POC and sender (decision B).
 *
 * Read from how events are actually created (eventController):
 *  - an Admin's event carries adminId = that Admin;
 *  - a User's event carries adminId = the User's managing Admin;
 *  - a Super Admin's event has no adminId and createdBy = the Super Admin;
 *  - a Sub-Event copies its Main Event's adminId, and belongs to it.
 * Nothing edits adminId afterwards.
 *
 * So the owner is adminId when present; otherwise createdBy, if that account
 * is an Admin (the rule eventAuthService already applies). Anything that does
 * not resolve cleanly is `unverified`, and every caller fails closed on it.
 */

export type EventOwner =
  | { kind: 'admin'; adminId: string }
  | { kind: 'superadmin'; adminId: string }
  | { kind: 'unverified'; reason: string };

const accountRole = async (id: unknown): Promise<string | null> => {
  if (!id || !mongoose.isValidObjectId(String(id))) return null;
  const account: any = await Admin.findById(String(id)).select('role').lean();
  return account?.role ?? null;
};

const ownerOfMainEvent = async (main: any): Promise<EventOwner> => {
  if (main.adminId) {
    const role = await accountRole(main.adminId);
    if (role === 'Admin') return { kind: 'admin', adminId: String(main.adminId) };
    if (role === 'SuperAdmin') return { kind: 'superadmin', adminId: String(main.adminId) };
    return { kind: 'unverified', reason: "The event's owner account no longer exists." };
  }
  if (main.createdBy) {
    const role = await accountRole(main.createdBy);
    if (role === 'Admin') return { kind: 'admin', adminId: String(main.createdBy) };
    if (role === 'SuperAdmin') return { kind: 'superadmin', adminId: String(main.createdBy) };
  }
  return { kind: 'unverified', reason: 'The event has no owning Admin.' };
};

/**
 * The owner of an event, or of a Sub-Event's Main Event. Accepts a lean or
 * hydrated event with adminId, createdBy and parentEventId.
 */
export const resolveEventOwner = async (event: any): Promise<EventOwner> => {
  if (!event) return { kind: 'unverified', reason: 'Event not found.' };
  if (!event.parentEventId) return ownerOfMainEvent(event);

  const main: any = await Event.findById(event.parentEventId).select('adminId createdBy').lean();
  if (!main) return { kind: 'unverified', reason: "The Sub-Event's Main Event no longer exists." };
  // A Sub-Event copies its Main Event's adminId. If they disagree, which one
  // owns it cannot be told, so neither is trusted.
  if (event.adminId && String(event.adminId) !== String(main.adminId ?? '')) {
    return { kind: 'unverified', reason: "The Sub-Event's owner does not match its Main Event's." };
  }
  return ownerOfMainEvent(main);
};

/**
 * Decision B: only the owning Admin, or a Super Admin, may change an event's
 * POC and WhatsApp sender. An Admin who can merely see the event - because
 * one of their Users is assigned to it - may not.
 */
export const canEditEventContact = async (user: { id?: string; role?: string } | undefined, event: any): Promise<boolean> => {
  if (!user?.id) return false;
  if (user.role === 'SuperAdmin') return true;
  if (user.role !== 'Admin') return false;
  const owner = await resolveEventOwner(event);
  return owner.kind === 'admin' && owner.adminId === String(user.id);
};
