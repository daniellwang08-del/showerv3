import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  detectExtension: vi.fn(),
  connectExtensionSession: vi.fn(),
}));
vi.mock('@/lib/extensionBridge', () => bridge);

import { ExtensionConnectPage } from './ExtensionConnectPage';

describe('ExtensionConnectPage', () => {
  beforeEach(() => {
    bridge.detectExtension.mockReset();
    bridge.connectExtensionSession.mockReset();
  });

  it('signs the extension in with the website session', async () => {
    bridge.detectExtension.mockResolvedValue({ installed: true });
    bridge.connectExtensionSession.mockResolvedValue({ ok: true });
    render(<ExtensionConnectPage email="raoyin@example.com" />);
    expect(await screen.findByText('Extension signed in')).toBeInTheDocument();
    expect(screen.getByText(/signed in as raoyin@example.com/)).toBeInTheDocument();
    expect(bridge.connectExtensionSession).toHaveBeenCalledTimes(1);
  });

  it('explains when the extension is not installed', async () => {
    bridge.detectExtension.mockResolvedValue({ installed: false });
    render(<ExtensionConnectPage />);
    expect(await screen.findByText('Extension not found')).toBeInTheDocument();
    expect(bridge.connectExtensionSession).not.toHaveBeenCalled();
  });

  it('shows the error and a retry when the hand-off fails', async () => {
    bridge.detectExtension.mockResolvedValue({ installed: true });
    bridge.connectExtensionSession.mockResolvedValue({ ok: false, error: 'Token request failed' });
    render(<ExtensionConnectPage />);
    expect(await screen.findByText('Token request failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
