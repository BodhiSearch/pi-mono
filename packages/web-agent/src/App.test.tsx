import { render } from '@testing-library/react';
import { describe, test } from 'vitest';
import App from './App';

describe('App', () => {
  // Smoke-only: WebAgentProvider hydrates from IDB asynchronously
  // before booting the Worker, so the first render returns `null`.
  // We verify the component tree mounts without throwing; any
  // downstream assertion on rendered markup belongs in e2e where
  // the real browser SDKs are available.
  test('renders without crashing', () => {
    render(<App />);
  });
});
