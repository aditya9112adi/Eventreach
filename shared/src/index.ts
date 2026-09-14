export interface User {
  id: string;
  name: string;
  email: string;
  role: 'SuperAdmin' | 'Admin' | 'User';
  status: 'Pending' | 'Active' | 'Rejected';
  accessGrantedOn?: string;
  accessStartDate?: string;
  accessExpiryDate?: string;
  accessDurationValue?: number;
  accessDurationUnit?: 'minutes' | 'hours' | 'days';
  isAccessCancelled?: boolean;
  assignedEventId?: string;
  assignedEventName?: string;
  adminId?: string;
  createdAt: string;
}

export interface LoginResponse {
  user: User;
  token: string;
}

export type EventStatus = 'Upcoming' | 'Completed' | 'Cancelled';

export interface Event {
  _id: string;
  eventId: string;               // human-readable unique id, e.g. "EVT-000001"
  organizerName: string;
  organizerMobile: string;
  eventName: string;
  eventType: string;
  eventDate: string;
  eventTime: string;
  eventVenue: string;
  eventDescription?: string;
  eventStatus: EventStatus;
  createdBy?: string;
  adminId?: string;
  assignedUserId?: string;
  assignedUserIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  _id: string;
  fullName: string;
  phoneNumber: string;
  countryCode: string;
  email?: string;
  tags?: string[];
  eventId: string;
  source: string;
  status: 'Valid' | 'Invalid' | 'Duplicate';
  validationReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardStats {
  totalEvents: number;
  totalContacts: number;
  totalCampaigns: number;
  messagesSent: number;
  messagesDelivered: number;
  messagesFailed: number;
  messagesPending: number;
}

export interface ExtractedContact {
  id?: string; // Temporary ID for frontend list rendering
  fullName: string;
  phoneNumber: string;
  countryCode: string;
  email?: string;
  status: 'Valid' | 'Invalid' | 'Duplicate';
  validationReason?: string;
}

export interface MediaAttachment {
  url: string;
  type: 'image' | 'video' | 'audio' | 'document';
  filename: string;
}

export interface Campaign {
  _id: string;
  eventId: string | Event;
  messageText: string;
  mediaAttachments: MediaAttachment[];
  status: 'Draft' | 'Scheduled' | 'Sending' | 'Completed';
  createdAt: string;
  updatedAt: string;
}

// ─── Password policy ──────────────────────────────────────────────────────────
// Single source of truth shared by the backend (registration + password reset)
// and the frontend (client-side validation and the requirements checklist), so
// the two can never disagree.

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 100;

export const PASSWORD_REQUIREMENTS: string[] = [
  `At least ${PASSWORD_MIN_LENGTH} characters`,
  'At least one letter',
  'At least one number',
];

/**
 * Returns null when acceptable, otherwise a human-readable reason.
 * Never echoes the supplied password.
 */
export const validatePassword = (password: unknown): string | null => {
  if (typeof password !== 'string' || password.length === 0) {
    return 'Password is required';
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return 'Password is too long';
  }
  if (!/[A-Za-z]/.test(password)) {
    return 'Password must contain at least one letter';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number';
  }
  return null;
};

export const isPasswordValid = (password: unknown): boolean => validatePassword(password) === null;

// ─── Phone country codes ──────────────────────────────────────────────────────
// Shared by the contact form, bulk import and the server-side phone parser.
// The code is an ISO 3166-1 alpha-2 region, which is what libphonenumber-js
// expects in order to read a number typed in local format.

export interface CountryOption {
  /** ISO 3166-1 alpha-2 region code, e.g. "IN". */
  code: string;
  /** Label shown in the picker, e.g. "IN (+91)". */
  label: string;
}

export const COUNTRY_OPTIONS: CountryOption[] = [
  { code: 'IN', label: 'IN (+91)' },
  { code: 'US', label: 'US (+1)' },
  { code: 'GB', label: 'UK (+44)' },
  { code: 'AU', label: 'AU (+61)' },
];

/**
 * Region assumed when none is supplied.
 *
 * This is not only the picker's initial value: the backend passes it to
 * libphonenumber-js when parsing a number that was typed without a country
 * prefix, so the frontend default and the server fallback must agree or the
 * same digits would resolve to two different countries.
 */
export const DEFAULT_COUNTRY_CODE = 'IN';

/**
 * WhatsApp Cloud API media rules.
 *
 * One definition used by the browser, the upload endpoint and the sender, so
 * the UI can never advertise a limit the backend will not accept — the UI
 * previously offered 100 MB for every type, which is 20x what WhatsApp
 * accepts for an image.
 *
 * Sizes are the per-type ceilings the Cloud API documents for the /media
 * upload endpoint. They are deliberately gathered here so a change to Meta's
 * published limits is a one-line edit rather than a hunt through validators.
 */
export type WhatsAppMediaKind = 'image' | 'video' | 'audio' | 'document';

export interface WhatsAppMediaRule {
  /** WhatsApp message type this MIME maps to. */
  kind: WhatsAppMediaKind;
  /** Ceiling Meta enforces for this MIME on /media. */
  maxBytes: number;
  /** Extensions the UI offers, and the only ones the backend accepts. */
  extensions: string[];
  /** Whether WhatsApp lets this type carry a caption alongside the file. */
  supportsCaption: boolean;
}

const MB = 1024 * 1024;

export const WHATSAPP_MEDIA_RULES: Record<string, WhatsAppMediaRule> = {
  'image/jpeg':      { kind: 'image',    maxBytes: 5 * MB,   extensions: ['.jpg', '.jpeg'], supportsCaption: true },
  'image/png':       { kind: 'image',    maxBytes: 5 * MB,   extensions: ['.png'],          supportsCaption: true },
  'video/mp4':       { kind: 'video',    maxBytes: 16 * MB,  extensions: ['.mp4'],          supportsCaption: true },
  // Audio is the one type WhatsApp does NOT accept a caption for, so campaign
  // text has to travel as its own message rather than being dropped.
  'audio/mpeg':      { kind: 'audio',    maxBytes: 16 * MB,  extensions: ['.mp3'],          supportsCaption: false },
  'application/pdf': { kind: 'document', maxBytes: 100 * MB, extensions: ['.pdf'],          supportsCaption: true },
};

export const WHATSAPP_ALLOWED_MIME_TYPES = Object.keys(WHATSAPP_MEDIA_RULES);

/** Largest file any type permits — the ceiling the upload middleware applies. */
export const WHATSAPP_MAX_ANY_BYTES = Math.max(
  ...Object.values(WHATSAPP_MEDIA_RULES).map((r) => r.maxBytes)
);

export const formatMediaSize = (bytes: number): string =>
  bytes >= MB ? `${Math.round(bytes / MB)} MB` : `${Math.round(bytes / 1024)} KB`;

/** Human-readable per-type limits for the upload UI, e.g. "Images (.jpg, .jpeg, .png) — 5 MB". */
export const whatsAppMediaLimitSummary = (): string[] => {
  const byKind = new Map<WhatsAppMediaKind, { exts: string[]; maxBytes: number }>();
  for (const rule of Object.values(WHATSAPP_MEDIA_RULES)) {
    const entry = byKind.get(rule.kind) ?? { exts: [], maxBytes: rule.maxBytes };
    entry.exts.push(...rule.extensions);
    entry.maxBytes = Math.max(entry.maxBytes, rule.maxBytes);
    byKind.set(rule.kind, entry);
  }
  const label: Record<WhatsAppMediaKind, string> = {
    image: 'Images', video: 'Video', audio: 'Audio', document: 'Documents',
  };
  return [...byKind.entries()].map(
    ([kind, e]) => `${label[kind]} (${e.exts.join(', ')}) — ${formatMediaSize(e.maxBytes)}`
  );
};

/**
 * Validate a file against the rules. `sniffedMime` is the type detected from
 * the file's own bytes; when supplied it must agree with the declared type,
 * since a browser-supplied MIME is caller-controlled and trivially forged.
 */
export const validateWhatsAppMedia = (input: {
  declaredMime: string;
  filename: string;
  sizeBytes: number;
  sniffedMime?: string | null;
}): string | null => {
  const rule = WHATSAPP_MEDIA_RULES[input.declaredMime];
  if (!rule) return `Unsupported file type. Allowed: ${WHATSAPP_ALLOWED_MIME_TYPES.join(', ')}`;

  const ext = (input.filename.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
  if (!rule.extensions.includes(ext)) {
    return `File extension "${ext || '(none)'}" does not match its type. Expected: ${rule.extensions.join(', ')}`;
  }

  if (input.sizeBytes <= 0) return 'The file is empty.';
  if (input.sizeBytes > rule.maxBytes) {
    return `File is ${formatMediaSize(input.sizeBytes)}. WhatsApp accepts at most ${formatMediaSize(rule.maxBytes)} for this type.`;
  }

  if (input.sniffedMime && input.sniffedMime !== input.declaredMime) {
    return 'The file contents do not match its type. It may be renamed or corrupted.';
  }

  return null;
};
