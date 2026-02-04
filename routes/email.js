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
      
      const info = await transporter.sendMail({
        from: `"${sanitizedSenderName}" <${credentials.emailUser}>`,
        to: email,
        subject: sanitizedSubject,
        html: htmlBody,
        text: htmlBody.replace(/<[^>]+>/g, ''),
      });
      
      res.json({ 
        success: true, 
        message: `Email sent to ${email}`, 
        messageId: info.messageId,
        trackingId,
      });
    } catch (err) {
      console.error('Send error:', err.message);
      console.error('Error code:', err.code);
      console.error('Response code:', err.responseCode);
      
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
      
      console.log('Bounce detected:', isBounce);
      console.log('Supabase client:', supabase ? 'initialized' : 'NULL');
      console.log('User ID:', userId);
      console.log('Campaign ID:', campaignId);
      console.log('Email:', email);
      
      if (isBounce) {
        if (!userId) {
          console.error('⚠️  Cannot record bounce: userId is missing');
        } else if (!supabase) {
          console.error('⚠️  Cannot record bounce: Supabase client not initialized');
        } else {
          console.log('Attempting to record bounce for:', email);
          try {
            const { data, error: bounceError } = await supabase.from('bounced_emails').upsert({
              user_id: userId,
              email,
              bounce_type: 'hard',
              reason: err.message.slice(0, 500),
              campaign_id: campaignId || null,
            }, { onConflict: 'user_id,email' });
            
            if (bounceError) {
              console.error('Failed to record bounce - Supabase error:', bounceError);
              console.error('Error code:', bounceError.code);
              console.error('Error details:', bounceError.details);
              if (bounceError.code === '23503') {
                console.error('⚠️  Foreign key constraint error - user_id may not exist in auth.users table');
              }
            } else {
              console.log('✅ Bounce recorded successfully for:', email);
            }
          } catch (bounceErr) {
            console.error('Failed to record bounce - Exception:', bounceErr);
          }
        }
      }
      
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
