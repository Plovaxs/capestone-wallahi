export const validateAvatarFile = (file) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    return { valid: false, error: `Unsupported MIME type: ${file.type}` };
  }
  const maxSize = 2 * 1024 * 1024;
  if (!file.size || file.size > maxSize) {
    return { valid: false, error: 'File size exceeds 2MB limit.' };
  }
  return { valid: true };
};

export const validateLoaFile = (file) => {
  const allowedTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  ];
  if (!allowedTypes.includes(file.type)) {
    return { valid: false, error: `Unsupported file type: ${file.type || 'unknown'}` };
  }
  const maxSize = 10 * 1024 * 1024; // 10MB
  if (!file.size || file.size > maxSize) {
    return { valid: false, error: 'File size exceeds 10MB limit.' };
  }
  return { valid: true };
};

export const validateTaskSubmissionFile = (file) => {
  const allowedTypes = [
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
    'text/plain',
  ];
  if (!allowedTypes.includes(file.type)) {
    return { valid: false, error: `Unsupported file type: ${file.type || 'unknown'}` };
  }
  const maxSize = 10 * 1024 * 1024; // 10MB — documents run larger than avatars
  if (!file.size || file.size > maxSize) {
    return { valid: false, error: 'File size exceeds 10MB limit.' };
  }
  return { valid: true };
};
