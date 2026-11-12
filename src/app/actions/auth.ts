"use server";

import { redirect } from "next/navigation";
import { DomainError } from "@/domain/errors";
import { clearSessionCookie, setSessionCookie } from "@/server/auth/requireCtx";
import { login, logout } from "@/server/auth/session";
import { getDb } from "@/server/db/client";

export type LoginState = { error: string | null };

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  let session;
  try {
    session = await login(getDb(), email, password);
  } catch (e) {
    if (e instanceof DomainError) return { error: e.message };
    throw e;
  }
  if (!session) return { error: "Неверная почта или пароль" };
  await setSessionCookie(session.token, session.expiresAt);
  redirect("/planning");
}

export async function logoutAction(): Promise<void> {
  const token = await clearSessionCookie();
  if (token) await logout(getDb(), token);
  redirect("/login");
}
