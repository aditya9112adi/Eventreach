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
  /** Whether to show WhatsApp template management. The server re-checks every request. */
  canManageWhatsAppTemplates?: boolean;
  createdAt: string;
}

export interface LoginResponse {
  user: User;
  token: string;
}

export type EventStatus = 'Upcoming' | 'Completed' | 'Cancelled';

/**
 * Event Type. Stored as free text in eventType (1-20 characters, trimmed) -
 * not an enum: the forms offer EVENT_TYPE_OPTIONS, and choosing "Other" saves
 * the type the user specifies ("Product Launch"), never the word "Other".
 * Existing records keep whatever they hold.
 */
export const EVENT_TYPE_MAX_LENGTH = 20;
export const OTHER_EVENT_TYPE = 'Other';
export const EVENT_TYPE_OPTIONS = [
  'Wedding',
  'Birthday Party',
  'Anniversary',
  'Engagement',
  'Baby Shower',
  'Corporate Event',
  'Conference',
  'Seminar',
  'Workshop',
  'Webinar',
  'Concert',
  'Festival',
  'Graduation',
  'Sports Event',
  'Religious Event',
  'Networking Event',
  'Farewell',
  'Charity Event',
  OTHER_EVENT_TYPE,
] as const;

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
  /** Null or absent: a Main Event. Set: a Sub-Event of that Main Event. */
  parentEventId?: string | null;
  /** On a Sub-Event (detail, or a listing that includes sub-events): its Main Event. */
  parentEvent?: EventParentSummary | null;
  /** On a Main Event in a listing or detail: how many sub-events it has. */
  subEventCount?: number;
  /** On a Sub-Event: how many contacts are on its member list. */
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

/** How a Sub-Event names its Main Event. */
export interface EventParentSummary {
  _id: string;
  eventId?: string;
  eventName: string;
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

/**
 * The calendar day a report's Start Date / End Date means.
 *
 * EventReach is an India-only application and already reads and writes its
 * calendar days in IST: event instants are built as `${date}T${time}:00+05:30`
 * and read back through the same offset. A report has to agree with that, and
 * the browser and the server have to agree with each other — a range resolved
 * against the viewer's local clock in one place and against UTC in the other
 * puts a record on different sides of the boundary depending on which layer
 * looked at it.
 *
 * Both bounds are inclusive: a record stamped at the very first or very last
 * millisecond of a chosen day is inside the range.
 */
export const REPORT_DAY_OFFSET = '+05:30';

/** The first instant of `date` (YYYY-MM-DD), in report time. */
export const reportDayStart = (date: string): Date =>
  new Date(`${date}T00:00:00.000${REPORT_DAY_OFFSET}`);

/** The last instant of `date` (YYYY-MM-DD), in report time. */
export const reportDayEnd = (date: string): Date =>
  new Date(`${date}T23:59:59.999${REPORT_DAY_OFFSET}`);

// ── WhatsApp message templates ───────────────────────────────────────────────
// Validation shared by the template editor and the API, so the page and the
// server can never disagree. The server validates again on every request.

/** Meta template names: lowercase letters, digits and underscores (max 512). */
export const WHATSAPP_TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
/** Language codes as Meta uses them: "en", "en_US", "pt_BR", "fil". */
export const WHATSAPP_LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2,3})?$/;

/**
 * Offered first in the editor. Any other code of the right form is accepted;
 * Meta itself refuses a language it does not support.
 */
export const COMMON_TEMPLATE_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'en_US', label: 'English (US)' },
  { code: 'en_GB', label: 'English (UK)' },
  { code: 'hi', label: 'Hindi' },
  { code: 'mr', label: 'Marathi' },
];

/**
 * WhatsApp template definitions: validation, and the payload Meta's
 * `POST /{WABA_ID}/message_templates` takes. Pure - no database, no network.
 *
 * Rules marked [Meta] are Meta's documented ones (developers.facebook.com,
 * message templates: components and guidelines, checked 2026-10-12). Rules
 * marked [local] are EventReach's own, there so that a template can always be
 * filled by the existing send path and nothing unresolved is ever sent.
 */

/**
 * [Meta] UTILITY, MARKETING or AUTHENTICATION. Authentication templates have a
 * fixed structure (one-time-password buttons) that this editor does not build,
 * so they are not offered rather than offered and rejected.
 */
export const WHATSAPP_TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY'] as const;
export type WhatsAppTemplateCategory = (typeof WHATSAPP_TEMPLATE_CATEGORIES)[number];

