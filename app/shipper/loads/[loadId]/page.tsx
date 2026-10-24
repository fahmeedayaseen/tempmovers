import ShipperLoadTracking from "@/components/shipper/ShipperLoadTracking";
export const metadata = { title: "Track Shipment — TempMovers" };
export default function ShipperLoadPage({ params }: { params: { loadId: string } }) {
  return <ShipperLoadTracking loadId={params.loadId} />;
}
