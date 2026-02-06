/**
 * JWT Authentication Middleware
 * Validates Supabase JWT tokens on protected routes
 */

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { JWT_SECRET, JWT_PUBLIC_KEY, SUPABASE_URL } from '../config/index.js';

// Cache for JWKS public keys
let jwksCache = null;
let jwksCacheTime = 0;
const JWKS_CACHE_DURATION = 3600000; // 1 hour

/**
 * Fetch JWKS from Supabase
 */
async function getJWKS() {
  const now = Date.now();
  
  // Return cached JWKS if still valid
  if (jwksCache && (now - jwksCacheTime) < JWKS_CACHE_DURATION) {
    return jwksCache;
  }
  
  try {
    const jwksUrl = `${SUPABASE_URL}/.well-known/jwks.json`;
    const response = await fetch(jwksUrl);
    jwksCache = await response.json();
    jwksCacheTime = now;
    return jwksCache;
  } catch (error) {
    console.error('Failed to fetch JWKS:', error);
    return null;
  }
}

/**
 * Get public key from JWKS for a given key ID
 */
function jwkToPem(jwk) {
  // For ES256, convert JWK to PEM format
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * Middleware to require valid Supabase JWT authentication
 * Extracts user info and attaches to req.user
 */
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: 'Authentication required. Please log in.',
      code: 'AUTH_REQUIRED'
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Decode token header to get algorithm and key ID
    const decodedHeader = jwt.decode(token, { complete: true });
    const algorithm = decodedHeader?.header?.alg;
    
    console.log('🔐 Token algorithm:', algorithm);

    let verificationKey;
    
    if (algorithm === 'ES256') {
      // For ES256, fetch public key from JWKS
      const jwks = await getJWKS();
      if (!jwks || !jwks.keys || jwks.keys.length === 0) {
        throw new Error('Failed to fetch JWKS');
      }
      
      // Use the first key (or match by kid if needed)
      const jwk = jwks.keys[0];
      verificationKey = await jwkToPem(jwk);
      console.log('✅ Using JWKS public key for ES256');
    } else {
      // For HS256, use the JWT secret
      verificationKey = JWT_SECRET;
      if (!verificationKey) {
        console.error('❌ JWT_SECRET not configured');
        return res.status(500).json({ 
          error: 'Server configuration error',
          code: 'CONFIG_ERROR'
        });
      }
      console.log('✅ Using JWT_SECRET for HS256');
    }

    // Verify the JWT token
    const decoded = jwt.verify(token, verificationKey, {
      algorithms: ['HS256', 'ES256']
    });

    console.log('✅ Token verified successfully for user:', decoded.sub);

    // Attach user info to request
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      aud: decoded.aud,
    };

    next();
  } catch (error) {
    console.error('❌ JWT verification failed:', error.name, error.message);
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Session expired. Please log in again.',
        code: 'TOKEN_EXPIRED'
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        error: 'Invalid authentication token.',
        code: 'INVALID_TOKEN',
        details: error.message
      });
    }

    console.error('Auth error:', error);
    return res.status(401).json({ 
      error: 'Authentication failed.',
      code: 'AUTH_FAILED'
    });
  }
}

/**
 * Optional auth - attaches user if valid token present, but doesn't require it
 */
export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];

  if (!JWT_SECRET) {
    req.user = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'supabase',
    });

    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
    };
  } catch {
    req.user = null;
  }

  next();
}

/**
 * Middleware to ensure request is for the authenticated user's data
 */
export function requireOwnership(userIdField = 'userId') {
  return (req, res, next) => {
    const requestedUserId = req.body[userIdField] || req.params[userIdField] || req.query[userIdField];
    
    if (!req.user) {
      return res.status(401).json({ 
        error: 'Authentication required.',
        code: 'AUTH_REQUIRED'
      });
    }

    if (requestedUserId && requestedUserId !== req.user.id) {
      return res.status(403).json({ 
        error: 'Access denied. You can only access your own data.',
        code: 'ACCESS_DENIED'
      });
    }

    next();
  };
}
