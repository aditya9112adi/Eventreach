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

/**
 * India only, deliberately.
 *
 * This product messages Indian guests through the WhatsApp Cloud API, so a
 * number from any other country is not a valid contact — it would be stored,
 * counted, and then fail at send time. Keeping a single entry here means the
 * picker, the manual form, bulk import and the API all agree, rather than the
 * UI offering countries the rest of the system will refuse.
 */
export const COUNTRY_OPTIONS: CountryOption[] = [
  { code: 'IN', label: 'IN (+91)' },
];

/**
 * The only region this system accepts.
 *
 * Every number is now parsed as Indian by normalizeIndianMobile regardless of
 * what a caller supplies, so this no longer steers parsing — a client sending
 * countryCode "US" cannot change how its number is read. It remains the value
 * the form submits and the label the picker shows.
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

/**
 * Indian mobile numbers: one normaliser, used everywhere.
 *
 * The manual form, bulk import, the import preview and the update endpoint
 * each used to parse numbers their own way, which is how a number could be
 * accepted in one path and rejected in another. This is the single rule they
 * all apply, and it is deliberately dependency-free so the browser and the
 * server run the identical code.
 *
 * Accepts what a person actually types — 9876543210, +919876543210,
 * 919876543210, with spaces, hyphens or brackets — and always produces the
 * same stored form: +91 followed by ten digits, exactly 13 characters.
 */
export const INDIA_DIAL_CODE = '+91';
export const INDIA_MOBILE_DIGITS = 10;
/** "+91" + 10 digits. */
export const INDIA_E164_LENGTH = 13;

export type IndianMobileResult =
  | { ok: true; e164: string; subscriber: string }
  | { ok: false; reason: string };

export const normalizeIndianMobile = (raw: unknown): IndianMobileResult => {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'Enter a WhatsApp number.' };
  }

  const trimmed = raw.trim();

  // Letters or symbols are never part of a number. Checked before anything is
  // stripped so "98765abcde" fails as bad input rather than as a length error.
  if (/[^\d+\s()\-.]/.test(trimmed)) {
    return { ok: false, reason: 'A WhatsApp number can contain only digits.' };
  }

  const compact = trimmed.replace(/[\s()\-.]/g, '');

  /**
   * A "+" may appear once, at the front. This is what catches the doubled
   * country code (+91+919876543210 and +9191...), which would otherwise be
   * silently truncated into a plausible-looking wrong number.
   */
  const plusCount = (compact.match(/\+/g) || []).length;
  if (plusCount > 1 || (plusCount === 1 && !compact.startsWith('+'))) {
    return { ok: false, reason: 'This number has a repeated or misplaced country code. Enter it once, e.g. 9876543210.' };
  }

  const hadExplicitPlus = compact.startsWith('+');
  let digits = compact.replace(/^\+/, '');
  if (!/^\d+$/.test(digits) || digits.length === 0) {
    return { ok: false, reason: 'A WhatsApp number can contain only digits.' };
  }

  /**
   * Decide whether a leading "91" is the country code or the start of the
   * number itself.
   *
   * With an explicit "+" the intent is unambiguous — "+91…" is always the
   * country code — so it is stripped whatever the length. Without one, it is
   * only a prefix when digits remain afterwards, which is what keeps a
   * genuine ten-digit number beginning 91 (9198765432) from being mangled
   * into eight. Treating both the same way would either corrupt that number
   * or silently accept "+9198765432" — eight subscriber digits — as a
   * different, valid-looking one.
   */
  if (digits.startsWith('91') && (hadExplicitPlus || digits.length > INDIA_MOBILE_DIGITS)) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0') && digits.length === INDIA_MOBILE_DIGITS + 1) {
    // Domestic trunk prefix, e.g. 09876543210.
    digits = digits.slice(1);
  }

  if (digits.length !== INDIA_MOBILE_DIGITS) {
    return {
      ok: false,
      reason:
        digits.length < INDIA_MOBILE_DIGITS
          ? `An Indian mobile number has ${INDIA_MOBILE_DIGITS} digits — this one has ${digits.length}.`
          : `An Indian mobile number has ${INDIA_MOBILE_DIGITS} digits — this one has ${digits.length}. Check for an extra digit or a non-Indian country code.`,
    };
  }

  // Indian mobile ranges begin 6, 7, 8 or 9; landlines and short codes do not.
  if (!/^[6-9]/.test(digits)) {
    return { ok: false, reason: 'An Indian mobile number starts with 6, 7, 8 or 9.' };
  }

  return { ok: true, e164: `${INDIA_DIAL_CODE}${digits}`, subscriber: digits };
};

/** True when the value already is a correctly normalised Indian number. */
export const isNormalizedIndianMobile = (value: unknown): boolean => {
  const result = normalizeIndianMobile(value);
  return result.ok && result.e164 === value;
};

/**
 * Digits the person actually has to type, ignoring any country code they
 * included. The contact form's counter uses this: counting the raw string
 * against a limit of ten reported "13/10 — limit reached" for the perfectly
 * valid +919876543210.
 */
export const indianSubscriberLength = (raw: unknown): number => {
  if (typeof raw !== 'string') return 0;
  const compact = raw.replace(/[^\d+]/g, '');
  const hadExplicitPlus = compact.startsWith('+');
  let digits = compact.replace(/^\+/, '');
  // Same prefix rule as normalizeIndianMobile, so the counter and the
  // validation always agree about which digits belong to the subscriber.
  if (digits.startsWith('91') && (hadExplicitPlus || digits.length > INDIA_MOBILE_DIGITS)) digits = digits.slice(2);
  else if (digits.startsWith('0') && digits.length === INDIA_MOBILE_DIGITS + 1) digits = digits.slice(1);
  return Math.min(digits.length, INDIA_MOBILE_DIGITS);
};
