// Supabase client setup
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from '../config/index.js';

console.log('\n========== SUPABASE INITIALIZATION ==========');
console.log('SUPABASE_URL:', SUPABASE_URL);
console.log('SUPABASE_SERVICE_KEY present:', SUPABASE_SERVICE_KEY ? 'YES (length: ' + SUPABASE_SERVICE_KEY.length + ')' : 'NO');
console.log('SUPABASE_SERVICE_KEY starts with:', SUPABASE_SERVICE_KEY ? SUPABASE_SERVICE_KEY.substring(0, 20) + '...' : 'N/A');

let supabase = null;

if (SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  console.log('✅ Supabase client initialized successfully');
} else {
  console.log('❌ SUPABASE_SERVICE_KEY not set - tracking events will only be logged');
}

console.log('=============================================\n');

export { supabase };
