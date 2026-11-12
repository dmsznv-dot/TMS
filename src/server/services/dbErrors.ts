/** True when the error is a PostgreSQL unique-constraint violation. */
export function isUniqueViolation(e: unknown): boolean {
  const direct = (e as { code?: string } | null)?.code;
  const nested = (e as { cause?: { code?: string } } | null)?.cause?.code;
  return direct === "23505" || nested === "23505";
}
