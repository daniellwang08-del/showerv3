import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JobLocationLabel } from './JobLocationLabel';

describe('JobLocationLabel', () => {
  it('renders one flag per country in the flag font', () => {
    const { container, getByText } = render(
      <JobLocationLabel location="Canada; Toronto, Canada; United States" countries={['CA', 'US']} />,
    );
    const flags = container.querySelector('.country-flag');
    expect(flags).not.toBeNull();
    expect([...flags!.children].map((c) => c.textContent)).toEqual(['\u{1F1E8}\u{1F1E6}', '\u{1F1FA}\u{1F1F8}']);
    expect(getByText('Canada; Toronto, Canada; United States')).toBeInTheDocument();
  });

  it('shows no flag span when no country is known', () => {
    const { container } = render(<JobLocationLabel location="Multiple Locations" />);
    expect(container.querySelector('.country-flag')).toBeNull();
  });
});
