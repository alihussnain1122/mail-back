/**
 * Campaign Queue Routes
 * Server-side email campaign execution
 */

import express from 'express';
import { body } from 'express-validator';
import { handleValidationErrors } from '../middleware/validation.js';
import { requireAuth, requireOwnership } from '../middleware/auth.js';
import { redisCampaignLimiter, campaignQueue, redis, isUpstashConfigured } from '../services/redis.js';
import { supabase } from '../services/supabase.js';
import { 
  validateCredentials, 
  sanitizeEmailHeader, 
  sanitizeHtml, 
  generateTrackingId,
  hashEmail 
} from '../services/helpers.js';
import { createTransporterFromCredentials, injectTracking } from '../services/email.js';
import { CONFIG } from '../config/index.js';

const router = express.Router();

// Campaign limits
const LIMITS = {
  MAX_CONTACTS_PER_CAMPAIGN: 1000,   // Maximum contacts in one campaign
  MAX_CONCURRENT_CAMPAIGNS: 3,       // Max campaigns running at once per user
  MIN_DELAY_MS: 5000,                // Minimum 5 seconds between emails
  MAX_DELAY_MS: 300000,              // Maximum 5 minutes between emails
  DEFAULT_MIN_DELAY_MS: 10000,       // Default minimum 10 seconds
  DEFAULT_MAX_DELAY_MS: 30000,       // Default maximum 30 seconds
};

/**
 * Start a new campaign (queued server-side)
 */