export const WHATSAPP_TEMPLATE_STATES = [
  'Draft',
  'Submitting',
  'Pending',
  'Approved',
  'Rejected',
  'SubmissionFailed',
  'Paused',
  'Disabled',
  'Unknown',
  'Archived',
  'Deleted',
] as const;
export type WhatsAppTemplateState = (typeof WHATSAPP_TEMPLATE_STATES)[number];

/** Local states in which the definition can still be edited. */
export const WHATSAPP_TEMPLATE_EDITABLE_STATES: readonly WhatsAppTemplateState[] = ['Draft', 'SubmissionFailed'];

/**
 * Where a placeholder's value comes from at send time. Always the selected
 * event and the guest being messaged - never request data.
 */
export const WHATSAPP_TEMPLATE_VARIABLE_SOURCES = [
  'guest.name',
  'event.name',
  'event.date',
  'event.time',
  'event.venue',
  'event.type',
  'event.organizer',
  'event.description',
  'fixed',
] as const;
export type WhatsAppTemplateVariableSource = (typeof WHATSAPP_TEMPLATE_VARIABLE_SOURCES)[number];

export const WHATSAPP_TEMPLATE_LIMITS = {
  displayName: 100,
  name: 512, // [Meta]
  headerText: 60, // [Meta]
  body: 1024, // [Meta]
  footer: 60, // [Meta]
  variableLabel: 60,
  variableValue: 1024, // matches the send path (whatsappTemplateService)
  variables: 100, // matches the send path
} as const;

export interface TemplateFieldError {
  field: string;
  message: string;
}

export interface TemplateVariableInput {
  position?: unknown;
  label?: unknown;
  source?: unknown;
  fixedValue?: unknown;
  fallback?: unknown;
  sample?: unknown;
}

export interface TemplateDraftInput {
  displayName?: unknown;
  name?: unknown;
  language?: unknown;
  category?: unknown;
  allowCategoryChange?: unknown;
  headerText?: unknown;
  body?: unknown;
  footer?: unknown;
  variables?: unknown;
}

export interface ValidatedTemplateVariable {
  position: number;
  label: string;
  source: WhatsAppTemplateVariableSource;
  fixedValue?: string;
  fallback?: string;
  sample: string;
}

export interface ValidatedTemplate {
  displayName: string;
  name: string;
  language: string;
  category: WhatsAppTemplateCategory;
  allowCategoryChange: boolean;
  headerText: string | null;
  body: string;
  footer: string | null;
  variables: ValidatedTemplateVariable[];
}

// ── placeholders ────────────────────────────────────────────────────────────

const POSITIONAL = /\{\{(\d+)\}\}/g;
const NAMED = /\{\{\s*[a-z_][a-z0-9_]*\s*\}\}/i;

export interface TemplatePlaceholderScan {
  /** Positions in order of first appearance. */
  positions: number[];
  error: string | null;
}

/**
 * [Meta] positional parameters are numbered from 1, in the order they appear.
 * [local] exactly `{{1}}` (no spaces), no gaps, each used once, and no stray
 * braces - a placeholder the send path cannot fill must never reach Meta.
 */
export const scanTemplatePlaceholders = (text: string): TemplatePlaceholderScan => {
  const positions: number[] = [];
  for (const match of text.matchAll(POSITIONAL)) positions.push(Number(match[1]));

  const leftover = text.replace(POSITIONAL, '');
  if (NAMED.test(leftover)) {
    return { positions, error: 'Use numbered placeholders such as {{1}} and {{2}}. Named placeholders are not supported yet.' };
  }
  if (leftover.includes('{{') || leftover.includes('}}')) {
    return { positions, error: 'A placeholder is malformed. Write placeholders exactly as {{1}}, {{2}}, … with no spaces.' };
  }
  if (new Set(positions).size !== positions.length) {
    return { positions, error: 'Each placeholder can be used only once. Add another placeholder for the same value instead.' };
  }
  const expected = positions.map((_, i) => i + 1);
  if (positions.some((p, i) => p !== expected[i])) {
    return {
      positions,
      error: 'Placeholders must be numbered from {{1}} in the order they appear, with no gaps (for example {{1}} … {{2}} … {{3}}).',
    };
  }
  return { positions, error: null };
};

// ── validation ──────────────────────────────────────────────────────────────

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const optionalText = (value: unknown): string | null => {
  const t = text(value);
  return t ? t : null;
};

