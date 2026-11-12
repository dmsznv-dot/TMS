import { expect } from "vitest";
import { DomainError } from "@/domain/errors";

/** Asserts that the promise rejects with a DomainError carrying the code. */
export async function expectCode(p: Promise<unknown>, code: string): Promise<DomainError> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `expected DomainError "${code}"`).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  return error as DomainError;
}
