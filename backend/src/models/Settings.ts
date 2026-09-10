import mongoose, { Schema, Document } from 'mongoose';

export interface ISettings extends Document {
  key: string;
  value: string;
  updatedAt: Date;
}

const settingsSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
      // Mirrors ALLOWED_KEYS in settingsController — the only keys the API writes.
      enum: ['whatsapp_token', 'whatsapp_phone_id', 'default_country_code', 'company_name', 'webhook_verify_token']
    },
    value: {
      type: String,
      default: ''
    }
  },
  { timestamps: true }
);

export const Settings = mongoose.model<ISettings>('Settings', settingsSchema);
