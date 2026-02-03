// Shared utilities
export function decodeTrackingId(trackingId) {
  try {
    const decoded = Buffer.from(trackingId, 'base64url').toString('utf8');
    const [campaignId, email, userId] = decoded.split(':');
    return { campaignId, email, userId };
  } catch {
    return null;
  }
}
