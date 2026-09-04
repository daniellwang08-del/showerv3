import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { useUIStore } from '../stores/uiStore';

afterEach(() => {
  cleanup();
  useUIStore.setState({ notifications: [] });
});
