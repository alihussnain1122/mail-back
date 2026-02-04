import express from 'express';
import { supabase } from '../services/supabase.js';

const router = express.Router();

/**
 * WEBHOOK ENDPOINT FOR BOUNCE NOTIFICATIONS
 * 
 * Supports multiple email service providers:
 * - SendGrid: POST /api/email/bounce-webhook/sendgrid
 * - Mailgun: POST /api/email/bounce-webhook/mailgun
 * - AWS SES (via SNS): POST /api/email/bounce-webhook/ses
 * - Postmark: POST /api/email/bounce-webhook/postmark
 * - Generic/Custom: POST /api/email/bounce-webhook/generic
 * 
 * Configure your email provider to send bounce notifications to:
 * https://your-domain.vercel.app/api/email/bounce-webhook/{provider}
 */

// ============================================
// SENDGRID BOUNCE WEBHOOK
// ============================================
router.post('/sendgrid', express.json(), async (req, res) => {
  console.log('\n========== SENDGRID BOUNCE WEBHOOK ==========');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Events received:', req.body?.length || 1);
  console.log('==========================================\n');

  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    
    for (const event of events) {
      if (event.event === 'bounce' || event.event === 'dropped') {
        const bounceData = {
          email: event.email,
          bounce_type: event.type === 'blocked' ? 'soft' : 'hard',
          reason: event.reason || 'No reason provided',
          smtp_code: event.status,
          campaign_id: event.campaign_id || null, // If you include this in X-SMTPAPI
          created_at: new Date(event.timestamp * 1000).toISOString()
        };

        console.log('Processing SendGrid bounce:', bounceData);
        await recordBounce(bounceData);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('SendGrid webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// MAILGUN BOUNCE WEBHOOK
// ============================================
router.post('/mailgun', express.json(), async (req, res) => {
  console.log('\n========== MAILGUN BOUNCE WEBHOOK ==========');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Event type:', req.body['event-data']?.event);
  console.log('==========================================\n');

  try {
    const eventData = req.body['event-data'];
    
    if (eventData?.event === 'failed' || eventData?.event === 'bounced') {
      const bounceData = {
        email: eventData.recipient,
        bounce_type: eventData['delivery-status']?.code >= 500 ? 'hard' : 'soft',
        reason: eventData['delivery-status']?.description || 'No reason provided',
        smtp_code: eventData['delivery-status']?.code,
        campaign_id: eventData['user-variables']?.campaign_id || null,
        created_at: new Date(eventData.timestamp * 1000).toISOString()
      };

      console.log('Processing Mailgun bounce:', bounceData);
      await recordBounce(bounceData);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Mailgun webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// AWS SES (via SNS) BOUNCE WEBHOOK
// ============================================
router.post('/ses', express.json(), async (req, res) => {
  console.log('\n========== AWS SES BOUNCE WEBHOOK ==========');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Message type:', req.body.Type);
  console.log('==========================================\n');

  try {
    // Handle SNS subscription confirmation
    if (req.body.Type === 'SubscriptionConfirmation') {
      console.log('SNS Subscription confirmation:', req.body.SubscribeURL);
      return res.status(200).send('Please confirm subscription via URL in logs');
    }

    // Handle bounce notification
    if (req.body.Type === 'Notification') {
      const message = JSON.parse(req.body.Message);
      
      if (message.notificationType === 'Bounce') {
        const bounce = message.bounce;
        
        for (const recipient of bounce.bouncedRecipients) {
          const bounceData = {
            email: recipient.emailAddress,
            bounce_type: bounce.bounceType === 'Permanent' ? 'hard' : 'soft',
            reason: recipient.diagnosticCode || bounce.bounceSubType || 'No reason provided',
            smtp_code: recipient.status,
            campaign_id: message.mail.tags?.campaign_id?.[0] || null,
            created_at: bounce.timestamp
          };

          console.log('Processing SES bounce:', bounceData);
          await recordBounce(bounceData);
        }
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('SES webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// POSTMARK BOUNCE WEBHOOK
// ============================================
router.post('/postmark', express.json(), async (req, res) => {
  console.log('\n========== POSTMARK BOUNCE WEBHOOK ==========');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Record type:', req.body.RecordType);
  console.log('==========================================\n');

  try {
    if (req.body.RecordType === 'Bounce') {
      const bounceData = {
        email: req.body.Email,
        bounce_type: req.body.Type === 'HardBounce' ? 'hard' : 'soft',
        reason: req.body.Description || 'No reason provided',
        smtp_code: req.body.TypeCode,
        campaign_id: req.body.Metadata?.campaign_id || null,
        created_at: req.body.BouncedAt
      };

      console.log('Processing Postmark bounce:', bounceData);
      await recordBounce(bounceData);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Postmark webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// GENERIC BOUNCE WEBHOOK (Custom SMTP Servers)
// ============================================
router.post('/generic', express.json(), async (req, res) => {
  console.log('\n========== GENERIC BOUNCE WEBHOOK ==========');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Payload:', JSON.stringify(req.body, null, 2));
  console.log('==========================================\n');

  try {
    const { email, bounce_type, reason, smtp_code, campaign_id, user_id } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const bounceData = {
      email,
      bounce_type: bounce_type || 'hard',
      reason: reason || 'Bounce notification received',
      smtp_code: smtp_code || null,
      campaign_id: campaign_id || null,
      user_id: user_id || null, // Optional: if you pass it from your custom system
      created_at: new Date().toISOString()
    };

    console.log('Processing generic bounce:', bounceData);
    await recordBounce(bounceData);

    res.status(200).json({ success: true, message: 'Bounce recorded' });
  } catch (error) {
    console.error('Generic webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// CORE BOUNCE RECORDING LOGIC
// ============================================
async function recordBounce(bounceData) {
  const { email, bounce_type, reason, smtp_code, campaign_id, user_id, created_at } = bounceData;

  console.log('\n========== RECORDING BOUNCE TO SUPABASE ==========');
  console.log('Email:', email);
  console.log('Type:', bounce_type);
  console.log('Reason:', reason);
  console.log('SMTP Code:', smtp_code);
  console.log('Campaign ID:', campaign_id);
  console.log('User ID (from webhook):', user_id || 'Not provided');
  console.log('===============================================\n');

  try {
    // CRITICAL: If user_id not provided by webhook, we need to find it
    let resolvedUserId = user_id;

    if (!resolvedUserId && campaign_id) {
      // Lookup user_id from campaign_id
      const { data: campaign, error: campaignError } = await supabase
        .from('campaigns')
        .select('user_id')
        .eq('id', campaign_id)
        .single();

      if (campaignError) {
        console.error('❌ Failed to lookup user from campaign:', campaignError);
      } else if (campaign) {
        resolvedUserId = campaign.user_id;
        console.log('✅ Resolved user_id from campaign:', resolvedUserId);
      }
    }

    // If still no user_id, try to find from any campaign that sent to this email
    if (!resolvedUserId) {
      const { data: campaignEmail, error: lookupError } = await supabase
        .from('campaign_emails')
        .select('user_id, campaign_id')
        .eq('contact_email', email)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!lookupError && campaignEmail) {
        resolvedUserId = campaignEmail.user_id;
        console.log('✅ Resolved user_id from campaign_emails:', resolvedUserId);
      }
    }

    if (!resolvedUserId) {
      console.error('❌ CRITICAL: Cannot record bounce - no user_id found for email:', email);
      console.error('   This bounce cannot be attributed to any user.');
      console.error('   Consider adding user_id to email headers or custom variables.');
      return;
    }

    // Insert bounce record (uses UPSERT to handle duplicates)
    const { data, error } = await supabase
      .from('bounced_emails')
      .upsert({
        user_id: resolvedUserId,
        email,
        bounce_type,
        reason: reason?.slice(0, 500), // Limit reason length
        campaign_id,
        bounced_at: created_at || new Date().toISOString()
      }, {
        onConflict: 'user_id,email'
      })
      .select();

    if (error) {
      console.error('❌ FAILED TO INSERT BOUNCE');
      console.error('Error code:', error.code);
      console.error('Error message:', error.message);
      console.error('Error details:', error.details);
      console.error('Error hint:', error.hint);
      
      if (error.code === '23503') {
        console.error('⚠️  FOREIGN KEY VIOLATION: user_id does not exist in auth.users');
        console.error('   User ID attempted:', resolvedUserId);
      } else if (error.code === '42501') {
        console.error('⚠️  PERMISSION DENIED: Check RLS policies on bounced_emails table');
        console.error('   The service role key should bypass RLS.');
      }
      
      throw error;
    }

    console.log('✅ BOUNCE RECORDED SUCCESSFULLY');
    console.log('Data inserted:', data);
    console.log('===============================================\n');

    // Update campaign_emails status if we have campaign_id
    if (campaign_id && resolvedUserId) {
      const { error: updateError } = await supabase
        .from('campaign_emails')
        .update({ 
          status: 'failed',
          error_message: `Bounce: ${reason?.slice(0, 200)}`
        })
        .eq('campaign_id', campaign_id)
        .eq('contact_email', email)
        .eq('user_id', resolvedUserId);

      if (updateError) {
        console.error('⚠️  Failed to update campaign_emails status:', updateError.message);
      } else {
        console.log('✅ Updated campaign_emails status to failed');
      }
    }

    // Insert tracking event
    if (campaign_id && resolvedUserId) {
      await supabase.from('email_tracking').insert({
        user_id: resolvedUserId,
        campaign_id,
        email,
        tracking_type: 'bounce',
        created_at: created_at || new Date().toISOString()
      });
      console.log('✅ Created bounce tracking event');
    }

  } catch (error) {
    console.error('❌ EXCEPTION IN recordBounce:', error);
    throw error;
  }
}

export default router;
