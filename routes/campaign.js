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
import { validateCredentials, generateTrackingId, hashEmail } from '../services/helpers.js';
import { isVercel } from '../config/index.js';
import { processCampaign, LIMITS } from '../services/campaign-processor.js';

const router = express.Router();

// ...existing code...

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


// ...existing code...

export default router;
