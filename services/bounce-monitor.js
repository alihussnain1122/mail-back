import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { supabase } from './supabase.js';

/**
 * FREE BOUNCE DETECTION - IMAP Inbox Monitoring
 * 
 * Monitors your SMTP sender's inbox for bounce messages and automatically
 * records them to Supabase. Completely free - uses your existing email account.
 * 
 * Works with: Gmail, Outlook, Yahoo, any IMAP-enabled email provider
 */

class BounceMonitor {
  constructor(config) {
    this.config = config;
    this.imap = null;
    this.isRunning = false;
    this.checkInterval = config.checkInterval || 60000; // Default: check every 60 seconds
    this.lastCheck = null;
  }

  /**
   * Start monitoring inbox for bounce messages
   */
  async start() {
    if (this.isRunning) {
      console.log('⚠️  Bounce monitor already running');
      return;
    }

    console.log('\n========================================');
    console.log('🔍 Starting Bounce Monitor (FREE)');
    console.log('========================================');
    console.log('IMAP Host:', this.config.host);
    console.log('IMAP User:', this.config.user);
    console.log('Check Interval:', this.checkInterval / 1000, 'seconds');
    console.log('========================================\n');

    this.isRunning = true;
    await this.checkForBounces();
    
    // Start periodic checking
    this.intervalId = setInterval(() => {
      this.checkForBounces();
    }, this.checkInterval);
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.imap) {
      this.imap.end();
      this.imap = null;
    }
    this.isRunning = false;
    console.log('🛑 Bounce monitor stopped');
  }

  /**
   * Check inbox for new bounce messages
   */
  async checkForBounces() {
    console.log(`\n[${new Date().toISOString()}] 🔍 Checking for bounce messages...`);
    
    return new Promise((resolve, reject) => {
      this.imap = new Imap({
        user: this.config.user,
        password: this.config.password,
        host: this.config.host,
        port: this.config.port || 993,
        tls: this.config.tls !== false,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
      });

      this.imap.once('ready', () => {
        this.imap.openBox('INBOX', false, (err, box) => {
          if (err) {
            console.error('❌ Failed to open inbox:', err.message);
            this.imap.end();
            return reject(err);
          }

          // Search for unread bounce messages
          // Common bounce indicators: "Undelivered", "Delivery Status", "Mail Delivery", "Returned mail"
          const searchCriteria = [
            'UNSEEN', // Only unread messages
            ['OR',
              ['SUBJECT', 'Undelivered'],
              ['SUBJECT', 'Delivery Status'],
              ['SUBJECT', 'Mail Delivery'],
              ['SUBJECT', 'Returned mail'],
              ['SUBJECT', 'failure notice'],
              ['SUBJECT', 'Undeliverable'],
              ['FROM', 'mailer-daemon'],
              ['FROM', 'postmaster']
            ]
          ];

          this.imap.search(searchCriteria, (err, results) => {
            if (err) {
              console.error('❌ Search failed:', err.message);
              this.imap.end();
              return reject(err);
            }

            if (!results || results.length === 0) {
              console.log('✓ No new bounce messages found');
              this.imap.end();
              return resolve([]);
            }

            console.log(`📧 Found ${results.length} potential bounce message(s)`);

            const fetch = this.imap.fetch(results, {
              bodies: '',
              markSeen: true, // Mark as read after processing
            });

            const bounces = [];

            fetch.on('message', (msg, seqno) => {
              let buffer = '';

              msg.on('body', (stream) => {
                stream.on('data', (chunk) => {
                  buffer += chunk.toString('utf8');
                });
              });

              msg.once('end', async () => {
                try {
                  const parsed = await simpleParser(buffer);
                  const bounceData = this.parseBounceMessage(parsed);
                  
                  if (bounceData) {
                    console.log(`\n📨 Bounce detected (Message ${seqno}):`);
                    console.log('  Email:', bounceData.email);
                    console.log('  Type:', bounceData.bounce_type);
                    console.log('  Reason:', bounceData.reason?.slice(0, 100));
                    
                    await this.recordBounce(bounceData);
                    bounces.push(bounceData);
                  } else {
                    console.log(`⚠️  Message ${seqno} is not a bounce (false positive)`);
                  }
                } catch (err) {
                  console.error(`❌ Error parsing message ${seqno}:`, err.message);
                }
              });
            });

            fetch.once('error', (err) => {
              console.error('❌ Fetch error:', err.message);
              this.imap.end();
              reject(err);
            });

            fetch.once('end', () => {
              console.log(`\n✅ Processed ${bounces.length} bounce(s)`);
              this.imap.end();
              resolve(bounces);
            });
          });
        });
      });

      this.imap.once('error', (err) => {
        console.error('❌ IMAP connection error:', err.message);
        reject(err);
      });

      this.imap.once('end', () => {
        console.log('📭 IMAP connection closed');
        this.lastCheck = new Date();
      });

      this.imap.connect();
    });
  }

  /**
   * Parse bounce message to extract recipient email and bounce details
   */
  parseBounceMessage(parsed) {
    const subject = parsed.subject || '';
    const text = parsed.text || '';
    const html = parsed.html || '';
    const combinedText = text + ' ' + html;

    // Skip if not actually a bounce
    if (!this.isBounceMessage(subject, combinedText)) {
      return null;
    }

    // Extract recipient email
    const email = this.extractRecipientEmail(combinedText);
    if (!email) {
      console.log('⚠️  Could not extract recipient email from bounce message');
      return null;
    }

    // Determine bounce type (hard vs soft)
    const bounceType = this.determineBounceType(combinedText);

    // Extract SMTP error code
    const smtpCode = this.extractSmtpCode(combinedText);

    // Extract reason
    const reason = this.extractBounceReason(combinedText);

    return {
      email,
      bounce_type: bounceType,
      reason: reason || 'Email delivery failed',
      smtp_code: smtpCode,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * Check if message is actually a bounce notification
   */
  isBounceMessage(subject, text) {
    const bounceIndicators = [
      'undelivered',
      'delivery status notification',
      'mail delivery failed',
      'returned mail',
      'failure notice',
      'undeliverable',
      'could not be delivered',
      'address rejected',
      'user unknown',
      'mailbox unavailable',
      'no such user',
      'recipient address rejected',
    ];

    const combined = (subject + ' ' + text).toLowerCase();
    return bounceIndicators.some(indicator => combined.includes(indicator));
  }

  /**
   * Extract recipient email address from bounce message
   */
  extractRecipientEmail(text) {
    // Common patterns in bounce messages:
    // "The following address(es) failed: user@example.com"
    // "user@example.com: recipient address rejected"
    // "<user@example.com>: host ..."
    
    const patterns = [
      /<([^>]+@[^>]+)>/,                           // <email@domain.com>
      /(?:to|recipient|address):\s*([^\s<]+@[^\s>]+)/i,  // "to: email@domain.com"
      /([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/,  // Generic email pattern
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const email = match[1].trim().toLowerCase();
        // Skip sender addresses (mailer-daemon, postmaster, etc.)
        if (!email.includes('mailer-daemon') && 
            !email.includes('postmaster') && 
            !email.includes('noreply')) {
          return email;
        }
      }
    }

    return null;
  }

  /**
   * Determine if bounce is hard (permanent) or soft (temporary)
   */
  determineBounceType(text) {
    const textLower = text.toLowerCase();

    // Hard bounce indicators (permanent failures)
    const hardBouncePatterns = [
      'user unknown',
      'no such user',
      'mailbox not found',
      'address rejected',
      'does not exist',
      'unknown user',
      'invalid recipient',
      'user not found',
      'unrouteable address',
      '550', // Permanent failure SMTP code
      '551',
      '553',
      '554',
    ];

    // Soft bounce indicators (temporary failures)
    const softBouncePatterns = [
      'mailbox full',
      'quota exceeded',
      'temporarily unavailable',
      'try again later',
      'temporarily rejected',
      'greylisted',
      'rate limit',
      '421', // Temporary failure SMTP code
      '450',
      '451',
      '452',
    ];

    if (hardBouncePatterns.some(pattern => textLower.includes(pattern))) {
      return 'hard';
    }

    if (softBouncePatterns.some(pattern => textLower.includes(pattern))) {
      return 'soft';
    }

    // Default to hard bounce if unclear
    return 'hard';
  }

  /**
   * Extract SMTP error code (e.g., 550, 554)
   */
  extractSmtpCode(text) {
    const match = text.match(/\b(5[0-9]{2}|4[0-9]{2})\b/);
    return match ? match[1] : null;
  }

  /**
   * Extract human-readable bounce reason
   */
  extractBounceReason(text) {
    // Look for diagnostic text after SMTP code
    const patterns = [
      /5[0-9]{2}\s+[0-9.]+\s+(.+?)(?:\n|$)/,    // "550 5.1.1 User unknown"
      /Diagnostic-Code:\s*(.+?)(?:\n|$)/i,       // Diagnostic-Code: smtp; 550 ...
      /Remote-MTA.*?:\s*(.+?)(?:\n|$)/i,         // Remote server response
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1].trim().slice(0, 500); // Limit to 500 chars
      }
    }

    // Fallback: extract first line containing error keywords
    const lines = text.split('\n');
    for (const line of lines) {
      const lower = line.toLowerCase();
      if ((lower.includes('user') && lower.includes('unknown')) ||
          lower.includes('does not exist') ||
          lower.includes('rejected') ||
          lower.includes('invalid')) {
        return line.trim().slice(0, 500);
      }
    }

    return 'Email delivery failed (see bounce message for details)';
  }

  /**
   * Record bounce to Supabase database
   */
  async recordBounce(bounceData) {
    const { email, bounce_type, reason, smtp_code, created_at } = bounceData;

    console.log('\n========== RECORDING BOUNCE TO SUPABASE ==========');
    console.log('Email:', email);
    console.log('Type:', bounce_type);
    console.log('Reason:', reason);
    console.log('SMTP Code:', smtp_code);
    console.log('===============================================\n');

    try {
      // Find user_id from campaign_emails table
      const { data: campaignEmail, error: lookupError } = await supabase
        .from('campaign_emails')
        .select('user_id, campaign_id')
        .eq('contact_email', email)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lookupError) {
        console.error('❌ Failed to lookup user:', lookupError.message);
        return;
      }

      if (!campaignEmail) {
        console.log('⚠️  Email not found in campaign_emails table:', email);
        console.log('   This bounce cannot be attributed to any campaign.');
        return;
      }

      const { user_id, campaign_id } = campaignEmail;
      console.log('✅ Found user_id:', user_id);
      console.log('✅ Found campaign_id:', campaign_id);

      // Insert bounce record
      const { data, error } = await supabase
        .from('bounced_emails')
        .upsert({
          user_id,
          email,
          bounce_type,
          reason: reason?.slice(0, 500),
          campaign_id,
          bounced_at: created_at,
        }, {
          onConflict: 'user_id,email'
        })
        .select();

      if (error) {
        console.error('❌ FAILED TO INSERT BOUNCE');
        console.error('Error:', error.message);
        throw error;
      }

      console.log('✅ BOUNCE RECORDED SUCCESSFULLY');
      console.log('Data:', data);

      // Update campaign_emails status
      await supabase
        .from('campaign_emails')
        .update({ 
          status: 'failed',
          error_message: `Bounce: ${reason?.slice(0, 200)}`
        })
        .eq('campaign_id', campaign_id)
        .eq('contact_email', email)
        .eq('user_id', user_id);

      console.log('✅ Updated campaign_emails status');

      // Insert tracking event
      await supabase.from('email_tracking').insert({
        user_id,
        campaign_id,
        email,
        tracking_type: 'bounce',
        created_at,
      });

      console.log('✅ Created bounce tracking event');
      console.log('===============================================\n');

    } catch (error) {
      console.error('❌ EXCEPTION IN recordBounce:', error);
      throw error;
    }
  }
}

