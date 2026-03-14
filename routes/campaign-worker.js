/**
 * Campaign Worker - Cron-based Email Processing
 * 
 * This worker processes emails in batches, called by Vercel cron every minute.
 * Designed for serverless environments where long-running processes are not possible.
 */

import express from 'express';
import { supabase } from '../services/supabase.js';
import { isVercel } from '../config/index.js';
import {
  processCampaignBatch,
} from '../services/campaignWorkerService.js';
import { isUpstashConfigured } from '../services/redis.js';

const router = express.Router();

// Configuration for batch processing
const BATCH_CONFIG = {
  CRON_SECRET: process.env.CRON_SECRET,
};

/**
 * Process pending emails for all running campaigns
 * Called by Vercel cron OR frontend polling
 * 
 * GET /api/campaign-worker/process
 */
router.get('/process', async (req, res) => {
  // Allow requests in these cases:
  // 1. Has valid CRON_SECRET header (external cron service)
  // 2. No CRON_SECRET configured (anyone can trigger)
  // 3. Request comes with referer from allowed origins (frontend polling)
  const authHeader = req.headers.authorization;
  const referer = req.headers.referer || req.headers.origin || '';
  
  if (BATCH_CONFIG.CRON_SECRET) {
    const hasValidSecret = authHeader === `Bearer ${BATCH_CONFIG.CRON_SECRET}`;
    const isFromFrontend = referer.includes('vercel.app') || 
                           referer.includes('localhost') ||
                           referer.includes('127.0.0.1');
    
    if (!hasValidSecret && !isFromFrontend) {
      console.warn('Unauthorized worker attempt from:', referer || 'no referer');
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
    res.status(500).json({ success: false, error: 'Campaign worker processing failed' });
  }
});


// ...existing code...

export default router;
