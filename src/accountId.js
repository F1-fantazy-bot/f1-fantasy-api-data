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
  // F1 treats this as an opaque account identifier. Its format is not
  // guaranteed to be a UUID, so validating it as one loses real accounts.
  if (!normalizedGuid || Array.from(normalizedGuid).some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  )) {
    return null;
  }

  return crypto
    .createHash('sha256')
    .update(normalizedGuid)
    .digest('hex')
    .slice(0, ACCOUNT_ID_LENGTH);
}

module.exports = { ACCOUNT_ID_LENGTH, deriveAccountId };
