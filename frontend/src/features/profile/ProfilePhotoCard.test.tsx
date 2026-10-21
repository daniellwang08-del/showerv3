import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fetchProfilePhoto, removeProfilePhoto } from '@/api/profilePhotoApi';
import { ProfilePhotoCard } from './ProfilePhotoCard';

vi.mock('@/api/profilePhotoApi', () => ({
  fetchProfilePhoto: vi.fn(),
  saveProfilePhoto: vi.fn(),
  removeProfilePhoto: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProfilePhotoCard name="Ada Lovelace" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(fetchProfilePhoto).mockReset();
  vi.mocked(removeProfilePhoto).mockReset();
});

describe('ProfilePhotoCard', () => {
  it('shows initials and an upload button without a photo', async () => {
    vi.mocked(fetchProfilePhoto).mockResolvedValue(null);
    renderCard();
    await waitFor(() => expect(fetchProfilePhoto).toHaveBeenCalled());
    expect(screen.getByText('AL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload photo/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('shows the saved photo and removes it', async () => {
    vi.mocked(fetchProfilePhoto).mockResolvedValue('data:image/jpeg;base64,AAAA');
    vi.mocked(removeProfilePhoto).mockResolvedValue(undefined);
    renderCard();
    expect(await screen.findByRole('img', { name: 'Your profile photo' })).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,AAAA',
    );
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await waitFor(() => expect(removeProfilePhoto).toHaveBeenCalled());
    expect(await screen.findByText('AL')).toBeInTheDocument();
  });
});
