import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiClient } from '../../api/client';
import { JobFilenameEditor } from './JobFilenameEditor';

vi.mock('../../api/client', () => ({ apiClient: { put: vi.fn() } }));

const put = vi.mocked(apiClient.put);
const NAMES = { resume: 'Jane_Doe_resume', cover_letter: 'Jane_Doe_cover_letter' };

beforeEach(() => vi.clearAllMocks());

describe('JobFilenameEditor', () => {
  it('renames one job with a field and reports the new names', async () => {
    put.mockResolvedValue({
      data: { filename_override: 'Jane_{company}', file_names: { resume: 'Jane_Acme', cover_letter: 'Jane_Acme_cover_letter' } },
    });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<JobFilenameEditor validJobId="job-1" override={null} names={NAMES} coverOnly={false} onSaved={onSaved} />);
    expect(screen.getByTestId('job-file-names')).toHaveTextContent('Jane_Doe_resume, Jane_Doe_cover_letter');
    expect(screen.getByText('(your file name rule)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await user.type(screen.getByLabelText('File name for this job'), 'Jane');
    await user.click(screen.getByRole('button', { name: '{company}' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/jobs/valid/job-1/resume-build/filename', { filename: 'Jane_{company}' }),
    );
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ filename_override: 'Jane_{company}' }));
    expect(screen.queryByLabelText('File name for this job')).not.toBeInTheDocument();
  });

  it('goes back to the account rule and shows server errors', async () => {
    put.mockRejectedValueOnce({ response: { data: { detail: 'Unknown field {x}.' } } });
    put.mockResolvedValueOnce({ data: { filename_override: null, file_names: NAMES } });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(
      <JobFilenameEditor validJobId="job-2" override="Acme_cv" names={{ resume: 'Acme_cv', cover_letter: 'Acme_cv_cover_letter' }} coverOnly onSaved={onSaved} />,
    );
    expect(screen.getByTestId('job-file-names')).toHaveTextContent(/^Acme_cv_cover_letter$/);
    expect(screen.getByText('(named for this job)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(screen.getByLabelText('File name for this job')).toHaveValue('Acme_cv');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Unknown field {x}.')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Use my file name rule' }));
    await waitFor(() => expect(put).toHaveBeenLastCalledWith('/jobs/valid/job-2/resume-build/filename', { filename: null }));
    expect(onSaved).toHaveBeenCalledWith({ filename_override: null, file_names: NAMES });
  });
});
