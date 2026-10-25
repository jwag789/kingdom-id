import type { ReactNode } from "react";
import { KINGDOM_ISSUER } from "@/auth";
import "./globals.css";

export const metadata = { title: "Cappuccino", description: "A sample app that signs in with Kingdom ID." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* The official Sign in with Kingdom button, served by Kingdom ID. */}
        <link rel="stylesheet" href={`${KINGDOM_ISSUER}/brand/button.css`} />
      </head>
      <body>{children}</body>
    </html>
  );
}
