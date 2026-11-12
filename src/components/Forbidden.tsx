import { Card } from "./ui";

export function Forbidden() {
  return (
    <Card className="p-6">
      <h1 className="mb-1 text-lg font-semibold">Недостаточно прав</h1>
      <p className="text-gray-600">Этот раздел недоступен для вашей роли.</p>
    </Card>
  );
}
