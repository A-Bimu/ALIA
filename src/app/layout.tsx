import type { ReactNode } from 'react';

import './globals.css';

export const metadata = {
  title: 'ALIA',
  description:
    'Adaptive Learning Intelligence Agent: an independent adaptive-intelligence API for learning platforms.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
