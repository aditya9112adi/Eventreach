import { Campaign } from '../models/Campaign';
import { Contact } from '../models/Contact';
import { Event } from '../models/Event';
import { MessageLog } from '../models/MessageLog';
import { whatsappService } from './WhatsAppService';
import { getIO } from './socketService';
import path from 'path';
import fs from 'fs';
import { UPLOAD_DIR } from '../middleware/mediaUpload';
import { WHATSAPP_MEDIA_RULES } from '@eventreach/shared';

import { AuditService } from './AuditService';

/**
 * Turn stored attachments into ones WhatsApp can send, by uploading each file
 * to Meta and keeping the returned media ID.
 *
 * The stored `url` is a local path behind an authenticated route on an
 * ephemeral disk, so it is resolved to a file on disk here and never handed
 * to WhatsApp as a link — WhatsApp could not fetch it.
 *
 * Throws on the first failure: if any attachment cannot be uploaded the
 * campaign cannot be sent as composed, and the caller marks every recipient
 * Failed with the reason rather than silently sending a message missing its
 * media.
 */
const prepareMediaForSending = async (attachments: any[]): Promise<any[]> => {
  const out: any[] = [];

  for (const att of attachments) {
    const fileName = path.basename(String(att?.url || ''));
    if (!fileName) throw new Error('A campaign attachment has no stored file.');

    const filePath = path.join(UPLOAD_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      // The host's disk is ephemeral, so a file uploaded before a restart or
      // redeploy is simply gone. Say so plainly rather than failing on an
      // opaque ENOENT deep inside the uploader.
      throw new Error(
        `The attached file "${att?.filename || fileName}" is no longer available on the server. Please re-upload it and send again.`
      );
    }

    // Prefer the type recorded at upload time; fall back to the extension for
    // attachments saved before that field existed.
    const ext = path.extname(fileName).toLowerCase();
    const mimeType: string =
      att?.mimeType ||
      Object.keys(WHATSAPP_MEDIA_RULES).find((m) => WHATSAPP_MEDIA_RULES[m].extensions.includes(ext)) ||
      '';
    if (!mimeType) {
      throw new Error(`The attached file "${att?.filename || fileName}" is not a type WhatsApp accepts.`);
    }

    const metaMediaId = await whatsappService.uploadMediaToMeta(filePath, mimeType, att?.filename || fileName);

    out.push({
      ...att,
      metaMediaId,
      mimeType,
      supportsCaption: WHATSAPP_MEDIA_RULES[mimeType]?.supportsCaption ?? false,
    });
  }

  return out;
};

export class QueueService {

  async processCampaign(campaignId: string, recipientIds?: string[], messageText?: string, mediaAttachments?: any[], auditInfo?: any) {
    try {
      const campaign = await Campaign.findById(campaignId).populate('eventId');
      if (!campaign) throw new Error('Campaign not found');

      const event = campaign.eventId as any; // populated event doc
      const eventName = event.eventName;
      const venue = event.eventVenue;

      let query: any = { eventId: event._id, status: 'Valid' };
      if (recipientIds && Array.isArray(recipientIds) && recipientIds.length > 0) {
        query._id = { $in: recipientIds };
      }
      
      const contacts = await Contact.find(query);
      
      if (contacts.length === 0) {
        campaign.status = 'Completed';
        campaign.messageText = '';
        campaign.mediaAttachments = [];
        await campaign.save();
        return;
      }

      const logsToInsert = contacts.map(c => ({
        campaignId,
        contactId: c._id,
        // Denormalised so the report still names the recipient even if the
        // contact is later deleted.
        contactName: c.fullName,
        phoneNumber: c.phoneNumber,
        status: 'Pending'
      }));
      
      const insertedLogs = await MessageLog.insertMany(logsToInsert);

      const contactsWithLogs = contacts.map((c, index) => ({
        contact: c,
        logId: insertedLogs[index]._id
      }));

      let activeMsgText = messageText !== undefined ? messageText : campaign.messageText;
      let activeAttachments = mediaAttachments !== undefined ? mediaAttachments : campaign.mediaAttachments;
      
      if (!activeMsgText && !activeAttachments?.length && campaign.history?.length > 0) {
        const lastHistory = campaign.history[campaign.history.length - 1];
        activeMsgText = lastHistory.messageText;
        activeAttachments = lastHistory.mediaAttachments;
      }
      
      /**
       * Media is uploaded to WhatsApp once here, before the batch starts, and
       * the resulting media ID is reused for every recipient — re-uploading
       * the same file per recipient would be slow and pointless.
       *
       * If the upload fails there is no message to send to anyone, so every
       * recipient is marked Failed with Meta's own reason rather than left
       * Pending forever. That keeps the reporting contract identical to a
       * text send: each recipient ends in a terminal state with a cause.
       */
      let preparedAttachments: any[] = [];
      if (activeAttachments?.length) {
        try {
          preparedAttachments = await prepareMediaForSending(activeAttachments);
        } catch (err: any) {
          const failedAt = new Date();
          await MessageLog.updateMany(
            { _id: { $in: insertedLogs.map((l: any) => l._id) } },
            {
              $set: {
                status: 'Failed',
                errorCode: typeof err?.code === 'number' ? err.code : undefined,
                errorReason: err?.message || 'Failed to upload media to WhatsApp',
                failedAt,
              },
            }
          );
          await Campaign.findByIdAndUpdate(campaignId, { status: 'Completed' });
          try {
            getIO().emit('message-log-updated', { campaignId });
            getIO().emit('dashboard-updated');
          } catch (e) {}
          return;
        }
      }

      this.processBatch(campaignId, contactsWithLogs, activeMsgText, preparedAttachments, eventName, venue, auditInfo).catch(err => {
        console.error('Async batch processing failed:', err);
      });

    } catch (error) {
      console.error('Queue processing error:', error);
      await Campaign.findByIdAndUpdate(campaignId, { status: 'Draft' });
      throw error;
    }
  }

