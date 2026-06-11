export const metadata = {
  title: "NGPCX",
  description: "Know before you buy.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
