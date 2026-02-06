/**
 * Distributed Rate Limiting with Upstash Redis
 * Works in serverless environments (Vercel)
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import rateLimit from 'express-rate-limit';
import { UPSTASH_REDIS_URL, UPSTASH_REDIS_TOKEN } from '../config/index.js';

// Check if Upstash is configured
const isUpstashConfigured = UPSTASH_REDIS_URL && UPSTASH_REDIS_TOKEN;

let redis = null;
let emailRatelimit = null;
let generalRatelimit = null;
let campaignRatelimit = null;

if (isUpstashConfigured) {
  redis = new Redis({
    url: UPSTASH_REDIS_URL,
    token: UPSTASH_REDIS_TOKEN,
  });

  // Email sending: 10 requests per minute per user
  emailRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, '1 m'),
    prefix: 'ratelimit:email',
    analytics: true,
  });

  // General API: 100 requests per 15 minutes per IP
  generalRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(100, '15 m'),
    prefix: 'ratelimit:general',
  });

  // Campaign operations: 5 per minute per user (start/stop/pause)
  campaignRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(5, '1 m'),
    prefix: 'ratelimit:campaign',
  });

  console.log('✅ Upstash Redis rate limiting enabled');
} else {
  console.warn('⚠️ Upstash Redis not configured, using in-memory rate limiting (not suitable for serverless)');
}

/**
 * Create rate limit middleware with Redis fallback
 */
function createRateLimiter(upstashLimiter, fallbackConfig, identifierFn) {
  if (isUpstashConfigured && upstashLimiter) {
    return async (req, res, next) => {
      const identifier = identifierFn(req);
      const { success, limit, remaining, reset } = await upstashLimiter.limit(identifier);

      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', reset);

      if (!success) {
        return res.status(429).json({
          error: 'Rate limit exceeded. Please try again later.',
          code: 'RATE_LIMITED',
          retryAfter: Math.ceil((reset - Date.now()) / 1000),
        });
      }

      next();
    };
  }

  // Fallback to express-rate-limit (in-memory)
  return rateLimit({
    windowMs: fallbackConfig.windowMs,
    max: fallbackConfig.max,
    message: { error: fallbackConfig.message, code: 'RATE_LIMITED' },
    keyGenerator: identifierFn,
    standardHeaders: true,
    legacyHeaders: false,
  });
}

// Export rate limiters
export const redisEmailLimiter = createRateLimiter(
  emailRatelimit,
  { windowMs: 60 * 1000, max: 10, message: 'Email rate limit exceeded' },
  (req) => req.user?.id || req.ip
);

export const redisGeneralLimiter = createRateLimiter(
  generalRatelimit,
  { windowMs: 15 * 60 * 1000, max: 100, message: 'Too many requests' },
  (req) => req.ip
);

export const redisCampaignLimiter = createRateLimiter(
  campaignRatelimit,
  { windowMs: 60 * 1000, max: 5, message: 'Campaign operation rate limit exceeded' },
  (req) => req.user?.id || req.ip
);

/**
 * Campaign queue management in Redis
 */
export const campaignQueue = {
  // Add campaign to processing queue
  async enqueue(campaignId, userId, data) {
    if (!redis) return false;
    
    const key = `campaign:queue:${userId}:${campaignId}`;
    await redis.set(key, JSON.stringify({
      ...data,
      enqueuedAt: Date.now(),
      status: 'queued',
    }), { ex: 86400 }); // 24 hour expiry
    
    return true;
  },

  // Get campaign status
  async getStatus(campaignId, userId) {
    if (!redis) return null;
    
    const key = `campaign:queue:${userId}:${campaignId}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  },

  // Update campaign progress
  async updateProgress(campaignId, userId, progress) {
    if (!redis) return false;
    
    const key = `campaign:queue:${userId}:${campaignId}`;
    const existing = await redis.get(key);
    if (!existing) return false;
    
    const data = JSON.parse(existing);
    await redis.set(key, JSON.stringify({
      ...data,
      ...progress,
      updatedAt: Date.now(),
    }), { ex: 86400 });
    
    return true;
  },

  // Remove campaign from queue
  async dequeue(campaignId, userId) {
    if (!redis) return false;
    
    const key = `campaign:queue:${userId}:${campaignId}`;
    await redis.del(key);
    return true;
  },

  // Get all active campaigns for a user
  async getUserCampaigns(userId) {
    if (!redis) return [];
    
    const pattern = `campaign:queue:${userId}:*`;
    const keys = await redis.keys(pattern);
    
    const campaigns = [];
    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        campaigns.push(JSON.parse(data));
      }
    }
    
    return campaigns;
  },
};

export { redis, isUpstashConfigured };
