import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import ThemeInit from "./components/ThemeInit";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "NGPCX Dashboard",
  description: "ARM Readiness Dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${inter.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 transition-colors">
        {/* Ensures theme is applied BEFORE paint */}
        <ThemeInit />
        {children}
      </body>
    </html>
  );
}
