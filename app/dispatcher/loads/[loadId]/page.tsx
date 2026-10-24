import DispatcherLoadWorkspace from "@/components/dispatcher/DispatcherLoadWorkspace";
export const metadata = { title: "Load — TempMovers Dispatcher" };
export default function DispatcherLoadPage({ params }: { params: { loadId: string } }) {
  return <DispatcherLoadWorkspace loadId={params.loadId} />;
}
