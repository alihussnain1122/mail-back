import express from 'express';
import { decodeTrackingId } from '../services/helpers.js';
import { supabase } from '../services/supabase.js';

const router = express.Router();

// Unsubscribe endpoint
router.get('/:trackingId', async (req, res) => {
  const { trackingId } = req.params;
  
  const trackingInfo = decodeTrackingId(trackingId);

  
  if (supabase && trackingInfo) {
    try {
      await supabase.from('unsubscribed_emails').upsert({
        user_id: trackingInfo.userId,
        email: trackingInfo.email,
        campaign_id: trackingInfo.campaignId,
        reason: 'User clicked unsubscribe link',
      }, { onConflict: 'user_id,email' });
      
      await supabase.from('email_tracking').insert({
        tracking_id: trackingId,
        campaign_id: trackingInfo.campaignId,
        email: trackingInfo.email,
        user_id: trackingInfo.userId,
        tracking_type: 'unsubscribe',
      });
    } catch (err) {
      console.error('Unsubscribe save error:', err);
    }
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Unsubscribed</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f3f4f6; }
        .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); text-align: center; max-width: 400px; }
        h1 { color: #111827; margin-bottom: 16px; }
        p { color: #6b7280; line-height: 1.6; }
        .icon { font-size: 48px; margin-bottom: 16px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">✅</div>
        <h1>Unsubscribed</h1>
        <p>You have been successfully unsubscribed from our mailing list. You will no longer receive emails from us.</p>
      </div>
    </body>
    </html>
  `);
});

export default router;
