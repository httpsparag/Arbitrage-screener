import type { MetadataRoute } from "next";

// Lets the screener be added to the phone's home screen and open full-screen.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Arb Screener",
    short_name: "Arb Screener",
    description: "NSE cash–futures arbitrage screener",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0f14",
    theme_color: "#0b0f14",
    icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }],
  };
}
