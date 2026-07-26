export const metadata = {
  title: 'Media gateway',
  description: 'ComfyUI proxy, media API and mobile workbench for Hivemind Content Studio',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
