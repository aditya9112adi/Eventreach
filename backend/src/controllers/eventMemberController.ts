import { Request, Response } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { z } from 'zod';
import { Event } from '../models/Event';
import { Contact } from '../models/Contact';
import { EventMember } from '../models/EventMember';
import { AuditService } from '../services/AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';
import { isEventAuthorized } from '../services/eventAuthService';
import { countMembersOf, isSubEvent, memberSourceEvents } from '../services/subEventService';

/**
 * A Sub-Event's member list: existing contacts chosen for it, independently of
 * its Main Event and of its sibling sub-events (see models/EventMember.ts).
 *
 *   GET    /api/events/:id/members                 the members
 *   GET    /api/events/:id/member-candidates       contacts that may be added
 *   POST   /api/events/:id/members                 add one or many
 *   DELETE /api/events/:id/members/:contactId      remove one
 *
 * Every request is authorized against the Sub-Event (which is reached through
 * its Main Event), and every contact id a client sends is checked here: it
 * must exist and belong to one of the caller's own events of the same
 * organizer. Hiding a button in the page is not what keeps another organizer's
 * contacts out.
 */

/** One request adds at most this many; the page sends a larger selection in batches. */
export const MAX_MEMBERS_PER_REQUEST = 500;

const PAGE_SIZE_DEFAULT = 10;
const PAGE_SIZE_MAX = 200;
const SEARCH_MAX = 100;

