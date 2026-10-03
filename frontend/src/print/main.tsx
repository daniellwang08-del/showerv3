import '../styles/resumeFonts.css';
import { createRoot } from 'react-dom/client';
import { PAPER_SIZES, ResumePageStack, paperOf, type ResumeLayoutInfo } from '../components/resumeBuilder/PagedResumePreview';
import { RESUME_FONT_RENDER, type CoverLetterBody } from '../components/resumeBuilder/ResumePreview';
import type { ResumeDesign } from '../types/resumeDesign';
import type { UserProfile } from '../types/profile';
import { effectiveProfile } from '../utils/resumeContent';

export interface PrintPayload {
  design: ResumeDesign;
  profile: UserProfile | null;
  letter?: CoverLetterBody | null;
}

export interface PrintResult {
  pageCount: number;
  breaks: number[];
  paper: string;
  fontsLoaded: boolean;
}

declare global {
  interface Window {
    renderResume: (payload: PrintPayload) => Promise<PrintResult>;
  }
}

const root = createRoot(document.getElementById('print-root')!);
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function loadFaces(family: string): Promise<boolean> {
  const face = RESUME_FONT_RENDER[family];
  if (!face) return false;
  const specs = ['400', '700', 'italic 400', 'italic 700'].map((w) => `${w} 16px "${face}"`);
  const loaded = await Promise.all(specs.map((s) => document.fonts.load(s).catch(() => [])));
  return loaded.every((faces) => faces.length > 0);
}

async function decodeImage(src: string | undefined): Promise<void> {
  if (!src) return;
  const img = new Image();
  img.src = src;
  await img.decode().catch(() => undefined);
}

window.renderResume = async (payload) => {
  const { design, letter = null } = payload;
  const profile = effectiveProfile(payload.profile, design.content ?? null);
  const paper = PAPER_SIZES[paperOf(design)];

  let pageStyle = document.getElementById('nao-page-style');
  if (!pageStyle) {
    pageStyle = document.createElement('style');
    pageStyle.id = 'nao-page-style';
    document.head.appendChild(pageStyle);
  }
  pageStyle.textContent = `@page { size: ${paper.css}; margin: 0; } html, body { margin: 0; padding: 0; background: #ffffff; }`;

  const fontsLoaded = await loadFaces(design.typography.font_family);
  await decodeImage(design.layout.header_background === 'image' ? design.layout.header_image?.data_url : undefined);

  let info: ResumeLayoutInfo | null = null;
  root.render(
    <ResumePageStack
      mode="print"
      design={design}
      profile={profile}
      letter={letter}
      onLayout={(next) => {
        info = next;
      }}
    />,
  );

  await document.fonts.ready;
  // Wait until pagination is stable for a few consecutive frames.
  let last = '';
  let stable = 0;
  for (let i = 0; i < 300 && stable < 4; i++) {
    await nextFrame();
    const key = JSON.stringify(info);
    stable = info && key === last ? stable + 1 : 0;
    last = key;
  }
  const done = info as ResumeLayoutInfo | null;
  return {
    pageCount: done?.pageCount ?? 0,
    breaks: done?.breaks ?? [],
    paper: done?.paper ?? paperOf(design),
    fontsLoaded,
  };
};
