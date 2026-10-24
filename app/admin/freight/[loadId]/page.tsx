import FreightLoadDetail from "@/components/freight/FreightLoadDetail";
export const metadata = { title: "Load Detail — TempMovers Admin" };
export default function FreightLoadDetailPage({ params }: { params: { loadId: string } }) {
  return <FreightLoadDetail loadId={params.loadId} />;
}
