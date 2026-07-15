
//This sanitizefileextension function is used to sanitize the file extension of a given file name. 
// It checks if the file extension is in the allowed list of extensions (jpg, jpeg, png, webp). 
// If the extension is not allowed, it defaults to 'png'.
export const sanitizeFileExtension = (fileName) => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const allowed = ['jpg', 'jpeg', 'png', 'webp'];
  if (!allowed.includes(ext)) {
    return 'png';
  }
  return ext;
};

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

//This sanitization is not a security control, it is just to clean up user input for better UX and to avoid accidental injection of control characters or excessive whitespace. 
// It does not protect against SQL injection, XSS, or other attacks.
//The SQL injection and XSS protection is handled by the database driver and the frontend framework respectively. This function is just to clean up user input for better UX and to avoid accidental injection of control characters or excessive whitespace.
export const sanitizeUserInput = (value, { maxLength = 500 } = {}) => {
  const text = String(value ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return text;
  }

  return text.slice(0, maxLength);
};

export const sanitizeTaskSubmissionExtension = (fileName) => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const allowed = ['jpg', 'jpeg', 'png', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'];
  if (!allowed.includes(ext)) {
    return 'bin'; // unrecognized extension — falls back to a generic, non-executable label
  }
  return ext;
};