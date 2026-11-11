import { z } from "zod";
import { DomainError } from "@/domain/errors";

// Validation messages are shown to users, so they are produced in Russian.
z.config(z.locales.ru());

/** Parses input with a zod schema; a failure becomes a "validation" DomainError. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.join(".");
    throw new DomainError(
      "validation",
      path ? `${path}: ${first.message}` : first.message,
      result.error.issues,
    );
  }
  return result.data;
}
