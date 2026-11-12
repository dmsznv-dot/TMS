import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Поставки и экономика рейсов",
  description: "Планирование рейсов, приёмка и сверка денег",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className="h-full antialiased">
      <body className="min-h-full font-sans text-sm">{children}</body>
    </html>
  );
}
