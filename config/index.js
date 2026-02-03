import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  port: process.env.PORT || 3001,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  defaultSenderName: process.env.DEFAULT_SENDER_NAME || 'Support Team',
  maxFileSize: 5 * 1024 * 1024, // 5MB
  backendUrl: process.env.BACKEND_URL || 'https://mail-back-nine.vercel.app',
};

export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://otkpdhkerefqaulhagqw.supabase.co';
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export const ALLOWED_ORIGINS = [
  CONFIG.frontendUrl,
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5174',
  'https://cold-mailing-ebon.vercel.app',
];

export const isVercel = !!process.env.VERCEL;