/** [Meta] parameter values: no line breaks or tabs, at most four spaces in a row. */
const badParameterText = (value: string): boolean => /[\n\r\t]/.test(value) || / {5,}/.test(value);

/**
 * Validates a template definition. Returns every problem at once, each tied to
 * the field the editor shows it beside.
 */
/** Template structures not supported yet, and how a request for each is refused. */
export const UNSUPPORTED_TEMPLATE_FIELDS: readonly (readonly [string, string])[] = [
  ['buttons', 'Buttons are not supported yet. Remove them to create this template here.'],
  ['components', 'Send the header, body and footer as separate fields; raw components are not accepted.'],
  ['headerFormat', 'Only a text header is supported. Image, video and document headers are not supported yet.'],
  ['headerType', 'Only a text header is supported. Image, video and document headers are not supported yet.'],
  ['headerMedia', 'Image, video and document headers are not supported yet.'],
  ['headerHandle', 'Image, video and document headers are not supported yet.'],
  ['parameterFormat', 'Only numbered placeholders such as {{1}} are supported. Named placeholders are not supported yet.'],
  ['parameter_format', 'Only numbered placeholders such as {{1}} are supported. Named placeholders are not supported yet.'],
];

export const validateTemplateDraft = (
  input: TemplateDraftInput
): { value: ValidatedTemplate | null; errors: TemplateFieldError[] } => {
  const errors: TemplateFieldError[] = [];
  const fail = (field: string, message: string) => errors.push({ field, message });

  const displayName = text(input.displayName);
  if (!displayName) fail('displayName', 'Display name is required.');
  else if (displayName.length > WHATSAPP_TEMPLATE_LIMITS.displayName) fail('displayName', `Display name must be at most ${WHATSAPP_TEMPLATE_LIMITS.displayName} characters.`);

  const name = text(input.name);
  if (!name) fail('name', 'Template name is required.');
  else if (name.length > WHATSAPP_TEMPLATE_LIMITS.name || !WHATSAPP_TEMPLATE_NAME_PATTERN.test(name)) {
    fail('name', 'Template name may contain only lowercase letters, digits and underscores (at most 512).');
  }

  const language = text(input.language);
  if (!language) fail('language', 'Language is required.');
  else if (!WHATSAPP_LANGUAGE_CODE_PATTERN.test(language)) fail('language', 'Language must be a code such as "en" or "en_US".');

  const category = text(input.category).toUpperCase();
  if (!category) fail('category', 'Category is required.');
  else if (category === 'AUTHENTICATION') {
    fail('category', 'Authentication templates use a fixed one-time-password format and cannot be created here.');
  } else if (!(WHATSAPP_TEMPLATE_CATEGORIES as readonly string[]).includes(category)) {
    fail('category', 'Category must be Marketing or Utility.');
  }

  // Letting Meta recategorize a template is not offered in this release, for
  // any role: a request for it is refused rather than silently ignored.
  if (input.allowCategoryChange !== undefined && input.allowCategoryChange !== false) {
    fail('allowCategoryChange', 'Letting WhatsApp change the category is not available. Choose the category that fits.');
  }

  // Structures this editor cannot build or the send path cannot fill are
  // refused by name, never silently dropped: a template submitted without the
  // buttons or media header its author sent would not be the one they meant.
  const raw = input as Record<string, unknown>;
  for (const [field, message] of UNSUPPORTED_TEMPLATE_FIELDS) {
    if (raw[field] !== undefined && raw[field] !== null) fail(field, message);
  }

  const headerText = optionalText(input.headerText);
  if (headerText) {
    if (headerText.length > WHATSAPP_TEMPLATE_LIMITS.headerText) fail('headerText', `Header must be at most ${WHATSAPP_TEMPLATE_LIMITS.headerText} characters.`);
    // [local] the send path fills body placeholders only.
    if (headerText.includes('{{') || headerText.includes('}}')) fail('headerText', 'The header cannot contain placeholders.');
  }

  const footer = optionalText(input.footer);
  if (footer) {
    if (footer.length > WHATSAPP_TEMPLATE_LIMITS.footer) fail('footer', `Footer must be at most ${WHATSAPP_TEMPLATE_LIMITS.footer} characters.`);
    // [Meta] the footer is text only.
    if (footer.includes('{{') || footer.includes('}}')) fail('footer', 'The footer cannot contain placeholders.');
  }

  const body = typeof input.body === 'string' ? input.body.trim() : '';
  let positions: number[] = [];
  if (!body) fail('body', 'Message body is required.');
  else {
    if (body.length > WHATSAPP_TEMPLATE_LIMITS.body) fail('body', `Message body must be at most ${WHATSAPP_TEMPLATE_LIMITS.body} characters.`);
    const scan = scanTemplatePlaceholders(body);
    if (scan.error) fail('body', scan.error);
    else positions = scan.positions;
    if (positions.length > WHATSAPP_TEMPLATE_LIMITS.variables) fail('body', `A template can have at most ${WHATSAPP_TEMPLATE_LIMITS.variables} placeholders.`);
  }

  // One mapping per placeholder - [Meta] each needs an example value.
  const rawVariables = input.variables === undefined ? [] : input.variables;
  const variables: ValidatedTemplateVariable[] = [];
  if (!Array.isArray(rawVariables)) {
    fail('variables', 'Variables must be a list.');
  } else {
    const byPosition = new Map<number, TemplateVariableInput>();
    rawVariables.forEach((raw: any, i) => {
      const position = Number(raw?.position);
      if (!Number.isInteger(position) || position < 1) {
        fail(`variables[${i}].position`, 'Each variable needs the number of its placeholder.');
      } else if (byPosition.has(position)) {
        fail(`variables[${i}].position`, `Placeholder {{${position}}} is mapped twice.`);
      } else {
        byPosition.set(position, raw ?? {});
      }
    });

    for (const position of byPosition.keys()) {
      if (!positions.includes(position) && !errors.some((e) => e.field === 'body')) {
        fail('variables', `{{${position}}} is mapped but does not appear in the message body.`);
      }
    }

    for (const position of [...positions].sort((a, b) => a - b)) {
      const field = `variables.${position}`;
      const raw = byPosition.get(position);
      if (!raw) {
        fail(field, `Choose what fills {{${position}}}.`);
        continue;
      }
      const label = text(raw.label);
      const source = text(raw.source) as WhatsAppTemplateVariableSource;
      const fixedValue = optionalText(raw.fixedValue) ?? undefined;
      const fallback = optionalText(raw.fallback) ?? undefined;
      const sample = text(raw.sample);

      if (!label) fail(`${field}.label`, `Give {{${position}}} a name.`);
      else if (label.length > WHATSAPP_TEMPLATE_LIMITS.variableLabel) fail(`${field}.label`, `The name of {{${position}}} must be at most ${WHATSAPP_TEMPLATE_LIMITS.variableLabel} characters.`);

      if (!(WHATSAPP_TEMPLATE_VARIABLE_SOURCES as readonly string[]).includes(source)) {
        fail(`${field}.source`, `Choose what fills {{${position}}}.`);
      } else if (source === 'fixed' && !fixedValue) {
        fail(`${field}.fixedValue`, `Enter the fixed text for {{${position}}}.`);
      }

      for (const [key, value] of [['fixedValue', fixedValue], ['fallback', fallback]] as const) {
        if (value && (value.length > WHATSAPP_TEMPLATE_LIMITS.variableValue || badParameterText(value))) {
          fail(`${field}.${key}`, `This value cannot contain line breaks, tabs or more than four spaces in a row (max ${WHATSAPP_TEMPLATE_LIMITS.variableValue}).`);
        }
      }

      if (!sample) fail(`${field}.sample`, `Meta needs an example value for {{${position}}}.`);
      else if (sample.length > WHATSAPP_TEMPLATE_LIMITS.variableValue || badParameterText(sample)) {
        fail(`${field}.sample`, `The example for {{${position}}} cannot contain line breaks, tabs or more than four spaces in a row.`);
      }

      variables.push({
        position,
        label,
        source,
        ...(source === 'fixed' && fixedValue ? { fixedValue } : {}),
        ...(fallback ? { fallback } : {}),
        sample,
      });
    }
  }

  if (errors.length > 0) return { value: null, errors };
  return {
    value: {
      displayName,
      name,
      language,
      category: category as WhatsAppTemplateCategory,
      allowCategoryChange: false,
      headerText,
      body,
      footer,
      variables,
    },
    errors: [],
  };
};

/** How each variable source is named in the editor. */
export const WHATSAPP_TEMPLATE_VARIABLE_SOURCE_LABELS: Record<WhatsAppTemplateVariableSource, string> = {
  'guest.name': 'Guest name',
  'event.name': 'Event name',
  'event.date': 'Event date',
  'event.time': 'Event start time',
  'event.venue': 'Event venue',
  'event.type': 'Event type',
  'event.organizer': 'Organizer name',
  'event.description': 'Event description',
  fixed: 'Fixed text',
};
