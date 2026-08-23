import { Campaign } from '../models/Campaign';
import { Contact } from '../models/Contact';
import { Event } from '../models/Event';
import { MessageLog } from '../models/MessageLog';
import { whatsappService } from './WhatsAppService';

export class QueueService {
  
  async processCampaign(campaignId: string, recipientIds?: string[], messageText?: string, mediaAttachments?: any[]) {
    try {
      const campaign = await Campaign.findById(campaignId).populate('eventId');
      if (!campaign) throw new Error('Campaign not found');

      const event = campaign.eventId as any; // populated event doc
      const eventName = event.name;
      const venue = event.venue;

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
      
      await MessageLog.insertMany(logsToInsert);

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
      
      this.processBatch(campaignId, contacts, activeMsgText, activeAttachments, eventName, venue).catch(err => {
        console.error('Async batch processing failed:', err);
      });

    } catch (error) {
      console.error('Queue processing error:', error);
      await Campaign.findByIdAndUpdate(campaignId, { status: 'Draft' });
      throw error;
    }
  }

  private async processBatch(campaignId: string, contacts: any[], messageText: string, mediaAttachments: any[], eventName: string, venue: string) {
    const BATCH_SIZE = 10;
    const DELAY_BETWEEN_BATCHES_MS = 2000;

    for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
      const batch = contacts.slice(i, i + BATCH_SIZE);
      
      const promises = batch.map(async (contact) => {
        // Interpolate variables
        let personalizedMsg = messageText || '';
        personalizedMsg = personalizedMsg.replace(/{{fullName}}/g, contact.fullName);
        personalizedMsg = personalizedMsg.replace(/{{eventName}}/g, eventName);
        personalizedMsg = personalizedMsg.replace(/{{venue}}/g, venue);

        try {
          // Send via WA Service
          await whatsappService.sendMessage(contact.phoneNumber, personalizedMsg, mediaAttachments);
          
          // Update log
          await MessageLog.findOneAndUpdate(
            { campaignId, contactId: contact._id },
            { status: 'Sent' }
          );
        } catch (err: any) {
          // Update log with failure
          await MessageLog.findOneAndUpdate(
            { campaignId, contactId: contact._id },
            { status: 'Failed', errorReason: err.message }
          );
        }
      });

      // Wait for the batch to complete
      await Promise.allSettled(promises);

      // Delay to respect rate limits
      if (i + BATCH_SIZE < contacts.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
      }
    }

    // Mark campaign as completed
    await Campaign.findByIdAndUpdate(campaignId, { status: 'Completed', messageText: '', mediaAttachments: [] });
    console.log(`Campaign ${campaignId} processing completed.`);
  }
}

export const queueService = new QueueService();