/** The contact fields a member list shows - nothing more leaves the server. */
const CONTACT_FIELDS = '_id fullName phoneNumber email status source eventId createdAt';

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`);

class MemberRequestError extends Error {
  constructor(public readonly httpStatus: number, message: string) {
    super(message);
  }
}

/** The Sub-Event in the path, authorized; anything else is refused. */
const loadSubEvent = async (req: Request): Promise<any> => {
  const id = req.params.id;
  if (!mongoose.isValidObjectId(id)) throw new MemberRequestError(400, 'Invalid event id');
  if (!(await isEventAuthorized((req as any).user, id))) {
    throw new MemberRequestError(403, 'Access denied. You do not have access to this event.');
  }
  const event: any = await Event.findById(id).lean();
  if (!event) throw new MemberRequestError(404, 'Event not found');
  if (!isSubEvent(event)) {
    throw new MemberRequestError(
      400,
      "Only a sub-event has a member list. A main event's guests are managed in the Contacts tab."
    );
  }
  return event;
};

/** The search box: name, phone or email, as the Contacts tab searches. */
const readSearch = (raw: unknown): Record<string, unknown> | null => {
  if (raw !== undefined && typeof raw !== 'string') throw new MemberRequestError(400, 'Invalid search.');
  const search = (raw ?? '').trim();
  if (search.length > SEARCH_MAX) throw new MemberRequestError(400, 'The search is too long.');
  if (!search) return null;
  const safe = escapeRegex(search);
  return {
    $or: [
      { fullName: { $regex: safe, $options: 'i' } },
      { phoneNumber: { $regex: safe, $options: 'i' } },
      { email: { $regex: safe, $options: 'i' } },
    ],
  };
};

const readPage = (req: Request) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? 1), 10) || 1);
  const requested = parseInt(String(req.query.limit ?? PAGE_SIZE_DEFAULT), 10) || PAGE_SIZE_DEFAULT;
  return { page, limit: Math.min(PAGE_SIZE_MAX, Math.max(1, requested)) };
};

/** Names the event each contact was added to, one query for the whole page. */
const withSourceEvents = async (contacts: any[]) => {
  const ids = Array.from(new Set(contacts.map((c) => String(c.eventId))));
  const events = ids.length ? await Event.find({ _id: { $in: ids } }).select('_id eventId eventName').lean() : [];
  const byId = new Map(events.map((e: any) => [String(e._id), e]));
  return contacts.map((c) => {
    const source: any = byId.get(String(c.eventId));
    return { ...c, sourceEvent: source ? { _id: String(source._id), eventId: source.eventId, eventName: source.eventName } : null };
  });
};

const fail = (res: Response, error: unknown, context: string) => {
  if (error instanceof MemberRequestError) return res.status(error.httpStatus).json({ error: error.message });
  console.error(`${context} error:`, error);
  return res.status(500).json({ error: `Failed to ${context.toLowerCase()}` });
};

/**
 * GET /api/events/:id/members?search=&page=&limit=
 *
 * Like the contact listings, pagination is opt-in: without page or limit the
 * whole list comes back as a plain array (the member export reads it so).
 */
export const listMembers = async (req: Request, res: Response) => {
  try {
    const event = await loadSubEvent(req);
    const search = readSearch(req.query.search);

    const memberships = await EventMember.find({ eventId: event._id }).select('contactId createdAt').lean();
    const addedAt = new Map(memberships.map((m: any) => [String(m.contactId), m.createdAt]));
    const query: any = { _id: { $in: memberships.map((m: any) => m.contactId) }, ...(search ?? {}) };
    const sort: any = { fullName: 1, _id: 1 };
    const decorate = async (rows: any[]) =>
      (await withSourceEvents(rows)).map((c) => ({ ...c, addedAt: addedAt.get(String(c._id)) ?? null }));

    if (req.query.page === undefined && req.query.limit === undefined) {
      const contacts = await Contact.find(query).select(CONTACT_FIELDS).sort(sort).lean();
      return res.json(await decorate(contacts));
    }

    const { page, limit } = readPage(req);
    const [contacts, total] = await Promise.all([
      Contact.find(query).select(CONTACT_FIELDS).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
      Contact.countDocuments(query),
    ]);
    res.json({
      data: await decorate(contacts),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      memberCount: await countMembersOf(event._id),
    });
  } catch (error) {
    fail(res, error, 'Fetch members');
  }
};

/**
 * GET /api/events/:id/member-candidates?sourceEventId=&search=&page=&limit=
 *
 * Existing contacts that may be placed on this Sub-Event's list: those of the
 * caller's own Main Events of the same organizer (`sources`), optionally one
 * of them. Each says whether it is already a member, so the page can mark it
 * rather than offer it twice. Contacts already on a sibling sub-event's list
 * are offered like any other.
 */
export const listMemberCandidates = async (req: Request, res: Response) => {
  try {
    const event = await loadSubEvent(req);
    const parent: any = await Event.findById(event.parentEventId).select('_id adminId').lean();
    if (!parent) throw new MemberRequestError(404, 'The main event no longer exists.');

    const sources = await memberSourceEvents((req as any).user, parent);
    const sourceIds = sources.map((s) => String(s._id));

    const rawSource = req.query.sourceEventId;
    let eventFilter: unknown = { $in: sourceIds };
    if (rawSource !== undefined && rawSource !== '') {
      if (typeof rawSource !== 'string' || !mongoose.isValidObjectId(rawSource)) {
        throw new MemberRequestError(400, 'Invalid event id.');
      }
      if (!sourceIds.includes(rawSource)) {
        throw new MemberRequestError(403, "That event's contacts cannot be added to this sub-event.");
      }
      eventFilter = rawSource;
    }

    const search = readSearch(req.query.search);
    const query: any = { eventId: eventFilter, ...(search ?? {}) };
    const { page, limit } = readPage(req);
    const [contacts, total] = await Promise.all([
      Contact.find(query).select(CONTACT_FIELDS).sort({ createdAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      Contact.countDocuments(query),
    ]);

    const memberIds = new Set(
      (await EventMember.find({ eventId: event._id, contactId: { $in: contacts.map((c: any) => c._id) } })
        .select('contactId')
        .lean()).map((m: any) => String(m.contactId))
    );

    res.json({
      data: (await withSourceEvents(contacts)).map((c) => ({ ...c, isMember: memberIds.has(String(c._id)) })),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      sources: sources.map((s) => ({ _id: String(s._id), eventId: s.eventId, eventName: s.eventName })),
      parentEventId: String(parent._id),
    });
  } catch (error) {
    fail(res, error, 'Fetch contacts');
  }
};

const addMembersBody = z.object({
  contactIds: z
    .array(z.string().max(64, 'Invalid contact id'))
    .min(1, 'Select at least one contact to add')
    .max(MAX_MEMBERS_PER_REQUEST, `Cannot add more than ${MAX_MEMBERS_PER_REQUEST} contacts in one request`),
});

/**
 * POST /api/events/:id/members   body: { contactIds: string[] }
 *
 * Adds existing contacts to this Sub-Event's list only. Each id is checked on
 * its own and reported on its own:
 *  - added: now on the list because of this request;
 *  - alreadyMembers: were on it already - nothing is duplicated (the unique
 *    index makes a repeated or concurrent add a no-op);
 *  - rejected: invalid, not found, or not one of the caller's contacts for
 *    this organizer - never added, and retrying will not change that;
 *  - failed: valid but not written (a database error) - safe to retry.
 *
 * The response is 200 only when every id was added or already a member; a
 * mixed outcome is 207, so the page never reports a partial add as complete.
 */
export const addMembers = async (req: RequestWithId, res: Response) => {
  try {
    const event = await loadSubEvent(req);
    const parsed = addMembersBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

    const ids = Array.from(new Set(parsed.data.contactIds));
    const rejected: { id: string; reason: string }[] = [];
    const valid = ids.filter((id) => {
      const ok = mongoose.isValidObjectId(id);
      if (!ok) rejected.push({ id, reason: 'Invalid contact id' });
      return ok;
    });

    const parent: any = await Event.findById(event.parentEventId).select('_id adminId').lean();
    if (!parent) throw new MemberRequestError(404, 'The main event no longer exists.');
    const sourceIds = new Set((await memberSourceEvents((req as any).user, parent)).map((s) => String(s._id)));

    const contacts = valid.length ? await Contact.find({ _id: { $in: valid } }).select('_id eventId').lean() : [];
    const contactById = new Map(contacts.map((c: any) => [String(c._id), c]));
    const eligible: string[] = [];
    for (const id of valid) {
      const contact: any = contactById.get(id);
      if (!contact) rejected.push({ id, reason: 'Contact not found' });
      else if (!sourceIds.has(String(contact.eventId))) rejected.push({ id, reason: 'Access denied' });
      else eligible.push(id);
    }

    const existing = new Set(
      (await EventMember.find({ eventId: event._id, contactId: { $in: eligible } }).select('contactId').lean()).map(
        (m: any) => String(m.contactId)
      )
    );
    const toInsert = eligible.filter((id) => !existing.has(id));
    const addedBy = (req as any).user?.id;

    if (toInsert.length > 0) {
      try {
        await EventMember.insertMany(
          toInsert.map((contactId) => ({ eventId: event._id, contactId, ...(addedBy ? { addedBy } : {}) })),
          { ordered: false }
        );
      } catch (err: any) {
        // A duplicate here is a concurrent add of the same contact - already
        // a member, which is the outcome asked for. Anything else is caught by
        // the read-back below and reported per id rather than assumed.
        if (err?.code !== 11000 && !err?.writeErrors) console.error('Add members write error:', err?.message);
      }
    }

    // What is actually on the list now decides the report, not what was sent.
    const present = new Set(
      (await EventMember.find({ eventId: event._id, contactId: { $in: toInsert } }).select('contactId').lean()).map(
        (m: any) => String(m.contactId)
      )
    );
    let added = toInsert.filter((id) => present.has(id));
    const failed = toInsert.filter((id) => !present.has(id)).map((id) => ({ id, reason: 'Could not be added. Try again.' }));

    // A contact deleted while this request ran must not stay on the list: its
    // deletion may already have cleared memberships before this one was
    // written. Re-read the contacts and take back any that are gone.
    if (added.length > 0) {
      const alive = new Set(
        (await Contact.find({ _id: { $in: added } }).select('_id').lean()).map((c: any) => String(c._id))
      );
      const vanished = added.filter((id) => !alive.has(id));
      if (vanished.length > 0) {
        await EventMember.deleteMany({ eventId: event._id, contactId: { $in: vanished } });
        vanished.forEach((id) => rejected.push({ id, reason: 'Contact not found' }));
        added = added.filter((id) => alive.has(id));
      }
    }

    // The Sub-Event may have been deleted meanwhile; leave nothing behind.
    if (added.length > 0 && !(await Event.exists({ _id: event._id }))) {
      await EventMember.deleteMany({ eventId: event._id });
      return res.status(404).json({ error: 'Event not found' });
    }

    const memberCount = await countMembersOf(event._id);
    const alreadyMembers = eligible.filter((id) => existing.has(id));

    if (added.length > 0 || rejected.length > 0 || failed.length > 0) {
      await AuditService.log({
        action: 'EVENT_MEMBERS_ADDED',
        collectionName: 'eventmembers',
        documentId: String(event._id),
        actor: AuditService.getActorFromReq(req),
        request: AuditService.getRequestInfo(req),
        bulkOperationId: `BULK-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        bulk: {
          isBulk: ids.length > 1,
          operationType: 'CREATE',
          totalRecords: ids.length,
          successfulRecords: added.length,
          failedRecords: rejected.length + failed.length,
        },
        description: `Added ${added.length} of ${ids.length} contact(s) to sub-event ${event.eventId || event.eventName}`,
        metadata: { eventId: event.eventId ?? null, addedContactIds: added, alreadyMemberCount: alreadyMembers.length },
        success: rejected.length + failed.length === 0,
      });
    }

    const succeeded = added.length + alreadyMembers.length;
    const problems = rejected.length + failed.length;
    const allDenied = rejected.length > 0 && failed.length === 0 && rejected.every((r) => r.reason === 'Access denied');
    const status =
      problems === 0 ? 200 : succeeded > 0 ? 207 : allDenied ? 403 : rejected.length === 0 ? 500 : 400;

    res.status(status).json({
      addedCount: added.length,
      alreadyMemberCount: alreadyMembers.length,
      added,
      alreadyMembers,
      rejected,
      failed,
      memberCount,
    });
  } catch (error) {
    fail(res, error, 'Add members');
  }
};

/**
 * DELETE /api/events/:id/members/:contactId
 *
 * Takes the contact off this Sub-Event's list only. The contact itself, the
 * Main Event's guest list and every other sub-event's list are untouched.
 */
export const removeMember = async (req: RequestWithId, res: Response) => {
  try {
    const event = await loadSubEvent(req);
    const { contactId } = req.params;
    if (!mongoose.isValidObjectId(contactId)) return res.status(400).json({ error: 'Invalid contact id' });

    const removed = await EventMember.findOneAndDelete({ eventId: event._id, contactId }).lean();
    if (!removed) return res.status(404).json({ error: 'That contact is not a member of this sub-event.' });

    await AuditService.log({
      action: 'EVENT_MEMBER_REMOVED',
      collectionName: 'eventmembers',
      documentId: String((removed as any)._id),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      before: removed,
      description: `Removed a contact from sub-event ${event.eventId || event.eventName}`,
      metadata: { eventId: event.eventId ?? null, contactId },
    });

    const memberCount = await countMembersOf(event._id);
    res.json({ message: 'Member removed', memberCount });
  } catch (error) {
    fail(res, error, 'Remove member');
  }
};
