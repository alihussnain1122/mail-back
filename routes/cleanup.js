import express from 'express';
import { supabase } from '../services/supabase.js';

const router = express.Router();

/**
 * Auto-cleanup endpoint for old campaign data
 * Deletes templates and contacts 48 hours after campaign completion
 * Can be called by Vercel Cron or manually
 */
router.post('/cleanup-old-data', async (req, res) => {
  try {
    console.log('Starting auto-cleanup of old campaign data...');
    
    // Calculate cutoff time (48 hours ago)
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - 48);
    const cutoffISO = cutoffTime.toISOString();

    console.log('Cutoff time:', cutoffISO);

    // Find completed campaigns older than 48 hours
    const { data: oldCampaigns, error: campaignError } = await supabase
      .from('campaigns')
      .select('id, user_id, completed_at')
      .eq('status', 'completed')
      .not('completed_at', 'is', null)
      .lt('completed_at', cutoffISO);

    if (campaignError) {
      throw campaignError;
    }

    if (!oldCampaigns || oldCampaigns.length === 0) {
      console.log('No campaigns found for cleanup');
      return res.json({ 
        success: true, 
        message: 'No data to cleanup',
        deleted: { campaigns: 0, emails: 0 }
      });
    }

    console.log(`Found ${oldCampaigns.length} campaigns for cleanup`);

    let totalEmailsDeleted = 0;

    // Delete campaign_emails for each old campaign
    for (const campaign of oldCampaigns) {
      const { error: deleteEmailsError, count } = await supabase
        .from('campaign_emails')
        .delete({ count: 'exact' })
        .eq('campaign_id', campaign.id);

      if (deleteEmailsError) {
        console.error(`Error deleting emails for campaign ${campaign.id}:`, deleteEmailsError);
      } else {
        totalEmailsDeleted += count || 0;
        console.log(`Deleted ${count || 0} emails for campaign ${campaign.id}`);
      }
    }

    // Delete the campaigns themselves
    const campaignIds = oldCampaigns.map(c => c.id);
    const { error: deleteCampaignsError } = await supabase
      .from('campaigns')
      .delete()
      .in('id', campaignIds);

    if (deleteCampaignsError) {
      throw deleteCampaignsError;
    }

    console.log(`Cleanup complete: ${oldCampaigns.length} campaigns, ${totalEmailsDeleted} emails deleted`);

    res.json({
      success: true,
      message: 'Cleanup completed successfully',
      deleted: {
        campaigns: oldCampaigns.length,
        emails: totalEmailsDeleted
      }
    });

  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * Get cleanup statistics (how much data will be deleted)
 */
router.get('/cleanup-stats', async (req, res) => {
  try {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - 48);
    const cutoffISO = cutoffTime.toISOString();

    const { data: oldCampaigns, error } = await supabase
      .from('campaigns')
      .select('id, completed_at, total_contacts')
      .eq('status', 'completed')
      .not('completed_at', 'is', null)
      .lt('completed_at', cutoffISO);

    if (error) throw error;

    const totalCampaigns = oldCampaigns?.length || 0;
    const totalContacts = oldCampaigns?.reduce((sum, c) => sum + (c.total_contacts || 0), 0) || 0;

    res.json({
      success: true,
      stats: {
        campaigns: totalCampaigns,
        estimatedContacts: totalContacts,
        cutoffTime: cutoffISO
      }
    });

  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

export default router;