router.post('/start',
  requireAuth,
  redisCampaignLimiter,
  body('contacts').isArray({ min: 1, max: LIMITS.MAX_CONTACTS_PER_CAMPAIGN })
    .withMessage(`Contacts must be an array with 1-${LIMITS.MAX_CONTACTS_PER_CAMPAIGN} items`),
  body('template.subject').notEmpty().withMessage('Template subject is required'),
  body('template.body').notEmpty().withMessage('Template body is required'),
  body('credentials').notEmpty().withMessage('SMTP credentials are required'),
  body('delayMin').optional().isInt({ min: LIMITS.MIN_DELAY_MS, max: LIMITS.MAX_DELAY_MS }),
  body('delayMax').optional().isInt({ min: LIMITS.MIN_DELAY_MS, max: LIMITS.MAX_DELAY_MS }),
  handleValidationErrors,
  async (req, res) => {
    const { 
      contacts, 
      template, 
      credentials, 
      senderName, 
      delayMin = LIMITS.DEFAULT_MIN_DELAY_MS,
      delayMax = LIMITS.DEFAULT_MAX_DELAY_MS,
      campaignName,
      enableTracking = true,
    } = req.body;
    
    const userId = req.user.id;

    // Validate credentials
    const credError = validateCredentials(credentials);
    if (credError) {
      return res.status(400).json({ success: false, error: credError });
    }

    // Verify SMTP connection before starting
    let transporter;
    try {
      transporter = createTransporterFromCredentials(credentials);
      await transporter.verify();
      transporter.close();
    } catch (err) {
      return res.status(400).json({ 
        success: false, 
        error: `SMTP connection failed: ${err.message}` 
      });
    }

    // Check concurrent campaign limit
    if (isUpstashConfigured) {
      const activeCampaigns = await campaignQueue.getUserCampaigns(userId);
      const runningCampaigns = activeCampaigns.filter(c => c.status === 'running' || c.status === 'queued');
      
      if (runningCampaigns.length >= LIMITS.MAX_CONCURRENT_CAMPAIGNS) {
        return res.status(429).json({
          success: false,
          error: `Maximum ${LIMITS.MAX_CONCURRENT_CAMPAIGNS} concurrent campaigns allowed. Please wait for a campaign to complete.`,
          code: 'MAX_CAMPAIGNS_REACHED',
        });
      }
    }

    // Create campaign in Supabase
    const campaignId = crypto.randomUUID();
    
    try {
      const { error: campaignError } = await supabase.from('campaigns').insert({
        id: campaignId,
        user_id: userId,
        name: campaignName || `Campaign ${new Date().toLocaleDateString()}`,
        status: 'running',
        total_emails: contacts.length,
        sent_count: 0,
        failed_count: 0,
        delay_min: delayMin,
        delay_max: delayMax,
        template_subject: template.subject,
        template_body: template.body,
        sender_name: senderName || credentials.senderName,
        started_at: new Date().toISOString(),
      });

      if (campaignError) {
        console.error('Campaign insert error:', campaignError);
        throw campaignError;
      }

      console.log('✅ Campaign created:', campaignId);

      // Insert campaign emails
      const emailRecords = contacts.map((contact, index) => ({
        campaign_id: campaignId,
        user_id: userId,
        email: contact.email,
        contact_data: contact,
        status: 'pending',
        sort_order: index,
        tracking_id: enableTracking ? generateTrackingId(campaignId, contact.email, userId) : null,
        email_hash: hashEmail(contact.email),
      }));

      const { error: insertError } = await supabase
        .from('campaign_emails')
        .insert(emailRecords);

      if (insertError) {
        console.error('Campaign emails insert error:', insertError);
        throw insertError;
      }

      console.log('✅ Campaign emails inserted:', emailRecords.length);

    } catch (err) {
      console.error('Campaign creation error:', err);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to create campaign',
        details: err.message
      });
    }

    // Queue campaign for processing (store credentials temporarily)
    if (isUpstashConfigured) {
      await campaignQueue.enqueue(campaignId, userId, {
        campaignId,
        userId,
        credentials: {
          smtpHost: credentials.smtpHost,
          smtpPort: credentials.smtpPort,
          emailUser: credentials.emailUser,
          // Note: Password should be encrypted in production
          emailPass: credentials.emailPass,
          senderName: credentials.senderName,
        },
        template,
        senderName,
        delayMin,
        delayMax,
        enableTracking,
        status: 'running',
        currentIndex: 0,
        total: contacts.length,
      });
    } else {
      // Fallback: Store in database (not recommended for production due to security)
      console.warn('⚠️ Storing credentials in database - configure Upstash Redis for production');
      await supabase
        .from('campaigns')
        .update({
          credentials_temp: JSON.stringify({
            smtpHost: credentials.smtpHost,
            smtpPort: credentials.smtpPort,
            emailUser: credentials.emailUser,
            emailPass: credentials.emailPass,
            senderName: credentials.senderName,
          }),
          template_data: JSON.stringify({ template, senderName, delayMin, delayMax, enableTracking }),
        })
        .eq('id', campaignId);
    }

    // On Vercel, don't call processCampaign - let worker handle it
    // On local/non-serverless, start background processing
    if (!isVercel) {
      processCampaign(campaignId, userId).catch(err => {
        console.error(`Campaign ${campaignId} processing error:`, err);
      });
    } else {
      console.log('🔄 Serverless mode: campaign will be processed by worker');
    }

    res.json({
      success: true,
      campaignId,
      message: `Campaign started with ${contacts.length} contacts`,
      total: contacts.length,
    });
  }
);

/**
 * Pause a running campaign
 */
router.post('/pause',
  requireAuth,
  redisCampaignLimiter,
  body('campaignId').isUUID().withMessage('Valid campaign ID required'),
  handleValidationErrors,
  async (req, res) => {
    const { campaignId } = req.body;
    const userId = req.user.id;

    try {
      const { data: campaign, error } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .eq('user_id', userId)
        .single();

      if (error || !campaign) {
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }

      if (campaign.status !== 'running') {
        return res.status(400).json({ success: false, error: 'Campaign is not running' });
      }

      await supabase
        .from('campaigns')
        .update({ status: 'paused', paused_at: new Date().toISOString() })
        .eq('id', campaignId);

      if (isUpstashConfigured) {
        await campaignQueue.updateProgress(campaignId, userId, { status: 'paused' });
      }

      res.json({ success: true, message: 'Campaign paused' });
    } catch (err) {
      console.error('Pause error:', err);
      res.status(500).json({ success: false, error: 'Failed to pause campaign' });
    }
  }
);

