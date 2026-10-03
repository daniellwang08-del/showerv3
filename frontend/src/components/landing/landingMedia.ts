/**
 * Public stock used only on the marketing page.
 *
 * Unsplash License (https://unsplash.com/license) and Pexels License
 * (https://www.pexels.com/license/) allow hotlinking these files. Wikimedia
 * Commons GIFs are used where an actual looping gif is the right texture.
 * Nothing here is a customer photo or a fabricated testimonial.
 */

const UNSPLASH = 'https://images.unsplash.com';

function photo(id: string, w: number, extra = '') {
  return `${UNSPLASH}/${id}?auto=format&fit=crop&w=${w}&q=80${extra}`;
}

export const HERO_VIDEO =
  'https://videos.pexels.com/video-files/3129671/3129671-hd_1920_1080_30fps.mp4';

export const HERO_POSTER = photo('photo-1498050108023-c4e6cde34c31', 1920);

/** Subtle looping gif overlay, digital rain, Wikimedia Commons. */
export const HERO_GIF =
  'https://upload.wikimedia.org/wikipedia/commons/2/21/Matrix_digital_rain_animation_small_letters_only.gif';

export const AUTOFILL_VIDEO =
  'https://videos.pexels.com/video-files/7687651/7687651-hd_1920_1080_25fps.mp4';

export const AUTOFILL_POSTER = photo('photo-1486312338219-ce68d2c6f44d', 1400);

export const FEATURES_BAND = photo('photo-1551288049-bebda4e38f71', 1600);

export const CLOSING_IMAGE = photo('photo-1600880292203-757bb62b4baf', 1920);

export const STEP_VISUALS = [
  {
    src: photo('photo-1519389950473-47ba0277781c', 900),
    caption: 'Fresh roles, every cycle',
  },
  {
    src: photo('photo-1498050108023-c4e6cde34c31', 900),
    caption: 'The real posting, not a preview',
  },
  {
    src: photo('photo-1551288049-bebda4e38f71', 900),
    caption: 'Scored against your profile',
  },
  {
    src: photo('photo-1586281380349-632531db7ed4', 900),
    caption: 'Résumé and letter, already written',
  },
  {
    src: photo('photo-1486312338219-ce68d2c6f44d', 900),
    caption: 'The form fills in your browser',
  },
] as const;

export const FILM_STILLS = [
  { src: photo('photo-1521737604893-d14cc237f11d', 720), label: 'Source' },
  { src: photo('photo-1553877522-43269d4ea984', 720), label: 'Read' },
  { src: photo('photo-1460925895917-afdab827c52f', 720), label: 'Score' },
  { src: photo('photo-1586281380349-632531db7ed4', 720), label: 'Tailor' },
  { src: photo('photo-1454165804606-c3d57bc86b40', 720), label: 'Apply' },
  { src: photo('photo-1522202176988-66273c2fd55f', 720), label: 'Review' },
  { src: photo('photo-1551434678-e076c223a692', 720), label: 'Ship' },
  { src: photo('photo-1516321318423-f06f85e504b3', 720), label: 'Repeat' },
] as const;

export const CAST = [
  { src: photo('photo-1494790108377-be9c29b29330', 240), role: 'Ready' },
  { src: photo('photo-1507003211169-0a1dd7228f2d', 240), role: '94' },
  { src: photo('photo-1573496359142-b8d87734a5a2', 240), role: 'Live' },
  { src: photo('photo-1472099645785-5658abf4ff4e', 240), role: '88' },
  { src: photo('photo-1534528741775-53994a69daeb', 240), role: 'Apply' },
  { src: photo('photo-1500648767791-11c2d608db6a', 240), role: '81' },
] as const;

export const TOASTS = [
  { title: 'Senior Backend Engineer', detail: 'Résumé tailored · 94 match' },
  { title: 'Platform Engineer, Data', detail: 'Workday autofill · 28 fields' },
  { title: 'Staff Software Engineer', detail: 'Cover letter compiled · PDF ready' },
  { title: 'Northwind Labs', detail: 'Attached and queued · your click next' },
] as const;
