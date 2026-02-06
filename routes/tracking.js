import express from 'express';
import { body } from 'express-validator';
import { handleValidationErrors } from '../middleware/validation.js';
import { decodeTrackingId } from '../services/helpers.js';
import { TRACKING_PIXEL } from '../services/email.js';
import { supabase } from '../services/supabase.js';
import { CONFIG } from '../config/index.js';

const router = express.Router();

// Allowed redirect domains (add your domains here)
const ALLOWED_REDIRECT_DOMAINS = [
  // Add your trusted domains
  'google.com',
  'linkedin.com',
  'twitter.com',
  'facebook.com',
  'github.com',
  'youtube.com',
  'calendly.com',
  'hubspot.com',
  'typeform.com',
  'notion.so',
  // Add more as needed
];

/**
 * Validate redirect URL to prevent open redirect attacks
 */
function isValidRedirectUrl(url) {
  if (!url) return false;
  
  try {
    const parsed = new URL(url);
    
    // Must be http or https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    
    // Check against allowed domains
    const domain = parsed.hostname.toLowerCase();
    
    // Allow if domain or any parent domain is in allowlist
    for (const allowed of ALLOWED_REDIRECT_DOMAINS) {
      if (domain === allowed || domain.endsWith('.' + allowed)) {
        return true;
      }
    }
    
    // Also allow if it matches the frontend URL domain
    try {
      const frontendDomain = new URL(CONFIG.frontendUrl).hostname;
      if (domain === frontendDomain || domain.endsWith('.' + frontendDomain)) {
        return true;
      }
    } catch {}
    
    return false;
  } catch {
    return false;
  }
}

// Track email open (via pixel)
router.get('/open/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  
  try {
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.get('User-Agent') || 'unknown';
    
    let deviceType = 'desktop';
    if (/mobile|android|iphone|ipad/i.test(userAgent)) {
      deviceType = /ipad|tablet/i.test(userAgent) ? 'tablet' : 'mobile';
    }
    
    // Verify and decode the signed tracking ID
    const trackingInfo = decodeTrackingId(trackingId);
    
    // If signature verification fails, trackingInfo will be null
    if (!trackingInfo) {
      console.warn('Invalid tracking ID signature:', trackingId.slice(0, 20) + '...');
    }
    
    if (supabase && trackingInfo) {
      const { error } = await supabase.from('email_tracking').insert({
        tracking_id: trackingId,
        campaign_id: trackingInfo.campaignId,
        email_hash: trackingInfo.emailHash, // Store hash, not actual email
        user_id: trackingInfo.userId,
        tracking_type: 'open',
        ip_address: ipAddress,
        user_agent: userAgent.slice(0, 500),
        device_type: deviceType,
      });
      
      if (error) {
        console.error('Supabase insert error:', error);
      }
      
      // Update campaign_emails opened_at (if exists)
      await supabase
        .from('campaign_emails')
        .update({ opened_at: new Date().toISOString() })
        .eq('tracking_id', trackingId)
        .is('opened_at', null);
    }
    
  } catch (err) {
    console.error('Tracking error:', err);
  }
  
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': TRACKING_PIXEL.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.send(TRACKING_PIXEL);
});

// Track link click
router.get('/click/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  const { url } = req.query;
  
  try {
    const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.get('User-Agent') || 'unknown';
    
    let deviceType = 'desktop';
    if (/mobile|android|iphone|ipad/i.test(userAgent)) {
      deviceType = /ipad|tablet/i.test(userAgent) ? 'tablet' : 'mobile';
    }
    
    // Verify and decode the signed tracking ID
    const trackingInfo = decodeTrackingId(trackingId);
    
    if (!trackingInfo) {
      console.warn('Invalid click tracking ID signature');
    }
    
    if (supabase && trackingInfo) {
      await supabase.from('email_tracking').insert({
        tracking_id: trackingId,
        campaign_id: trackingInfo.campaignId,
        email_hash: trackingInfo.emailHash, // Store hash, not actual email
        user_id: trackingInfo.userId,
        tracking_type: 'click',
        link_url: url,
        ip_address: ipAddress,
        user_agent: userAgent.slice(0, 500),
        device_type: deviceType,
      });
      
      // Track click count in campaign_emails
      await supabase
        .from('campaign_emails')
        .update({ clicked_at: new Date().toISOString() })
        .eq('tracking_id', trackingId)
        .is('clicked_at', null);
    }
    
  } catch (err) {
    console.error('Click tracking error:', err);
  }
  
  // Validate redirect URL to prevent open redirect attacks
  if (url && isValidRedirectUrl(url)) {
    res.redirect(302, url);
  } else if (url) {
    // Log potential attack attempt
    console.warn('Blocked redirect to untrusted URL:', url);
    res.status(400).send('Redirect to this URL is not allowed');
  } else {
    res.status(400).send('Invalid URL');
  }
});

// Report bounce
router.post('/bounce',
  body('email').isEmail().withMessage('Valid email required'),
  body('bounceType').isIn(['hard', 'soft']).withMessage('Invalid bounce type'),
  handleValidationErrors,
  async (req, res) => {
    const { email, trackingId, bounceType, reason, campaignId, userId } = req.body;
    
    console.log('Bounce reported:', { email, trackingId, bounceType, reason });
    
    if (supabase && userId) {
      try {
        await supabase.from('bounced_emails').upsert({
          user_id: userId,
          email,
          bounce_type: bounceType,
          reason,
          campaign_id: campaignId,
        }, { onConflict: 'user_id,email' });
        
        if (trackingId && campaignId) {
          await supabase.from('email_tracking').insert({
            tracking_id: trackingId,
            campaign_id: campaignId,
            email,
            user_id: userId,
            tracking_type: 'bounce',
          });
          
          await supabase
            .from('campaign_emails')
            .update({ bounced: true, bounce_reason: reason })
            .eq('tracking_id', trackingId);
        }
      } catch (err) {
        console.error('Bounce save error:', err);
      }
    }
    
    res.json({ success: true });
  }
);

export default router;
