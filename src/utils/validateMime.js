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
