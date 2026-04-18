jest.mock('wavesurfer.js', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      load: jest.fn(),
      on: jest.fn(),
      destroy: jest.fn(),
      playPause: jest.fn(),
    })),
  },
}));

jest.mock('wavesurfer.js/dist/plugins/regions.js', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      addRegion: jest.fn(),
    })),
  },
}));

import { render, screen } from '@testing-library/react';
import App from './App';

test('renders audio processor dashboard', () => {
  render(<App />);
  expect(screen.getByText(/AI Audio Processor/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Run 20 random tasks/i })).toBeInTheDocument();
});
