/**
 * JWT Authentication Middleware
 * Validates Supabase JWT tokens on protected routes
 */

import jwt from 'jsonwebtoken';
import { JWT_SECRET, SUPABASE_URL } from '../config/index.js';

/**
 * Middleware to require valid Supabase JWT authentication
 * Extracts user info and attaches to req.user
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: 'Authentication required. Please log in.',
      code: 'AUTH_REQUIRED'
    });
  }

  const token = authHeader.split(' ')[1];

  if (!JWT_SECRET) {
    console.error('JWT_SECRET not configured');
    return res.status(500).json({ 
      error: 'Server configuration error',
      code: 'CONFIG_ERROR'
    });
  }

  try {
    // Verify the JWT token
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
      // Don't validate issuer - Supabase uses dynamic issuer based on project URL
    });

    // Attach user info to request
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      aud: decoded.aud,
    };

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Session expired. Please log in again.',
        code: 'TOKEN_EXPIRED'
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        error: 'Invalid authentication token.',
        code: 'INVALID_TOKEN'
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
