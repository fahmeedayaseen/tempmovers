/**
 * Initial market seed (launch spec §3). Indianapolis is the ONLY fully
 * operating customer market; Midwest cities are recruitment / coming-soon.
 * "Optional" worker recruitment in the spec is seeded OFF (management can turn
 * it on per market without a deploy).
 *
 * freightBrokerageEnabled is false for EVERY market — brokerage stays inert
 * platform-wide until authority is confirmed, and even flipping this per
 * market cannot bypass the global compliance flags.
 */
import type { MarketStage } from "@prisma/client";

export type MarketSeed = {
  marketCode: string;
  name: string;
  state: string;
  stage: MarketStage;
  customerBookingEnabled: boolean;
  moverRecruitmentEnabled: boolean;
  driverRecruitmentEnabled: boolean;
  carrierRecruitmentEnabled: boolean;
  dispatchSupportEnabled: boolean;
  freightBrokerageEnabled: boolean;
};

export const INITIAL_MARKETS: MarketSeed[] = [
  { marketCode: "INDY", name: "Indianapolis", state: "IN", stage: "ACTIVE",
    customerBookingEnabled: true, moverRecruitmentEnabled: true, driverRecruitmentEnabled: true, carrierRecruitmentEnabled: true, dispatchSupportEnabled: false, freightBrokerageEnabled: false },
  { marketCode: "LOU", name: "Louisville", state: "KY", stage: "CARRIER_RECRUITMENT",
    customerBookingEnabled: false, moverRecruitmentEnabled: false, driverRecruitmentEnabled: false, carrierRecruitmentEnabled: true, dispatchSupportEnabled: false, freightBrokerageEnabled: false },
  { marketCode: "CIN", name: "Cincinnati", state: "OH", stage: "CARRIER_RECRUITMENT",
    customerBookingEnabled: false, moverRecruitmentEnabled: false, driverRecruitmentEnabled: false, carrierRecruitmentEnabled: true, dispatchSupportEnabled: false, freightBrokerageEnabled: false },
  { marketCode: "COL", name: "Columbus", state: "OH", stage: "COMING_SOON",
    customerBookingEnabled: false, moverRecruitmentEnabled: false, driverRecruitmentEnabled: false, carrierRecruitmentEnabled: true, dispatchSupportEnabled: false, freightBrokerageEnabled: false },
  { marketCode: "FTW", name: "Fort Wayne", state: "IN", stage: "COMING_SOON",
    customerBookingEnabled: false, moverRecruitmentEnabled: true, driverRecruitmentEnabled: true, carrierRecruitmentEnabled: true, dispatchSupportEnabled: false, freightBrokerageEnabled: false },
  { marketCode: "CHI", name: "Chicago", state: "IL", stage: "CARRIER_RECRUITMENT",
    customerBookingEnabled: false, moverRecruitmentEnabled: false, driverRecruitmentEnabled: false, carrierRecruitmentEnabled: true, dispatchSupportEnabled: false, freightBrokerageEnabled: false },
  { marketCode: "DAY", name: "Dayton", state: "OH", stage: "COMING_SOON",
    customerBookingEnabled: false, moverRecruitmentEnabled: false, driverRecruitmentEnabled: false, carrierRecruitmentEnabled: true, dispatchSupportEnabled: false, freightBrokerageEnabled: false },
  { marketCode: "LEX", name: "Lexington", state: "KY", stage: "COMING_SOON",
    customerBookingEnabled: false, moverRecruitmentEnabled: false, driverRecruitmentEnabled: false, carrierRecruitmentEnabled: true, dispatchSupportEnabled: false, freightBrokerageEnabled: false },
  { marketCode: "STL", name: "St. Louis", state: "MO", stage: "PLANNING",
    customerBookingEnabled: false, moverRecruitmentEnabled: false, driverRecruitmentEnabled: false, carrierRecruitmentEnabled: false, dispatchSupportEnabled: false, freightBrokerageEnabled: false },
];
