import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  DEFAULT_CERTIFICATES_STYLE,
  DEFAULT_EDUCATION_STYLE,
  DEFAULT_EXPERIENCE_STYLE,
  DEFAULT_SKILLS_STYLE,
  DEFAULT_SUMMARY_STYLE,
  type ResumeDesign,
  type ResumePhoto,
} from '@/types/resumeDesign';
import { useResumeBuilderStore } from '@/stores/resumeBuilderStore';
import { ResumePreview } from './ResumePreview';
import { PhotoControls } from './PhotoControls';

const PHOTO: ResumePhoto = {
  data_url: 'data:image/jpeg;base64,AAAA',
  enabled: true,
  shape: 'circle',
  size: 'md',
  source: 'upload',
};

function design(layout: Partial<ResumeDesign['layout']> = {}): ResumeDesign {
  return {
    theme_id: 'classic',
    typography: {
      font_family: 'Arial',
      base_font_pt: 10,
      heading_scale: 1.2,
      name_scale: 2,
      line_spacing: 1.15,
      uppercase_headings: true,
    },
    colors: { text: '#111111', heading: '#111111', accent: '#2563eb', muted: '#555555' },
    layout: {
      columns: 1,
      margin_pt: 54,
      section_gap_pt: 10,
      header_align: 'left',
      header_background: 'none',
      header_padding_pt: 16,
      contact_layout: 'inline',
      contact_icons: 'none',
      accent_rule: false,
      section_order: ['summary'],
      hidden_sections: [],
      ...layout,
    },
    sections: {
      skills_layout: 'categories',
      show_period: true,
      show_location: true,
      summary_style: DEFAULT_SUMMARY_STYLE,
      skills_style: DEFAULT_SKILLS_STYLE,
      experience_style: DEFAULT_EXPERIENCE_STYLE,
      education_style: DEFAULT_EDUCATION_STYLE,
      certificates_style: DEFAULT_CERTIFICATES_STYLE,
    },
  } as ResumeDesign;
}

const PROFILE = { name_first: 'Ada', name_last: 'Lovelace', email: 'ada@example.com' } as never;

function photoImg(container: HTMLElement) {
  return container.querySelector('img[data-resume-photo]');
}

describe('resume photo in the preview', () => {
  it('sits after the name and contacts for a left-aligned header', () => {
    const { container } = render(<ResumePreview design={design({ photo: PHOTO })} profile={PROFILE} />);
    const img = photoImg(container);
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('alt', '');
    const name = screen.getByText('Ada Lovelace');
    // Reading order: the name comes before the photo.
    expect(name.compareDocumentPosition(img as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((img as HTMLElement).style.borderRadius).toBe('50%');
  });

  it('sits above the name for a centered header', () => {
    const { container } = render(
      <ResumePreview design={design({ header_align: 'center', photo: { ...PHOTO, shape: 'square' } })} profile={PROFILE} />,
    );
    const img = photoImg(container) as HTMLElement;
    const name = screen.getByText('Ada Lovelace');
    expect(name.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(img.style.borderRadius).toBe('0px');
  });

  it('is left out when hidden and on cover letters', () => {
    const hidden = render(<ResumePreview design={design({ photo: { ...PHOTO, enabled: false } })} profile={PROFILE} />);
    expect(photoImg(hidden.container)).toBeNull();
    hidden.unmount();
    const letter = render(
      <ResumePreview design={design({ photo: PHOTO })} profile={PROFILE} letter={{ title: 'Cover Letter', paragraphs: ['Hi'] }} />,
    );
    expect(photoImg(letter.container)).toBeNull();
  });
});

function renderControls(props: Partial<Parameters<typeof PhotoControls>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <MemoryRouter>
      <PhotoControls photo={null} profilePhoto={null} onChange={onChange} {...props} />
    </MemoryRouter>,
  );
  return onChange;
}

describe('PhotoControls', () => {
  it('points to the profile page when there is no profile photo', () => {
    renderControls();
    expect(screen.getByRole('button', { name: /use profile photo/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: /add one on your profile/i })).toHaveAttribute('href', '/app/profile');
  });

  it('copies the profile photo into the resume', () => {
    const onChange = renderControls({ profilePhoto: 'data:image/jpeg;base64,PROFILE' });
    fireEvent.click(screen.getByRole('button', { name: /use profile photo/i }));
    expect(onChange).toHaveBeenCalledWith({
      data_url: 'data:image/jpeg;base64,PROFILE',
      enabled: true,
      shape: 'circle',
      size: 'md',
      source: 'profile',
    });
  });

  it('hides, reshapes and removes an existing photo', () => {
    const onChange = renderControls({ photo: PHOTO });
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenLastCalledWith({ ...PHOTO, enabled: false });
    fireEvent.click(screen.getByRole('button', { name: 'Rounded' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...PHOTO, shape: 'rounded' });
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('rejects unsupported files before cropping', async () => {
    renderControls();
    const input = screen.getByLabelText('Upload resume photo');
    fireEvent.change(input, { target: { files: [new File(['x'], 'me.heic', { type: 'image/heic' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('JPEG, PNG or WebP');
  });
});

describe('setPhoto', () => {
  afterEach(() => {
    useResumeBuilderStore.setState({ design: null, baseline: '', saving: false });
  });

  it('stores the photo and drops the stale header measurement', () => {
    const d = design({ header_metrics: { band_pt: 80, gap_pt: 8, measured_at_px: 816 } });
    useResumeBuilderStore.setState({ design: d, baseline: JSON.stringify(d) });
    useResumeBuilderStore.getState().setPhoto(PHOTO);
    const layout = useResumeBuilderStore.getState().design?.layout;
    expect(layout?.photo).toEqual(PHOTO);
    expect(layout?.header_metrics).toBeNull();
  });
});
