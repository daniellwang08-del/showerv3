import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PlansPage } from './PlansPage';

const renderPage = () =>
  render(
    <MemoryRouter>
      <PlansPage />
    </MemoryRouter>,
  );

describe('PlansPage', () => {
  it('lists the four credit packages with their prices', () => {
    renderPage();
    const pro = screen.getByRole('article', { name: 'Pro package' });
    expect(within(pro).getByText('Most popular')).toBeInTheDocument();
    expect(within(pro).getByText('$80')).toBeInTheDocument();
    expect(within(pro).getByText('Save 20%')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Starter package' })).getByText('Base rate')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Scale package' })).getByText('$500')).toBeInTheDocument();
    expect(screen.getByText('50 credits')).toBeInTheDocument();
  });

  it('marks the package that fits the default pace', () => {
    renderPage();
    const starter = screen.getByRole('article', { name: 'Starter package' });
    expect(within(starter).getByText('Fits your pace')).toBeInTheDocument();
    expect(screen.getByText('Starter, 250 credits for $25')).toBeInTheDocument();
  });

  it('previews the order without charging', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Buy 1,000 credits' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Buy Pro credits')).toBeInTheDocument();
    expect(within(dialog).getByText('-$20')).toBeInTheDocument();
    expect(within(dialog).getByText('Checkout opens soon')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Continue to payment' })).toBeDisabled();
  });
});