/**
 * Resume a paused campaign
 */
router.post('/resume',
  requireAuth,
  redisCampaignLimiter,
  body('campaignId').isUUID().withMessage('Valid campaign ID required'),
  handleValidationErrors,
  async (req, res) => {
    const { campaignId } = req.body;
    const { credentials } = req.body;
    const userId = req.user.id;

    const credError = validateCredentials(credentials);
    if (credError) {
      return res.status(400).json({ success: false, error: credError });
    }

    try {
      const { data: campaign, error } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .eq('user_id', userId)
        .single();

      if (error || !campaign) {
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }

      if (campaign.status !== 'paused') {
        return res.status(400).json({ success: false, error: 'Campaign is not paused' });
      }

      // Store credentials and update status
      if (isUpstashConfigured) {
        await campaignQueue.enqueue(campaignId, userId, {
          campaignId,
          userId,
          credentials,
          template: { subject: campaign.template_subject, body: campaign.template_body },
          senderName: campaign.sender_name,
          delayMin: campaign.delay_min,
          delayMax: campaign.delay_max,
          enableTracking: true,
          status: 'running',
          currentIndex: campaign.sent_count + campaign.failed_count,
          total: campaign.total_emails,
        });
      } else {
        // CRITICAL FIX: Store credentials in database for non-Upstash mode
        await supabase
          .from('campaigns')
          .update({
            credentials_temp: JSON.stringify({
              smtpHost: credentials.smtpHost,
              smtpPort: credentials.smtpPort,
              emailUser: credentials.emailUser,
              emailPass: credentials.emailPass,
              senderName: credentials.senderName,
            }),
            template_data: JSON.stringify({
              template: { subject: campaign.template_subject, body: campaign.template_body },
              senderName: campaign.sender_name,
              delayMin: campaign.delay_min,
              delayMax: campaign.delay_max,
              enableTracking: true,
            }),
          })
          .eq('id', campaignId);
      }

      await supabase
        .from('campaigns')
        .update({ status: 'running', paused_at: null })
        .eq('id', campaignId);

      // On Vercel, don't call processCampaign - let worker handle it
      if (!isVercel) {
        processCampaign(campaignId, userId).catch(err => {
          console.error(`Campaign ${campaignId} resume error:`, err);
        });
      } else {
        console.log('🔄 Serverless mode: campaign will be processed by worker');
      }

      res.json({ success: true, message: 'Campaign resumed' });
    } catch (err) {
      console.error('Resume error:', err);
      res.status(500).json({ success: false, error: 'Failed to resume campaign' });
    }
  }
);

/**
 * Stop a campaign completely
 */
router.post('/stop',
  requireAuth,
  redisCampaignLimiter,
  body('campaignId').isUUID().withMessage('Valid campaign ID required'),
  handleValidationErrors,
  async (req, res) => {
    const { campaignId } = req.body;
    const userId = req.user.id;

    try {
      const { data: campaign, error } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .eq('user_id', userId)
        .single();

      if (error || !campaign) {
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }

      await supabase
        .from('campaigns')
        .update({ 
          status: 'stopped', 
          completed_at: new Date().toISOString() 
        })
        .eq('id', campaignId);

      // Mark pending emails as cancelled
      await supabase
        .from('campaign_emails')
        .update({ status: 'cancelled' })
        .eq('campaign_id', campaignId)
        .eq('status', 'pending');

      if (isUpstashConfigured) {
        await campaignQueue.dequeue(campaignId, userId);
      }

      res.json({ success: true, message: 'Campaign stopped' });
    } catch (err) {
      console.error('Stop error:', err);
      res.status(500).json({ success: false, error: 'Failed to stop campaign' });
    }
  }
);

/**
 * Get campaign status
 */
