#!/usr/bin/env node

/**
 * Test script for bounce webhook endpoint
 * 
 * Usage:
 *   node test-bounce-webhook.js http://localhost:3000
 *   node test-bounce-webhook.js https://your-domain.vercel.app
 */

const BACKEND_URL = process.argv[2] || 'http://localhost:3000';

async function testWebhook(provider, payload) {
  const url = `${BACKEND_URL}/api/email/bounce-webhook/${provider}`;
  
  console.log(`\n🧪 Testing ${provider.toUpperCase()} webhook...`);
  console.log(`URL: ${url}`);
  console.log(`Payload:`, JSON.stringify(payload, null, 2));
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const status = response.status;
    const text = await response.text();
    
    if (status === 200) {
      console.log(`✅ Success: ${status} ${text}`);
    } else {
      console.log(`❌ Failed: ${status} ${text}`);
    }
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
  }
}

async function runTests() {
  console.log('\n========================================');
  console.log('Bounce Webhook Test Suite');
  console.log('========================================');
  console.log(`Backend URL: ${BACKEND_URL}`);
  console.log('========================================');

  // Test 1: SendGrid webhook
  await testWebhook('sendgrid', [
    {
      email: 'bounce-test@example.com',
      event: 'bounce',
      type: 'blocked',
      status: '5.1.1',
      reason: 'Mailbox does not exist',
      timestamp: Math.floor(Date.now() / 1000),
      campaign_id: '00000000-0000-0000-0000-000000000000'
    }
  ]);

  // Test 2: Mailgun webhook
  await testWebhook('mailgun', {
    'event-data': {
      event: 'bounced',
      recipient: 'bounce-test@example.com',
      'delivery-status': {
        code: 550,
        description: 'No such user'
      },
      timestamp: Math.floor(Date.now() / 1000),
      'user-variables': {
        campaign_id: '00000000-0000-0000-0000-000000000000'
      }
    }
  });

  // Test 3: Generic webhook
  await testWebhook('generic', {
    email: 'bounce-test@example.com',
    bounce_type: 'hard',
    reason: 'Test bounce notification',
    smtp_code: '550',
    campaign_id: '00000000-0000-0000-0000-000000000000',
    user_id: '00000000-0000-0000-0000-000000000000'
  });

  // Test 4: Postmark webhook
  await testWebhook('postmark', {
    RecordType: 'Bounce',
    Email: 'bounce-test@example.com',
    Type: 'HardBounce',
    TypeCode: 1,
    Description: 'The server was unable to deliver your message',
    BouncedAt: new Date().toISOString(),
    Metadata: {
      campaign_id: '00000000-0000-0000-0000-000000000000'
    }
  });

  console.log('\n========================================');
  console.log('Tests Complete');
  console.log('========================================');
  console.log('\nNext steps:');
  console.log('1. Check Vercel logs for detailed output');
  console.log('2. Query Supabase bounced_emails table:');
  console.log('   SELECT * FROM bounced_emails WHERE email = \'bounce-test@example.com\';');
  console.log('3. If no records appear, check:');
  console.log('   - SUPABASE_SERVICE_KEY env var is set');
  console.log('   - RLS policies allow INSERT with CHECK (true)');
  console.log('   - campaign_id exists in campaigns table');
  console.log('   - user_id exists in auth.users table');
  console.log('\n');
}

runTests().catch(console.error);
