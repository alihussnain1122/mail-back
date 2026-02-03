// Supabase client setup
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from '../config/index.js';

let supabase = null;

if (SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });
  console.log('✅ Supabase client initialized for tracking');
} else {
  console.warn('⚠️ SUPABASE_SERVICE_KEY not set - tracking events will only be logged');
}

export { supabase };
