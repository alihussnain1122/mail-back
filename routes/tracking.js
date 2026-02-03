import express from 'express';
import { body } from 'express-validator';
import { handleValidationErrors } from '../middleware/validation.js';
import { decodeTrackingId } from '../services/helpers.js';
import { TRACKING_PIXEL } from '../services/email.js';
import { supabase } from '../services/supabase.js';

const router = express.Router();

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
    
    const trackingInfo = decodeTrackingId(trackingId);
    
    console.log('Email opened:', { trackingId, ...trackingInfo, deviceType });
    console.log('Supabase client:', supabase ? 'initialized' : 'NULL');
    
    if (supabase && trackingInfo) {
      const { data, error } = await supabase.from('email_tracking').insert({
        tracking_id: trackingId,
        campaign_id: trackingInfo.campaignId,
        email: trackingInfo.email,
        user_id: trackingInfo.userId,
        tracking_type: 'open',
        ip_address: ipAddress,
        user_agent: userAgent.slice(0, 500),
        device_type: deviceType,
      });
      
      if (error) {
        console.error('Supabase insert error:', error);
      } else {
        console.log('Tracking saved successfully');
      }
      
      await supabase
        .from('campaign_emails')
        .update({ 
          opened_at: new Date().toISOString(),
          open_count: supabase.raw('COALESCE(open_count, 0) + 1')
        })
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
    
    const trackingInfo = decodeTrackingId(trackingId);
    
    console.log('Link clicked:', { trackingId, url, ...trackingInfo, deviceType });
    
    if (supabase && trackingInfo) {
      await supabase.from('email_tracking').insert({
        tracking_id: trackingId,
        campaign_id: trackingInfo.campaignId,
        email: trackingInfo.email,
        user_id: trackingInfo.userId,
        tracking_type: 'click',
        link_url: url,
        ip_address: ipAddress,
        user_agent: userAgent.slice(0, 500),
        device_type: deviceType,
      });
      
      await supabase.rpc('increment_click_count', { tracking_id_param: trackingId });
    }
    
  } catch (err) {
    console.error('Click tracking error:', err);
  }
  
  if (url && url.startsWith('http')) {
    res.redirect(302, url);
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
