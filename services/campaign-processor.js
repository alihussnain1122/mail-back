// campaign-processor.js
// Contains core campaign logic split from campaign.js route file.

import { supabase } from '../services/supabase.js';
import { createTransporterFromCredentials, injectTracking } from '../services/email.js';
import { sanitizeEmailHeader, sanitizeHtml } from '../services/helpers.js';
import { campaignQueue, isUpstashConfigured } from '../services/redis.js';
import { CONFIG } from '../config/index.js';

export const LIMITS = {
  MAX_CONTACTS_PER_CAMPAIGN: 1000,
  MAX_CONCURRENT_CAMPAIGNS: 3,
  MIN_DELAY_MS: 5000,
  MAX_DELAY_MS: 300000,
  DEFAULT_MIN_DELAY_MS: 10000,
  DEFAULT_MAX_DELAY_MS: 30000,
};

export async function processCampaign(campaignId, userId) {
  let transporter = null;
  try {
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .eq('user_id', userId)
      .single();
    if (campaignError || !campaign) return;
    let queueData = null;
    if (isUpstashConfigured) {
      queueData = await campaignQueue.getStatus(campaignId, userId);
    } else if (campaign.credentials_temp && campaign.template_data) {
      queueData = {
        credentials: JSON.parse(campaign.credentials_temp),
        ...JSON.parse(campaign.template_data),
      };
    }
    if (!queueData?.credentials) {
      await supabase
        .from('campaigns')
        .update({ status: 'error', error_message: 'Missing credentials' })
        .eq('id', campaignId);
      return;
    }
    const { credentials, template, senderName, delayMin, delayMax, enableTracking } = queueData;
    transporter = createTransporterFromCredentials(credentials);
    const { data: pendingEmails, error: emailsError } = await supabase
      .from('campaign_emails')
      .select('*')
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')
      .order('sort_order')
      .limit(100);
    if (emailsError) throw emailsError;
    if (!pendingEmails || pendingEmails.length === 0) {
      await supabase
        .from('campaigns')
        .update({ status: 'completed', completed_at: new Date().toISOString(), credentials_temp: null, template_data: null })
        .eq('id', campaignId);
      if (isUpstashConfigured) await campaignQueue.dequeue(campaignId, userId);
      return;
    }
    const STATUS_CHECK_INTERVAL = 10;
    let shouldStop = false;
    for (let i = 0; i < pendingEmails.length; i++) {
      const emailRecord = pendingEmails[i];
      if (i % STATUS_CHECK_INTERVAL === 0) {
        const { data: currentCampaign } = await supabase
          .from('campaigns')
          .select('status')
          .eq('id', campaignId)
          .single();
        if (currentCampaign?.status !== 'running') {
          shouldStop = true;
          break;
        }
      }
      if (shouldStop) break;
      try {
        let personalizedSubject = template.subject;
        let personalizedBody = template.body;
        const contact = emailRecord.contact_data || {};
        const variables = {
          email: emailRecord.email,
          firstName: contact.firstName || contact.name?.split(' ')[0] || '',
          lastName: contact.lastName || contact.name?.split(' ').slice(1).join(' ') || '',
          company: contact.company || '',
          position: contact.position || '',
          ...contact,
        };
        Object.entries(variables).forEach(([key, value]) => {
          const regex = new RegExp(`{{${key}}}`, 'gi');
          personalizedSubject = personalizedSubject.replace(regex, value || '');
          personalizedBody = personalizedBody.replace(regex, value || '');
        });
        const sanitizedSubject = sanitizeEmailHeader(personalizedSubject);
        const sanitizedSenderName = sanitizeEmailHeader(senderName || credentials.senderName || 'Support Team');
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
        const { error: rpcError } = await supabase.rpc('increment_campaign_sent', { campaign_id: campaignId });
        if (rpcError) {
          const { data: currentCampaign } = await supabase
            .from('campaigns')
            .select('sent_count')
            .eq('id', campaignId)
            .single();
          if (currentCampaign) {
            await supabase
              .from('campaigns')
              .update({ sent_count: (currentCampaign.sent_count || 0) + 1 })
              .eq('id', campaignId);
          }
        }
      } catch (sendError) {
        await supabase
          .from('campaign_emails')
          .update({ status: 'failed', error_message: sendError.message })
          .eq('id', emailRecord.id);
        const { error: rpcError } = await supabase.rpc('increment_campaign_failed', { campaign_id: campaignId });
        if (rpcError) {
          const { data: currentCampaign } = await supabase
            .from('campaigns')
            .select('failed_count')
            .eq('id', campaignId)
            .single();
          if (currentCampaign) {
            await supabase
              .from('campaigns')
              .update({ failed_count: (currentCampaign.failed_count || 0) + 1 })
              .eq('id', campaignId);
          }
        }
      }
      const minDelay = delayMin || LIMITS.DEFAULT_MIN_DELAY_MS;
      const maxDelay = delayMax || LIMITS.DEFAULT_MAX_DELAY_MS;
      const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      const nextEmailAt = new Date(Date.now() + randomDelay).toISOString();
      await supabase
        .from('campaigns')
        .update({ next_email_at: nextEmailAt })
        .eq('id', campaignId);
      await new Promise(resolve => setTimeout(resolve, randomDelay));
    }
    const { data: remaining } = await supabase
      .from('campaign_emails')
      .select('id')
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')
      .limit(1);
    if (remaining && remaining.length > 0) {
      setImmediate(() => processCampaign(campaignId, userId));
    } else {
      await supabase
        .from('campaigns')
        .update({ status: 'completed', completed_at: new Date().toISOString(), credentials_temp: null, template_data: null })
        .eq('id', campaignId);
      if (isUpstashConfigured) await campaignQueue.dequeue(campaignId, userId);
    }
  } catch (err) {
    await supabase
      .from('campaigns')
      .update({ status: 'error', error_message: err.message })
      .eq('id', campaignId);
  } finally {
    if (transporter) transporter.close();
  }
}
