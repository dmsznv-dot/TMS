import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { getCtx } from "@/server/auth/requireCtx";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  if (await getCtx()) redirect("/planning");
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-1 text-lg font-semibold">Поставки и экономика рейсов</h1>
        <p className="mb-5 text-gray-500">Войдите, чтобы продолжить</p>
        <LoginForm />
      </Card>
    </main>
  );
}
