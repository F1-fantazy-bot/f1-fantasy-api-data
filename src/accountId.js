const crypto = require('crypto');

const ACCOUNT_ID_LENGTH = 12;

/**
 * Derive a stable, non-reversible account identifier from F1 Fantasy's
 * user_guid. The raw GUID is deliberately not persisted into public-facing
 * league blobs; consumers only need a stable discriminator between accounts.
 */
function deriveAccountId(userGuid) {
  if (typeof userGuid !== 'string' || userGuid.trim().length === 0) {
    return null;
  }

  return crypto
    .createHash('sha256')
    .update(userGuid.trim().toLowerCase())
    .digest('hex')
    .slice(0, ACCOUNT_ID_LENGTH);
}

module.exports = { ACCOUNT_ID_LENGTH, deriveAccountId };