  private async processBatch(campaignId: string, contactsWithLogs: any[], messageText: string, mediaAttachments: any[], eventName: string, venue: string, auditInfo?: any) {
    const BATCH_SIZE = 10;
    const DELAY_BETWEEN_BATCHES_MS = 2000;
    let successfulRecords = 0;
    let failedRecords = 0;

    for (let i = 0; i < contactsWithLogs.length; i += BATCH_SIZE) {
      const batch = contactsWithLogs.slice(i, i + BATCH_SIZE);
      
      const promises = batch.map(async (item) => {
        const { contact, logId } = item;
        // Interpolate variables
        let personalizedMsg = messageText || '';
        personalizedMsg = personalizedMsg.replace(/{{fullName}}/g, contact.fullName);
        personalizedMsg = personalizedMsg.replace(/{{eventName}}/g, eventName);
        personalizedMsg = personalizedMsg.replace(/{{venue}}/g, venue);

        try {
          const result = await whatsappService.sendMessage(contact.phoneNumber, personalizedMsg, mediaAttachments);
          // 'Sent' here means ACCEPTED BY WHATSAPP, not received by the
          // handset. The wamid is what lets the delivery webhook find this
          // row again when the real outcome arrives.
          await MessageLog.findByIdAndUpdate(logId, {
            status: 'Sent',
            wamid: result.wamid,
            messageText: personalizedMsg,
            sentAt: new Date(),
          });
          successfulRecords++;
          try {
            getIO().emit('message-log-updated', { logId, status: 'Sent', campaignId });
            getIO().emit('dashboard-updated');
          } catch (e) {}
        } catch (err: any) {
          // A synchronous rejection from Meta carries its own numeric code
          // (e.g. 131047), which is far more actionable than the message text.
          await MessageLog.findByIdAndUpdate(logId, {
            status: 'Failed',
            messageText: personalizedMsg,
            errorCode: typeof err?.code === 'number' ? err.code : undefined,
            errorReason: err?.message,
            failedAt: new Date(),
          });
          failedRecords++;
          try {
            getIO().emit('message-log-updated', { logId, status: 'Failed', campaignId, errorReason: err.message });
            getIO().emit('dashboard-updated');
          } catch (e) {}
        }
      });

      await Promise.allSettled(promises);

      if (i + BATCH_SIZE < contactsWithLogs.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
      }
    }

    await Campaign.findByIdAndUpdate(campaignId, { status: 'Completed', messageText: '', mediaAttachments: [] });
    
    if (auditInfo) {
      await AuditService.log({
        action: 'BULK_MESSAGE_COMPLETED',
        collectionName: 'messagelogs',
        actor: auditInfo.actor,
        request: auditInfo.request,
        bulkOperationId: auditInfo.bulkOperationId,
        bulk: {
          isBulk: true,
          operationType: 'MESSAGE_SEND',
          totalRecords: contactsWithLogs.length,
          successfulRecords,
          failedRecords
        },
        description: `Campaign messaging completed. Sent: ${successfulRecords}, Failed: ${failedRecords}`
      });
    }
    
    console.log(`Campaign ${campaignId} processing completed.`);
  }
}

export const queueService = new QueueService();




