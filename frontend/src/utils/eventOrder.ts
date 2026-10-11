/**
 * The Events tab's default order: newest-created first.
 *
 * The same order GET /events returns - createdAt descending, then _id
 * descending - so the page and the server agree, including on ties. createdAt
 * arrives as an ISO-8601 string and _id as a 24-character hex ObjectId; both
 * compare correctly as plain strings (an ObjectId begins with its creation
 * time). Compared code unit by code unit rather than with localeCompare, so no
 * locale's collation can reorder the digits and punctuation.
 *
 * An event without createdAt sorts after every dated one, as it does on the
 * server.
 */

interface Ordered {
  _id: string;
  createdAt?: string | null;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const compareNewestCreatedFirst = (a: Ordered, b: Ordered): number =>
  compare(b.createdAt || '', a.createdAt || '') || compare(b._id || '', a._id || '');
