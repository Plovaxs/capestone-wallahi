export const sanitizeFileExtension = (fileName) => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const allowed = ['jpg', 'jpeg', 'png', 'webp'];
  if (!allowed.includes(ext)) {
    return 'png';
  }
  return ext;
};
