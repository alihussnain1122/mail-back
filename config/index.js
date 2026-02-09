import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  port: process.env.PORT || 3001,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  defaultSenderName: process.env.DEFAULT_SENDER_NAME || 'Support Team',
  maxFileSize: 5 * 1024 * 1024, // 5MB
  backendUrl: process.env.BACKEND_URL || 'https://mail-back-nine.vercel.app',
  groqApiKey: process.env.GROQ_API_KEY, // For AI template generation
};

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
export const JWT_SECRET = process.env.SUPABASE_JWT_SECRET; // From Supabase dashboard > Settings > API > JWT Secret
export const JWT_PUBLIC_KEY = process.env.SUPABASE_JWT_PUBLIC_KEY; // For ES256 token verification
export const HMAC_SECRET = process.env.HMAC_SECRET || 'change-this-in-production'; // For signing tracking IDs
export const UPSTASH_REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
export const UPSTASH_REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!SUPABASE_URL) {
  console.warn('Warning: SUPABASE_URL not set');
}

export const ALLOWED_ORIGINS = [
  CONFIG.frontendUrl,
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5174',
  'https://cold-mailing-ebon.vercel.app',
  // Add any additional allowed origins from env
  ...(process.env.ADDITIONAL_ORIGINS ? process.env.ADDITIONAL_ORIGINS.split(',') : []),
].filter(Boolean);

// Log allowed origins on startup
console.log('Allowed CORS origins:', ALLOWED_ORIGINS);

export const isVercel = !!process.env.VERCEL;
