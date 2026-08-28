import { Campaign } from '../models/Campaign';
import { Contact } from '../models/Contact';
import { Event } from '../models/Event';
import { MessageLog } from '../models/MessageLog';
import { whatsappService } from './WhatsAppService';
import { getIO } from './socketService';

import { AuditService } from './AuditService';

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
      
      this.processBatch(campaignId, contactsWithLogs, activeMsgText, activeAttachments, eventName, venue, auditInfo).catch(err => {
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
          await whatsappService.sendMessage(contact.phoneNumber, personalizedMsg, mediaAttachments);
          await MessageLog.findByIdAndUpdate(logId, { status: 'Sent' });
          successfulRecords++;
          try {
            getIO().emit('message-log-updated', { logId, status: 'Sent', campaignId });
            getIO().emit('dashboard-updated');
          } catch (e) {}
        } catch (err: any) {
          await MessageLog.findByIdAndUpdate(logId, { status: 'Failed', errorReason: err.message });
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




