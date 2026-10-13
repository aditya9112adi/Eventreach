import mongoose, { Schema, Document } from 'mongoose';
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_LOCAL_STATES,
  VARIABLE_SOURCES,
  type TemplateCategory,
  type TemplateLocalState,
  type VariableSource,
} from '../services/templateDefinition';

/**
 * A WhatsApp message template managed in EventReach.
 *
 * Identity follows Meta's: a template is one name in one language in one
 * WhatsApp Business Account (Meta allows the same name in several languages).
 * `localState` is EventReach's workflow; `metaStatus` is the last status Meta
 * itself reported, stored verbatim. Approved is only ever set from Meta.
 */

export interface TemplateVariableMapping {
  /** {{position}} in the body. */
  position: number;
  /** What the client calls it ("Guest name"). */
  label: string;
  source: VariableSource;
  /** source 'fixed' only: the text sent for every recipient. */
  fixedValue?: string;
  /** Sent when the source is empty. guest.name falls back to "Guest" anyway. */
  fallback?: string;
  /** The example value Meta reviews. Required by Meta for every parameter. */
  sample: string;
}

export interface TemplateButton {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
  text: string;
  url?: string;
  phoneNumber?: string;
}

export interface TemplateHistoryEntry {
  at: Date;
  type: string;
  actorId?: mongoose.Types.ObjectId | null;
  metaStatus?: string | null;
  code?: number | string | null;
  /** Sanitized: Meta's own message, scrubbed of the token. Never request data. */
  message?: string | null;
}

export interface IWhatsAppTemplate extends Document {
  wabaId: string;
  ownerAdminId: mongoose.Types.ObjectId | null;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;
  displayName: string;
  name: string;
  language: string;
  category: TemplateCategory;
  allowCategoryChange: boolean;
  eventId: mongoose.Types.ObjectId | null;
  headerText: string | null;
  body: string;
  footer: string | null;
  variables: TemplateVariableMapping[];
  buttons: TemplateButton[];
  localState: TemplateLocalState;
  metaTemplateId: string | null;
  metaStatus: string | null;
  metaCategory: string | null;
  rejectionReason: string | null;
  lastSyncedAt: Date | null;
  /** When a manual status refresh last asked Meta; spaces refreshes out. */
  refreshRequestedAt: Date | null;
  submission: { attemptId: string | null; startedAt: Date | null; attempts: number };
  history: TemplateHistoryEntry[];
  version: number;
  replacesTemplateId: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const variableSchema = new Schema<TemplateVariableMapping>(
  {
    position: { type: Number, required: true, min: 1 },
    label: { type: String, required: true, trim: true, maxlength: 60 },
    source: { type: String, required: true, enum: VARIABLE_SOURCES },
    fixedValue: { type: String, trim: true, maxlength: 1024 },
    fallback: { type: String, trim: true, maxlength: 1024 },
    sample: { type: String, required: true, trim: true, maxlength: 1024 },
  },
  { _id: false }
);

// What Meta allows is validated in @eventreach/shared before anything is stored.
const buttonSchema = new Schema<TemplateButton>(
  {
    type: { type: String, required: true, enum: ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'] },
    text: { type: String, required: true, trim: true, maxlength: 25 },
    url: { type: String, trim: true, maxlength: 2000 },
    phoneNumber: { type: String, trim: true, maxlength: 20 },
  },
  { _id: false }
);

const historySchema = new Schema<TemplateHistoryEntry>(
  {
    at: { type: Date, required: true },
    type: { type: String, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    metaStatus: { type: String, default: null },
    code: { type: Schema.Types.Mixed, default: null },
    message: { type: String, default: null, maxlength: 500 },
  },
  { _id: false }
);

const whatsAppTemplateSchema = new Schema<IWhatsAppTemplate>(
  {
    wabaId: { type: String, required: true, trim: true },
    // Null: shared, owned by the platform (created by a Super Admin).
    ownerAdminId: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Admin', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    displayName: { type: String, required: true, trim: true, maxlength: 100 },
    name: { type: String, required: true, trim: true, maxlength: 512, match: /^[a-z0-9_]+$/ },
    language: { type: String, required: true, trim: true },
    category: { type: String, required: true, enum: TEMPLATE_CATEGORIES },
    allowCategoryChange: { type: Boolean, default: false },
    // Null: reusable across the owner's events.
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', default: null },
    headerText: { type: String, default: null, maxlength: 60 },
    body: { type: String, required: true, maxlength: 1024 },
    footer: { type: String, default: null, maxlength: 60 },
    variables: { type: [variableSchema], default: [] },
    buttons: { type: [buttonSchema], default: [] },
    localState: { type: String, required: true, enum: TEMPLATE_LOCAL_STATES, default: 'Draft' },
    metaTemplateId: { type: String, default: null },
    metaStatus: { type: String, default: null },
    metaCategory: { type: String, default: null },
    rejectionReason: { type: String, default: null, maxlength: 1000 },
    lastSyncedAt: { type: Date, default: null },
    refreshRequestedAt: { type: Date, default: null },
    submission: {
      attemptId: { type: String, default: null },
      startedAt: { type: Date, default: null },
      attempts: { type: Number, default: 0 },
    },
    history: { type: [historySchema], default: [] },
    version: { type: Number, default: 1, min: 1 },
    replacesTemplateId: { type: Schema.Types.ObjectId, ref: 'WhatsAppTemplate', default: null },
  },
  { timestamps: true }
);

// One name per language per WhatsApp Business Account, as Meta requires.
whatsAppTemplateSchema.index({ wabaId: 1, name: 1, language: 1 }, { unique: true });
// Status notifications arrive by Meta's template id.
whatsAppTemplateSchema.index(
  { wabaId: 1, metaTemplateId: 1 },
  { unique: true, partialFilterExpression: { metaTemplateId: { $type: 'string' } } }
);
whatsAppTemplateSchema.index({ ownerAdminId: 1, localState: 1 });
whatsAppTemplateSchema.index({ eventId: 1 });
// Submissions in the last hour, per account (Meta allows 100 per hour).
whatsAppTemplateSchema.index({ wabaId: 1, 'submission.startedAt': -1 });

export const WhatsAppTemplate = mongoose.model<IWhatsAppTemplate>('WhatsAppTemplate', whatsAppTemplateSchema);
