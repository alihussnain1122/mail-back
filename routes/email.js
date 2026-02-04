import express from 'express';
import { body } from 'express-validator';
import { handleValidationErrors, emailLimiter } from '../middleware/validation.js';
import { 
  validateCredentials, 
  sanitizeEmailHeader, 
  sanitizeHtml, 
  generateTrackingId 
} from '../services/helpers.js';
import { createTransporterFromCredentials, injectTracking } from '../services/email.js';
import { loadTemplates } from '../services/data.js';
import { supabase } from '../services/supabase.js';

const router = express.Router();

// Send a single email
router.post('/single', 
  emailLimiter,
  body('email').isEmail().withMessage('Valid email is required'),
  body('template.subject').notEmpty().withMessage('Template subject is required'),
  body('template.body').notEmpty().withMessage('Template body is required'),
  body('credentials').notEmpty().withMessage('SMTP credentials are required'),
  handleValidationErrors,
  async (req, res) => {
    const { email, template, senderName, credentials, campaignId, userId, enableTracking } = req.body;
    
    console.log('\n========== EMAIL SEND REQUEST ==========');
    console.log('Timestamp:', new Date().toISOString());
    console.log('To:', email);
    console.log('Campaign ID:', campaignId);
    console.log('User ID:', userId);
    console.log('Tracking enabled:', enableTracking);
    console.log('========================================\n');
    
    const credError = validateCredentials(credentials);
    if (credError) {
      return res.status(400).json({ success: false, error: credError });
    }
    
    let transporter;
    let trackingId = null;
    
    try {
      transporter = createTransporterFromCredentials(credentials);
      await transporter.verify();
      
      const sanitizedSubject = sanitizeEmailHeader(template.subject);
      const sanitizedSenderName = sanitizeEmailHeader(senderName || credentials.senderName || 'Support Team');
      let htmlBody = sanitizeHtml(template.body).replace(/\n/g, '<br>');
      
      if (enableTracking && campaignId && userId) {
        trackingId = generateTrackingId(campaignId, email, userId);
        htmlBody = injectTracking(htmlBody, trackingId, true);
      }
      
      const mailOptions = {
        from: `"${sanitizedSenderName}" <${credentials.emailUser}>`,
        to: email,
        subject: sanitizedSubject,
        html: htmlBody,
        text: htmlBody.replace(/<[^>]+>/g, ''),
      };

      // Add custom headers for webhook tracking (used by email providers)
      if (userId) {
        mailOptions.headers = {
          'X-User-ID': userId,
          'X-Campaign-ID': campaignId || 'none',
          'X-Tracking-ID': trackingId || 'none'
        };
      }

      const info = await transporter.sendMail(mailOptions);
      
      res.json({ 
        success: true, 
        message: `Email sent to ${email}`, 
        messageId: info.messageId,
        trackingId,
      });
    } catch (err) {
      console.log('\n========== EMAIL SEND ERROR ==========');
      console.log('Timestamp:', new Date().toISOString());
      console.log('Email:', email);
      console.log('Error message:', err.message);
      console.log('Error code:', err.code);
      console.log('Response code:', err.responseCode);
      console.log('Full error object:', JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
      console.log('=====================================\n');
      
      const errorMessage = err.message.toLowerCase();
      const isBounce = errorMessage.includes('not exist') || 
                       errorMessage.includes('invalid') ||
                       errorMessage.includes('rejected') ||
                       errorMessage.includes('undeliverable') ||
                       errorMessage.includes('mailbox not found') ||
                       errorMessage.includes('mailbox unavailable') ||
                       errorMessage.includes('user unknown') ||
                       errorMessage.includes('unknown user') ||
                       errorMessage.includes('no such user') ||
                       errorMessage.includes('does not exist') ||
                       errorMessage.includes('recipient address rejected') ||
                       errorMessage.includes('address rejected') ||
                       errorMessage.includes('undelivered mail') ||
                       errorMessage.includes('delivery failed') ||
                       errorMessage.includes('bad destination') ||
                       errorMessage.includes('invalid recipient') ||
                       errorMessage.includes('returned to sender') ||
                       err.code === 'EENVELOPE' ||
                       (err.responseCode >= 550 && err.responseCode < 560);
      
      console.log('\n========== BOUNCE DETECTION ==========');
      console.log('Bounce detected:', isBounce);
      console.log('Error message lowercase:', errorMessage);
      console.log('Supabase client initialized:', supabase ? 'YES' : 'NO');
      console.log('User ID provided:', userId ? userId : 'MISSING');
      console.log('Campaign ID:', campaignId || 'null');
      console.log('Email address:', email);
      console.log('======================================\n');
      
      if (isBounce) {
        if (!userId) {
          console.error('⚠️  Cannot record bounce: userId is missing');
        } else if (!supabase) {
          console.error('⚠️  Cannot record bounce: Supabase client not initialized');
        } else {
          console.log('\n========== RECORDING BOUNCE ==========');
          console.log('Attempting to record bounce...');
          console.log('Data to insert:', {
            user_id: userId,
            email: email,
            bounce_type: 'hard',
            reason: err.message.slice(0, 100) + '...',
            campaign_id: campaignId || null
          });
          
          try {
            const { data, error: bounceError } = await supabase.from('bounced_emails').upsert({
              user_id: userId,
              email,
              bounce_type: 'hard',
              reason: err.message.slice(0, 500),
              campaign_id: campaignId || null,
            }, { onConflict: 'user_id,email' });
            
            if (bounceError) {
              console.log('\n❌ BOUNCE RECORDING FAILED');
              console.log('Error code:', bounceError.code);
              console.log('Error message:', bounceError.message);
              console.log('Error details:', bounceError.details);
              console.log('Error hint:', bounceError.hint);
              console.log('Full error:', JSON.stringify(bounceError, null, 2));
              
              if (bounceError.code === '23503') {
                console.log('⚠️  FOREIGN KEY ERROR: user_id does not exist in auth.users table');
                console.log('User ID attempted:', userId);
              }
              console.log('======================================\n');
            } else {
              console.log('\n✅ BOUNCE RECORDED SUCCESSFULLY');
              console.log('Email:', email);
              console.log('User ID:', userId);
              console.log('Returned data:', data);
              console.log('======================================\n');
            }
          } catch (bounceErr) {
            console.log('\n❌ EXCEPTION DURING BOUNCE RECORDING');
            console.log('Exception:', bounceErr);
            console.log('Exception message:', bounceErr.message);
            console.log('Exception stack:', bounceErr.stack);
            console.log('======================================\n');
          }
        }
      }
      
      console.log('\n========== SENDING ERROR RESPONSE ==========');
      console.log('Status: 500');
      console.log('Response data:', {
        success: false,
        error: err.message,
        isBounce: isBounce,
        email: email
      });
      console.log('============================================\n');
      
      res.status(500).json({ 
        success: false, 
        error: err.message,
        isBounce,
        email,
      });
    } finally {
      if (transporter) transporter.close();
    }
  }
);

// Send test email
router.post('/test',
  emailLimiter,
  body('email').isEmail().withMessage('Valid email is required'),
  body('credentials').notEmpty().withMessage('SMTP credentials are required'),
  handleValidationErrors,
  async (req, res) => {
    const { email, templateIndex = 0, senderName, credentials } = req.body;
    
    const idx = parseInt(templateIndex, 10);
    if (isNaN(idx) || idx < 0) {
      return res.status(400).json({ error: 'Invalid template index' });
    }
    
    const credError = validateCredentials(credentials);
    if (credError) {
      return res.status(400).json({ error: credError });
    }
    
    let transporter;
    try {
      const templates = loadTemplates();
      const template = templates[idx];
      
      if (!template) {
        return res.status(400).json({ error: 'Template not found' });
      }
      
      transporter = createTransporterFromCredentials(credentials);
      
      const sanitizedSubject = sanitizeEmailHeader(template.subject);
      const sanitizedSenderName = sanitizeEmailHeader(senderName || credentials.senderName || 'Support Team');
      const htmlBody = sanitizeHtml(template.body).replace(/\n/g, '<br>');
      
      await transporter.sendMail({
        from: `"${sanitizedSenderName}" <${credentials.emailUser}>`,
        to: email,
        subject: sanitizedSubject,
        html: htmlBody,
        text: htmlBody.replace(/<[^>]+>/g, ''),
      });
      
      res.json({ success: true, message: `Test email sent to ${email}` });
    } catch (err) {
      console.error('Test email error:', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      if (transporter) transporter.close();
    }
  }
);

export default router;
