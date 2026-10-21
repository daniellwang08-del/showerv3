import { fileToDataUrl } from '../resumeBuilder/headerBackgrounds';

export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp';
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

/** Reads a chosen photo for cropping, or throws a message fit to show the user. */
export async function readPhotoFile(file: File): Promise<string> {
  if (!PHOTO_ACCEPT.split(',').includes(file.type)) {
    throw new Error('Choose a JPEG, PNG or WebP image.');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('That image is larger than 15 MB. Choose a smaller one.');
  }
  return fileToDataUrl(file);
}
