import CarrierReviewDetail from "@/components/admin/CarrierReviewDetail";
export const metadata = { title: "Carrier Detail — TempMovers Admin" };
export default function CarrierDetailPage({ params }: { params: { carrierId: string } }) {
  return <CarrierReviewDetail carrierId={params.carrierId} />;
}
