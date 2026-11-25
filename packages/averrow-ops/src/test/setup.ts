import '@testing-library/jest-dom';
import { afterEach } from 'vitest';

// Per-test isolation for drafts and other sessionStorage state.
afterEach(() => { try { window.sessionStorage.clear(); } catch { /* unavailable */ } });
