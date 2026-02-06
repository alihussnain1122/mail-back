/**
 * JWT Authentication Middleware
 * Validates Supabase JWT tokens on protected routes
 */

import { supabase } from '../services/supabase.js';

/**
 * Middleware to require valid Supabase JWT authentication
 * Uses Supabase SDK to verify tokens
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
    // Use Supabase SDK to verify the JWT token
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      console.error('❌ Token verification failed:', error?.message);
      return res.status(401).json({ 
        error: 'Invalid authentication token.',
        code: 'INVALID_TOKEN'
      });
    }

    console.log('✅ Token verified successfully for user:', user.id);

    // Attach user info to request
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      aud: user.aud,
    };

    next();
  } catch (error) {
    console.error('❌ Auth error:', error.message);
    return res.status(401).json({ 
      error: 'Authentication failed.',
      code: 'AUTH_FAILED',
      details: error.message
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
