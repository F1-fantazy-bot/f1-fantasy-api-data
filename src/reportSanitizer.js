// Shared by collected diagnostics and local notification-delivery errors.
function sanitize(value, sensitiveValues = []) {
  let text = String(value ?? 'unknown');
  const secrets = [
    ...sensitiveValues,
    ...Object.entries(process.env)
      .filter(([key]) =>
        /password|token|secret|connection_string|f1_fantasy_email/i.test(key),
      )
      .map(([, secret]) => secret),
  ].filter(
    (secret) =>
      secret !== undefined && secret !== null && String(secret).length,
  );
  for (const secret of secrets.sort(
    (a, b) => String(b).length - String(a).length,
  )) {
    text = text.split(String(secret)).join('[redacted]');
  }
  return (
    text
      .replace(
        /(?:DefaultEndpointsProtocol|AccountName|AccountKey|SharedAccessSignature|EndpointSuffix)=[^\s]+/gi,
        '[connection string redacted]',
      )
      .replace(/https?:\/\/[^\s<>]+/gi, '[URL redacted]')
      .replace(/\/services\/user\/[^\s]+/gi, '/services/user/[redacted]')
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[authorization redacted]')
      .replace(/\b\d{5,}:[A-Za-z\d_-]{20,}\b/g, '[token redacted]')
      .replace(
        /\beyJ[A-Za-z\d_-]+\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+\b/g,
        '[token redacted]',
      )
      .replace(
        /((?:["']?)(?:password|passwd|token|secret|api[_-]?key|account[_-]?id|user[_-]?guid|guid|user[_-]?id|social[_-]?id|user[_-]?name|email)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
        '$1[redacted]',
      )
      .replace(
        /[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}(?:-\d+-\d+)?/gi,
        '[redacted]',
      )
      .replace(/\b[a-f\d]{12}\b/gi, '[account redacted]')
      .replace(/[A-Z\d._%+-]+@[A-Z\d.-]+\.[A-Z]{2,}/gi, '[email redacted]')
      .replace(/\/(?:Users|home)\/[^/\s]+/g, '/[private-user]')
      .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, '[private-user]')
      // eslint-disable-next-line no-control-regex -- Strip transport control characters, preserving stack newlines and tabs.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  );
}

function safeText(value, sensitiveValues = []) {
  return truncate(
    sanitize(value, sensitiveValues).replace(/[\r\n]+/g, ' '),
    240,
  );
}

function safeStack(error, sensitiveValues = []) {
  if (!error?.stack) return null;
  const stack = sanitize(error.stack, sensitiveValues);
  const marker = '\n[stack truncated]';
  return stack.length > 8000
    ? `${truncate(stack, 8000 - marker.length)}${marker}`
    : stack;
}

function truncate(text, limit) {
  const end = /[\uD800-\uDBFF]/.test(text[limit - 1]) ? limit - 1 : limit;
  return text.slice(0, end);
}

module.exports = { sanitize, safeText, safeStack };
