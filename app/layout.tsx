import "./globals.css";

export const metadata = {
  title: "NGPCX",
  description: "Next‑Gen PC Compatibility Explorer",
  icons: {
    icon: "/favicon.svg"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
