// Test bounce recording
import { supabase } from './services/supabase.js';

async function testBounce() {
  console.log('Testing bounce recording...');
  console.log('Supabase client:', supabase ? 'initialized' : 'NULL');
  
  if (!supabase) {
    console.error('❌ Supabase client not initialized!');
    console.error('Check if SUPABASE_SERVICE_KEY is set in .env');
    process.exit(1);
  }

  const testData = {
    user_id: 'f91ff3e0-fed3-4721-aded-36bea40ef37c', // Replace with your user ID
    email: 'test-bounce@invalid-domain-12345.com',
    bounce_type: 'hard',
    reason: 'Test bounce - Mailbox does not exist',
    campaign_id: null,
  };

  console.log('Attempting to insert bounce:', testData);

  try {
    const { data, error } = await supabase
      .from('bounced_emails')
      .upsert(testData, { onConflict: 'user_id,email' })
      .select();

    if (error) {
      console.error('❌ Failed to insert bounce:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      
      if (error.code === 'PGRST301' || error.message.includes('policy')) {
        console.error('\n⚠️  RLS Policy Issue:');
        console.error('Run this SQL in Supabase SQL Editor:');
        console.error(`
DROP POLICY IF EXISTS "Service can insert bounces" ON bounced_emails;

CREATE POLICY "Service can insert bounces" ON bounced_emails
  FOR INSERT WITH CHECK (true);
        `);
      }
    } else {
      console.log('✅ Bounce recorded successfully!');
      console.log('Data:', data);
      
      // Clean up test data
      const { error: deleteError } = await supabase
        .from('bounced_emails')
        .delete()
        .eq('email', testData.email);
      
      if (!deleteError) {
        console.log('✅ Test data cleaned up');
      }
    }
  } catch (err) {
    console.error('❌ Exception:', err);
  }
}

testBounce();
