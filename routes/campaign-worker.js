/**
 * Campaign Worker - Cron-based Email Processing
 * 
 * This worker processes emails in batches, called by Vercel cron every minute.
 * Designed for serverless environments where long-running processes are not possible.
 */

import express from 'express';
import { supabase } from '../services/supabase.js';
import { createTransporterFromCredentials, injectTracking } from '../services/email.js';
import { sanitizeEmailHeader, sanitizeHtml } from '../services/helpers.js';
import { campaignQueue, isUpstashConfigured } from '../services/redis.js';
import { isVercel } from '../config/index.js';

const router = express.Router();

// Configuration for batch processing
const BATCH_CONFIG = {
  // Maximum emails to process per cron invocation (keep under timeout)
  MAX_EMAILS_PER_RUN: isVercel ? 3 : 10, // Conservative for Vercel (10s timeout on free)
  // Minimum delay between emails within a batch (ms)
  MIN_INTERNAL_DELAY: 2000,
  // Cron secret for authentication (set in Vercel env)
  CRON_SECRET: process.env.CRON_SECRET,
};

/**
 * Process pending emails for all running campaigns
 * Called by Vercel cron every minute
 * 
 * GET /api/campaign-worker/process
 */
router.get('/process', async (req, res) => {
  // Verify cron secret in production
  if (isVercel && BATCH_CONFIG.CRON_SECRET) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${BATCH_CONFIG.CRON_SECRET}`) {
      console.warn('Unauthorized cron attempt');
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
  }

  console.log('🔄 Campaign worker started');
  const startTime = Date.now();
  const results = { processed: 0, sent: 0, failed: 0, campaigns: [] };

  try {
    // Get all running campaigns
    const { data: campaigns, error: campaignsError } = await supabase
      .from('campaigns')
      .select('*')
      .eq('status', 'running')
      .order('started_at', { ascending: true });

    if (campaignsError) {
      throw campaignsError;
    }

    if (!campaigns || campaigns.length === 0) {
      console.log('No running campaigns to process');
      return res.json({ success: true, message: 'No campaigns to process', results });
    }

    console.log(`Found ${campaigns.length} running campaign(s)`);

    // Process each campaign
    for (const campaign of campaigns) {
      // Check time budget (leave 2s buffer)
      if (isVercel && Date.now() - startTime > 8000) {
        console.log('Time budget exhausted, stopping');
        break;
      }

      const campaignResult = await processCampaignBatch(campaign);
      results.campaigns.push({
        id: campaign.id,
        name: campaign.name,
        ...campaignResult,
      });
      results.processed += campaignResult.processed;
      results.sent += campaignResult.sent;
      results.failed += campaignResult.failed;
    }

    console.log(`✅ Worker completed: ${results.sent} sent, ${results.failed} failed`);
    res.json({ success: true, results });

  } catch (err) {
    console.error('❌ Worker error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Process a batch of emails for a single campaign
 */
async function processCampaignBatch(campaign) {
  const result = { processed: 0, sent: 0, failed: 0, completed: false };
  let transporter = null;

  try {
    // Get credentials
    let credentials = null;
    
    if (isUpstashConfigured) {
      const queueData = await campaignQueue.getStatus(campaign.id, campaign.user_id);
      credentials = queueData?.credentials;
    } else if (campaign.credentials_temp) {
      credentials = JSON.parse(campaign.credentials_temp);
    }

    if (!credentials) {
      console.error(`No credentials for campaign ${campaign.id}`);
      await markCampaignError(campaign.id, 'Missing credentials - please resume campaign with credentials');
      return result;
    }

    // Create transporter
    transporter = createTransporterFromCredentials(credentials);

    // Get pending emails (limited batch)
    const { data: pendingEmails, error: emailsError } = await supabase
      .from('campaign_emails')
      .select('*')
      .eq('campaign_id', campaign.id)
      .eq('status', 'pending')
      .order('sort_order')
      .limit(BATCH_CONFIG.MAX_EMAILS_PER_RUN);

    if (emailsError) {
      throw emailsError;
    }

    if (!pendingEmails || pendingEmails.length === 0) {
      // Campaign complete
      await completeCampaign(campaign.id, campaign.user_id);
      result.completed = true;
      return result;
    }

    // Get template data
    let template = { subject: campaign.template_subject, body: campaign.template_body };
    let templateData = {};
    
    if (campaign.template_data) {
      templateData = JSON.parse(campaign.template_data);
    }
    
    if (isUpstashConfigured) {
      const queueData = await campaignQueue.getStatus(campaign.id, campaign.user_id);
      if (queueData?.template) {
        template = queueData.template;
      }
    }

    const senderName = campaign.sender_name || credentials.senderName;
    const enableTracking = templateData.enableTracking !== false;

    // Process each email in batch
    for (const emailRecord of pendingEmails) {
      try {
        // Verify campaign is still running
        const { data: currentCampaign } = await supabase
          .from('campaigns')
          .select('status')
          .eq('id', campaign.id)
          .single();

        if (currentCampaign?.status !== 'running') {
          console.log(`Campaign ${campaign.id} is ${currentCampaign?.status}, stopping batch`);
          break;
        }

        // Personalize template
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

        // Inject tracking
        if (enableTracking && emailRecord.tracking_id) {
          htmlBody = injectTracking(htmlBody, emailRecord.tracking_id, true);
        }

        // Send email
        await transporter.sendMail({
          from: `"${sanitizedSenderName}" <${credentials.emailUser}>`,
          to: emailRecord.email,
          subject: sanitizedSubject,
          html: htmlBody,
          text: htmlBody.replace(/<[^>]+>/g, ''),
        });

        // Mark as sent
        await supabase
          .from('campaign_emails')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', emailRecord.id);

        // Update campaign count
        await incrementCampaignSent(campaign.id);
        
        result.sent++;
        result.processed++;
        console.log(`✅ Sent to ${emailRecord.email}`);

        // Small delay between emails
        if (pendingEmails.indexOf(emailRecord) < pendingEmails.length - 1) {
          await sleep(BATCH_CONFIG.MIN_INTERNAL_DELAY);
        }

      } catch (sendError) {
        console.error(`❌ Failed to send to ${emailRecord.email}:`, sendError.message);
        
        // Mark as failed
        await supabase
          .from('campaign_emails')
          .update({ status: 'failed', error_message: sendError.message })
          .eq('id', emailRecord.id);

        // Update failed count
        await incrementCampaignFailed(campaign.id);
        
        result.failed++;
        result.processed++;
      }
    }

    // Update next_email_at for UI countdown
    const nextEmailAt = new Date(Date.now() + 60000).toISOString(); // Next cron in ~1 minute
    await supabase
      .from('campaigns')
      .update({ next_email_at: nextEmailAt, current_email: pendingEmails[pendingEmails.length - 1]?.email })
      .eq('id', campaign.id);

    return result;

  } catch (err) {
    console.error(`Campaign ${campaign.id} batch error:`, err);
    await markCampaignError(campaign.id, err.message);
    return result;
  } finally {
    if (transporter) {
      transporter.close();
    }
  }
}

async function completeCampaign(campaignId, userId) {
  console.log(`✅ Completing campaign ${campaignId}`);
  
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

async function markCampaignError(campaignId, errorMessage) {
  await supabase
    .from('campaigns')
    .update({ status: 'error', error_message: errorMessage })
    .eq('id', campaignId);
}

async function incrementCampaignSent(campaignId) {
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

async function incrementCampaignFailed(campaignId) {
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default router;
