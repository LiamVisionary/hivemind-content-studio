export const metadata = {
  title: 'Media Studio',
  description: 'Next.js control surface for Media Studio and ComfyUI',
};

import './globals.css';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
