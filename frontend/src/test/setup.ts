import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { useUIStore } from '../stores/uiStore';

// The default 1s findBy/waitFor budget is too tight when the whole suite runs in parallel.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  useUIStore.setState({ notifications: [] });
});