router.get('/status/:campaignId',
  requireAuth,
  async (req, res) => {
    const { campaignId } = req.params;
    const userId = req.user.id;

    try {
      const { data: campaign, error } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .eq('user_id', userId)
        .single();

      if (error || !campaign) {
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }

      res.json({
        success: true,
        campaign: {
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          total: campaign.total_emails,
          sent: campaign.sent_count,
          failed: campaign.failed_count,
          progress: Math.round((campaign.sent_count + campaign.failed_count) / campaign.total_emails * 100),
          startedAt: campaign.started_at,
          completedAt: campaign.completed_at,
        },
      });
    } catch (err) {
      console.error('Status error:', err);
      res.status(500).json({ success: false, error: 'Failed to get campaign status' });
    }
  }
);

/**
 * Process campaign emails (runs in background)
 */
async function processCampaign(campaignId, userId) {
  console.log(`Processing campaign ${campaignId}`);
  
  let transporter = null;
  
  try {
    // Get campaign data
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .eq('user_id', userId)
      .single();

    if (campaignError || !campaign) {
      console.error('Campaign not found for processing');
      return;
    }

    // Get queue data for credentials
    let queueData = null;
    if (isUpstashConfigured) {
      queueData = await campaignQueue.getStatus(campaignId, userId);
    } else {
      // Fallback: Get from database
      if (campaign.credentials_temp && campaign.template_data) {
        queueData = {
          credentials: JSON.parse(campaign.credentials_temp),
          ...JSON.parse(campaign.template_data),
        };
      }
    }

    if (!queueData?.credentials) {
      console.error('No credentials found for campaign');
      await supabase
        .from('campaigns')
        .update({ status: 'error', error_message: 'Missing credentials' })
        .eq('id', campaignId);
      return;
    }

    const { credentials, template, senderName, delayMin, delayMax, enableTracking } = queueData;

    // Create transporter
    transporter = createTransporterFromCredentials(credentials);

    // Get pending emails
    const { data: pendingEmails, error: emailsError } = await supabase
      .from('campaign_emails')
      .select('*')
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')
      .order('sort_order')
      .limit(100); // Process in batches

    if (emailsError) {
      throw emailsError;
    }

    if (!pendingEmails || pendingEmails.length === 0) {
      // Campaign complete - clear sensitive data
      console.log(`✅ No pending emails found for campaign ${campaignId}, marking as completed`);
      
      const { error: updateError } = await supabase
        .from('campaigns')
        .update({ 
          status: 'completed', 
          completed_at: new Date().toISOString(),
          credentials_temp: null,
          template_data: null,
        })
        .eq('id', campaignId);
      
      if (updateError) {
        console.error('Failed to update campaign status:', updateError);
      } else {
        console.log(`✅ Campaign ${campaignId} status updated to completed`);
      }
      
      if (isUpstashConfigured) {
        await campaignQueue.dequeue(campaignId, userId);
      }
      
      return;
    }

    // Process each email - check status every 10 emails to avoid N+1 queries
    const STATUS_CHECK_INTERVAL = 10;
    let shouldStop = false;
    
    for (let i = 0; i < pendingEmails.length; i++) {
      const emailRecord = pendingEmails[i];
      
      // Check if campaign is still running (every N emails)
      if (i % STATUS_CHECK_INTERVAL === 0) {
        const { data: currentCampaign } = await supabase
          .from('campaigns')
          .select('status')
          .eq('id', campaignId)
          .single();

        if (currentCampaign?.status !== 'running') {
          console.log(`Campaign ${campaignId} is ${currentCampaign?.status}, stopping processing`);
          shouldStop = true;
          break;
        }
      }
      
      if (shouldStop) break;

      try {
        // Personalize template
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

        // Replace variables
        Object.entries(variables).forEach(([key, value]) => {
          const regex = new RegExp(`{{${key}}}`, 'gi');
          personalizedSubject = personalizedSubject.replace(regex, value || '');
          personalizedBody = personalizedBody.replace(regex, value || '');
        });

        const sanitizedSubject = sanitizeEmailHeader(personalizedSubject);
        const sanitizedSenderName = sanitizeEmailHeader(senderName || credentials.senderName || 'Support Team');
        let htmlBody = sanitizeHtml(personalizedBody).replace(/\n/g, '<br>');

        // Inject tracking
        if (enableTracking && emailRecord.tracking_id) {
          htmlBody = injectTracking(htmlBody, emailRecord.tracking_id, true);
        }

        // Send email
        const info = await transporter.sendMail({
          from: `"${sanitizedSenderName}" <${credentials.emailUser}>`,
          to: emailRecord.email,
          subject: sanitizedSubject,
          html: htmlBody,
          text: htmlBody.replace(/<[^>]+>/g, ''),
        });

        // Update email record
        const { error: updateError } = await supabase
          .from('campaign_emails')
          .update({ 
            status: 'sent', 
            sent_at: new Date().toISOString(),
          })
          .eq('id', emailRecord.id);

        if (updateError) {
          console.error('Failed to update email record:', updateError);
        } else {
          console.log(`✅ Email record updated for ${emailRecord.email}`);
        }

        // Update campaign count - use RPC or direct update
        const { error: rpcError } = await supabase.rpc('increment_campaign_sent', { campaign_id: campaignId });
        
        if (rpcError) {
          console.warn('RPC increment failed, using direct update:', rpcError.message);
          // Fallback: direct update
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
            console.log(`✅ Sent count updated to ${(currentCampaign.sent_count || 0) + 1}`);
          }
        } else {
          console.log(`✅ Sent count incremented via RPC`);
        }

        console.log(`✅ Sent to ${emailRecord.email}`);

      } catch (sendError) {
        console.error(`❌ Failed to send to ${emailRecord.email}:`, sendError.message);
        
        // Mark email as failed - properly handle potential errors
        const { error: updateError } = await supabase
          .from('campaign_emails')
          .update({ 
            status: 'failed', 
            error_message: sendError.message,
          })
          .eq('id', emailRecord.id);

        if (updateError) {
          console.error('❌ Failed to update email status to failed:', updateError);
        } else {
          console.log(`✅ Email ${emailRecord.email} marked as failed`);
        }

        // Update failed count
        const { error: rpcError } = await supabase.rpc('increment_campaign_failed', { campaign_id: campaignId });
        
        if (rpcError) {
          console.warn('RPC increment failed, using direct update:', rpcError.message);
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

      // Wait with random delay before next email
      const minDelay = delayMin || LIMITS.DEFAULT_MIN_DELAY_MS;
      const maxDelay = delayMax || LIMITS.DEFAULT_MAX_DELAY_MS;
      const randomDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      const nextEmailAt = new Date(Date.now() + randomDelay).toISOString();
      
      // Update campaign with next_email_at so frontend can show real countdown
      await supabase
        .from('campaigns')
        .update({ next_email_at: nextEmailAt })
        .eq('id', campaignId);
      
      console.log(`Waiting ${randomDelay}ms before next email (${nextEmailAt})...`);
      await new Promise(resolve => setTimeout(resolve, randomDelay));
    }

    // Check if more emails to process
    const { data: remaining } = await supabase
      .from('campaign_emails')
      .select('id')
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')
      .limit(1);

    if (remaining && remaining.length > 0) {
      // Continue processing (don't await - run in background)
      setImmediate(() => processCampaign(campaignId, userId));
    } else {
      // Mark complete and clear sensitive data
      console.log(`✅ All emails processed for campaign ${campaignId}, marking as completed`);
      
      const { error: updateError } = await supabase
        .from('campaigns')
        .update({ 
          status: 'completed', 
          completed_at: new Date().toISOString(),
          credentials_temp: null,  // Clear credentials for security
          template_data: null,
        })
        .eq('id', campaignId);
      
      if (updateError) {
        console.error('Failed to update campaign status:', updateError);
      } else {
        console.log(`✅ Campaign ${campaignId} status updated to completed`);
      }
      
      if (isUpstashConfigured) {
        await campaignQueue.dequeue(campaignId, userId);
      }
    }

  } catch (err) {
    console.error(`Campaign ${campaignId} error:`, err);
    
    await supabase
      .from('campaigns')
      .update({ status: 'error', error_message: err.message })
      .eq('id', campaignId);
  } finally {
    if (transporter) {
      transporter.close();
    }
  }
}

export default router;
