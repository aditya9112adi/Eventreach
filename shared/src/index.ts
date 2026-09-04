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
