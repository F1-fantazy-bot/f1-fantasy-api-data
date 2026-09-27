const crypto = require('crypto');

const ACCOUNT_ID_LENGTH = 12;

/**
 * Derive a stable, non-reversible account identifier from F1 Fantasy's
 * user_guid. The raw GUID is deliberately not persisted into public-facing
 * league blobs; consumers only need a stable discriminator between accounts.
 */
function deriveAccountId(userGuid) {
  if (typeof userGuid !== 'string') {
    return null;
  }
  const normalizedGuid = userGuid.trim().toLowerCase();
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(normalizedGuid)) {
    return null;
  }

  return crypto
    .createHash('sha256')
    .update(normalizedGuid)
    .digest('hex')
    .slice(0, ACCOUNT_ID_LENGTH);
}

module.exports = { ACCOUNT_ID_LENGTH, deriveAccountId };
