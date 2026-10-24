// Single source of truth for market-specific homepage content — the city
// name, badge copy, and backdrop image path must never be scattered
// across multiple components. Adding a new city means adding an entry
// here (plus its approved backdrop asset), not editing TempMoversHero.tsx.
export type MarketKey = "indianapolis" | "chicago" | "national";

export type MarketConfig = {
  key: MarketKey;
  cityName?: string;
  badgeLabel: string;
  launchEyebrow: string;
  heroBackdrop: string;
  heroBackdropMobile?: string;
  heroBackdropAlt: string;
  isActive: boolean;
};

export const MARKET_CONFIG: Record<MarketKey, MarketConfig> = {
  indianapolis: {
    key: "indianapolis",
    cityName: "Indianapolis",
    badgeLabel: "Indianapolis' Trusted Platform",
    launchEyebrow: "Launching in Indianapolis",
    heroBackdrop: "/images/markets/indianapolis/hero-skyline.webp",
    heroBackdropAlt: "Downtown Indianapolis skyline behind TempMovers platform services",
    isActive: true,
  },

  chicago: {
    key: "chicago",
    cityName: "Chicago",
    badgeLabel: "Chicago's Trusted Platform",
    launchEyebrow: "Coming soon to Chicago",
    heroBackdrop: "/images/markets/chicago/hero-skyline.webp",
    heroBackdropAlt: "Downtown Chicago skyline behind TempMovers platform services",
    isActive: false,
  },

  national: {
    key: "national",
    badgeLabel: "The Platform That Moves Work",
    launchEyebrow: "The marketplace for moving, transportation & freight",
    heroBackdrop: "/images/markets/national/hero-network.webp",
    heroBackdropAlt: "TempMovers labor and transportation marketplace network",
    isActive: false,
  },
};
