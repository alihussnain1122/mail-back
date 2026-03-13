// campaignWorkerService.js
// Contains core logic for campaign batch processing, separated from the route handler.

import { supabase } from '../services/supabase.js';
import { createTransporterFromCredentials, injectTracking } from '../services/email.js';
import { sanitizeEmailHeader, sanitizeHtml } from '../services/helpers.js';
import { campaignQueue, isUpstashConfigured } from '../services/redis.js';

// Configuration for batch processing
import { isVercel } from '../config/index.js';
const BATCH_CONFIG = {
  MAX_EMAILS_PER_RUN: isVercel ? 3 : 10,
  MIN_INTERNAL_DELAY: 2000,
};

export async function processCampaignBatch(campaign) {
  const result = { processed: 0, sent: 0, failed: 0, completed: false };
  let transporter = null;
  try {
    let credentials = null;
    if (isUpstashConfigured) {
      const queueData = await campaignQueue.getStatus(campaign.id, campaign.user_id);
      credentials = queueData?.credentials;
    } else if (campaign.credentials_temp) {
      credentials = JSON.parse(campaign.credentials_temp);
    }
    if (!credentials) {
      await markCampaignError(campaign.id, 'Missing credentials - please resume campaign with credentials');
      return result;
    }
    transporter = createTransporterFromCredentials(credentials);
    const { data: pendingEmails, error: emailsError } = await supabase
      .from('campaign_emails')
      .select('*')
      .eq('campaign_id', campaign.id)
      .eq('status', 'pending')
      .order('sort_order')
      .limit(BATCH_CONFIG.MAX_EMAILS_PER_RUN);
    if (emailsError) throw emailsError;
    if (!pendingEmails || pendingEmails.length === 0) {
      await completeCampaign(campaign.id, campaign.user_id);
      result.completed = true;
      return result;
    }
    let template = { subject: campaign.template_subject, body: campaign.template_body };
    let templateData = {};
    if (campaign.template_data) templateData = JSON.parse(campaign.template_data);
    if (isUpstashConfigured) {
      const queueData = await campaignQueue.getStatus(campaign.id, campaign.user_id);
      if (queueData?.template) template = queueData.template;
    }
    const senderName = campaign.sender_name || credentials.senderName;
    const enableTracking = templateData.enableTracking !== false;
    for (const emailRecord of pendingEmails) {
      try {
        const { data: currentCampaign } = await supabase
          .from('campaigns')
          .select('status')
          .eq('id', campaign.id)
          .single();
        if (currentCampaign?.status !== 'running') break;
        const contact = emailRecord.contact_data || {};
        const variables = {
          email: emailRecord.email,
          firstName: contact.firstName || contact.name?.split(' ')[0] || '',
          lastName: contact.lastName || contact.name?.split(' ').slice(1).join(' ') || '',
          company: contact.company || '',
          position: contact.position || '',
          ...contact,
        };
        let personalizedSubject = template.subject;
        let personalizedBody = template.body;
        Object.entries(variables).forEach(([key, value]) => {
          const regex = new RegExp(`{{${key}}}`, 'gi');
          personalizedSubject = personalizedSubject.replace(regex, value || '');
          personalizedBody = personalizedBody.replace(regex, value || '');
        });
        const sanitizedSubject = sanitizeEmailHeader(personalizedSubject);
        const sanitizedSenderName = sanitizeEmailHeader(senderName || 'Support Team');
        let htmlBody = sanitizeHtml(personalizedBody).replace(/\n/g, '<br>');
        if (enableTracking && emailRecord.tracking_id) {
          htmlBody = injectTracking(htmlBody, emailRecord.tracking_id, true);
        }
        await transporter.sendMail({
          from: `"${sanitizedSenderName}" <${credentials.emailUser}>`,
          to: emailRecord.email,
          subject: sanitizedSubject,
          html: htmlBody,
          text: htmlBody.replace(/<[^>]+>/g, ''),
        });
        await supabase
          .from('campaign_emails')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', emailRecord.id);
        await incrementCampaignSent(campaign.id);
        result.sent++;
        result.processed++;
        if (pendingEmails.indexOf(emailRecord) < pendingEmails.length - 1) {
          await sleep(BATCH_CONFIG.MIN_INTERNAL_DELAY);
        }
      } catch (sendError) {
        await supabase
          .from('campaign_emails')
          .update({ status: 'failed', error_message: sendError.message })
          .eq('id', emailRecord.id);
        await incrementCampaignFailed(campaign.id);
        result.failed++;
        result.processed++;
      }
    }
    const nextEmailAt = new Date(Date.now() + 60000).toISOString();
    await supabase
      .from('campaigns')
      .update({ next_email_at: nextEmailAt, current_email: pendingEmails[pendingEmails.length - 1]?.email })
      .eq('id', campaign.id);
    return result;
  } catch (err) {
    await markCampaignError(campaign.id, err.message);
    return result;
  } finally {
    if (transporter) transporter.close();
  }
}

export async function completeCampaign(campaignId, userId) {
  await supabase
    .from('campaigns')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      credentials_temp: null,
      template_data: null,
    })
    .eq('id', campaignId);
  if (isUpstashConfigured) {
    await campaignQueue.dequeue(campaignId, userId);
  }
}

export async function markCampaignError(campaignId, errorMessage) {
  await supabase
    .from('campaigns')
    .update({ status: 'error', error_message: errorMessage })
    .eq('id', campaignId);
}

export async function incrementCampaignSent(campaignId) {
  const { error: rpcError } = await supabase.rpc('increment_campaign_sent', { campaign_id: campaignId });
  if (rpcError) {
    const { data: current } = await supabase
      .from('campaigns')
      .select('sent_count')
      .eq('id', campaignId)
      .single();
    if (current) {
      await supabase
        .from('campaigns')
        .update({ sent_count: (current.sent_count || 0) + 1 })
        .eq('id', campaignId);
    }
  }
}

export async function incrementCampaignFailed(campaignId) {
  const { error: rpcError } = await supabase.rpc('increment_campaign_failed', { campaign_id: campaignId });
  if (rpcError) {
    const { data: current } = await supabase
      .from('campaigns')
      .select('failed_count')
      .eq('id', campaignId)
      .single();
    if (current) {
      await supabase
        .from('campaigns')
        .update({ failed_count: (current.failed_count || 0) + 1 })
        .eq('id', campaignId);
    }
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