/**
 * Create and configure bounce monitor
 */
export function createBounceMonitor(smtpConfig) {
  // Convert SMTP config to IMAP config
  const imapConfig = {
    user: smtpConfig.emailUser || smtpConfig.user,
    password: smtpConfig.emailPass || smtpConfig.password || smtpConfig.pass,
    host: getImapHost(smtpConfig.host),
    port: getImapPort(smtpConfig.host),
    tls: true,
    checkInterval: 60000, // Check every 60 seconds
  };

  return new BounceMonitor(imapConfig);
}

/**
 * Get IMAP host from SMTP host
 */
function getImapHost(smtpHost) {
  const hostMap = {
    'smtp.gmail.com': 'imap.gmail.com',
    'smtp-mail.outlook.com': 'outlook.office365.com',
    'smtp.office365.com': 'outlook.office365.com',
    'smtp.mail.yahoo.com': 'imap.mail.yahoo.com',
    'smtp.zoho.com': 'imap.zoho.com',
    'smtp.zoho.eu': 'imap.zoho.eu',
    'smtp.zoho.in': 'imap.zoho.in',
  };

  return hostMap[smtpHost] || smtpHost.replace('smtp', 'imap');
}

/**
 * Get IMAP port (default: 993 for SSL)
 */
function getImapPort(smtpHost) {
  return 993; // Standard IMAP SSL port
}

export default BounceMonitor;
