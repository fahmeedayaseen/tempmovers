import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "TempMovers | Moving Labor, Box Trucks & Freight Marketplace",
  description:
    "Book moving help, post local delivery and freight work, and connect with movers, box trucks, drivers, and carriers through TempMovers. Launching in Indianapolis.",
  openGraph: {
    title: "TempMovers | Moving Labor, Box Trucks & Freight Marketplace",
    description:
      "Book moving help, post local delivery and freight work, and connect with movers, box trucks, drivers, and carriers through TempMovers. Launching in Indianapolis.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
