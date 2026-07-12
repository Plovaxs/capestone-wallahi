export const sanitizeFileExtension = (fileName) => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const allowed = ['jpg', 'jpeg', 'png', 'webp'];
  if (!allowed.includes(ext)) {
    return 'png';
  }
  return ext;
};

const SQL_INJECTION_PATTERNS = [
  /--.*$/gm,
  /\/\*[\s\S]*?\*\//g,
  /;+/g,
  /\bunion\b\s+\bselect\b/gi,
  /\bor\b\s+1\s*=\s*1\b/gi,
  /\band\b\s+1\s*=\s*1\b/gi,
  /\bdrop\b\s+\btable\b/gi,
  /\binsert\b\s+\binto\b/gi,
  /\bupdate\b\s+\w+\s+\bset\b/gi,
  /\bdelete\b\s+\bfrom\b/gi,
  /\bexec(?:ute)?\b/gi,
  /\bxp_\w+\b/gi,
  /\bsleep\s*\(\s*\d+\s*\)/gi,
];

const SQL_META_CHARS = /['"`\\<>]/g;

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const HTML_TAGS = /<\/?[a-z][\s\S]*?>/gi;

export const detectSqlInjectionAttempt = (value) => {
  const text = String(value ?? '');
  return SQL_INJECTION_PATTERNS.some((pattern) => pattern.test(text));
};

export const sanitizeUserInput = (value, { maxLength = 500 } = {}) => {
  const text = String(value ?? '');
  const cleaned = text
    .replace(CONTROL_CHARS, '')
    .replace(HTML_TAGS, '')
    .replace(SQL_META_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return cleaned;
  }

  return cleaned.slice(0, maxLength);
};

export const sanitizeSqlInput = (value) => {
  let sanitized = sanitizeUserInput(value, { maxLength: 2000 });

  for (const pattern of SQL_INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, ' ');
  }

  return sanitized
    .replace(/\s+/g, ' ')
    .trim();
};
