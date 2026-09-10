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
