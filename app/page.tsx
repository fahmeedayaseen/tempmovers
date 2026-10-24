import AuthGate from "@/components/AuthGate";
import DashboardApp from "@/components/DashboardApp";

export default function Page() {
  return (
    <AuthGate>
      {(user, service) => <DashboardApp initialRole={user.role} initialService={service} />}
    </AuthGate>
  );
}
