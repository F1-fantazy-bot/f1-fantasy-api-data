const crypto = require('crypto');

const ACCOUNT_ID_LENGTH = 12;

/**
 * Derive a stable, opaque account identifier from the F1 Fantasy user GUID.
 *
 * The raw GUID is intentionally not persisted in league blobs. A 12-hex
 * SHA-256 prefix gives us a compact 48-bit identifier that is stable across
 * leagues/runs while keeping the upstream account GUID private.
 */
function deriveAccountId(userGuid) {
  const normalized =
    typeof userGuid === 'string' ? userGuid.trim() : '';

  if (!normalized) {
    return null;
  }

  return crypto
    .createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, ACCOUNT_ID_LENGTH);
}

module.exports = {
  ACCOUNT_ID_LENGTH,
  deriveAccountId,
};
