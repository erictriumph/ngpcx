import Head from "next/head";

export const metadata = {
  title: "NGPCX",
  description: "Know before you buy.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <Head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </Head>
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
