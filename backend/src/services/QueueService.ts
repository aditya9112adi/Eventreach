import { Campaign } from '../models/Campaign';
import { Contact } from '../models/Contact';
import { Event } from '../models/Event';
import { MessageLog } from '../models/MessageLog';
import { whatsappService } from './WhatsAppService';
import { getIO } from './socketService';

export class QueueService {
  
  async processCampaign(campaignId: string, recipientIds?: string[], messageText?: string, mediaAttachments?: any[]) {
    try {
      const campaign = await Campaign.findById(campaignId).populate('eventId');
      if (!campaign) throw new Error('Campaign not found');

      const event = campaign.eventId as any; // populated event doc
      const eventName = event.eventName;
      const venue = event.eventVenue;

      // 1. Fetch contacts for this event. If recipientIds is provided, filter by it.
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

      // 2. Create MessageLogs in 'Pending' state
      const logsToInsert = contacts.map(c => ({
        campaignId,
        contactId: c._id,
        phoneNumber: c.phoneNumber,
        status: 'Pending'
      }));
      
      const insertedLogs = await MessageLog.insertMany(logsToInsert);

      // Match contacts with their specific log ID for this run
      const contactsWithLogs = contacts.map((c, index) => ({
        contact: c,
        logId: insertedLogs[index]._id
      }));

      // 3. Process Async in Batches
      // Fire and forget (in a real production system, this would be pushed to Redis/BullMQ)
      
      // Fallback to history if not provided directly
      let activeMsgText = messageText !== undefined ? messageText : campaign.messageText;
      let activeAttachments = mediaAttachments !== undefined ? mediaAttachments : campaign.mediaAttachments;
      
      if (!activeMsgText && !activeAttachments?.length && campaign.history?.length > 0) {
        const lastHistory = campaign.history[campaign.history.length - 1];
        activeMsgText = lastHistory.messageText;
        activeAttachments = lastHistory.mediaAttachments;
      }
      
      this.processBatch(campaignId, contactsWithLogs, activeMsgText, activeAttachments, eventName, venue).catch(err => {
        console.error('Async batch processing failed:', err);
      });

    } catch (error) {
      console.error('Queue processing error:', error);
      await Campaign.findByIdAndUpdate(campaignId, { status: 'Draft' });
      throw error;
    }
  }

  private async processBatch(campaignId: string, contactsWithLogs: any[], messageText: string, mediaAttachments: any[], eventName: string, venue: string) {
    const BATCH_SIZE = 10;
    const DELAY_BETWEEN_BATCHES_MS = 2000;

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
          // Send via WA Service
          await whatsappService.sendMessage(contact.phoneNumber, personalizedMsg, mediaAttachments);
          
          // Update log using specific logId
          await MessageLog.findByIdAndUpdate(
            logId,
            { status: 'Sent' }
          );
          
          try {
            getIO().emit('message-log-updated', { logId, status: 'Sent', campaignId });
            getIO().emit('dashboard-updated');
          } catch (e) {}
        } catch (err: any) {
          // Update log with failure using specific logId
          await MessageLog.findByIdAndUpdate(
            logId,
            { status: 'Failed', errorReason: err.message }
          );
          
          try {
            getIO().emit('message-log-updated', { logId, status: 'Failed', campaignId, errorReason: err.message });
            getIO().emit('dashboard-updated');
          } catch (e) {}
        }
      });

      // Wait for the batch to complete
      await Promise.allSettled(promises);

      // Delay to respect rate limits
      if (i + BATCH_SIZE < contactsWithLogs.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
      }
    }

    // Mark campaign as completed
    await Campaign.findByIdAndUpdate(campaignId, { status: 'Completed', messageText: '', mediaAttachments: [] });
    console.log(`Campaign ${campaignId} processing completed.`);
  }
}

export const queueService = new QueueService();




