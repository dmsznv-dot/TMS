"use server";

import { redirect } from "next/navigation";
import { clearSessionCookie, setSessionCookie } from "@/server/auth/requireCtx";
import { login, logout } from "@/server/auth/session";
import { getDb } from "@/server/db/client";

export type LoginState = { error: string | null };

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const session = await login(getDb(), email, password);
  if (!session) return { error: "Неверная почта или пароль" };
  await setSessionCookie(session.token, session.expiresAt);
  redirect("/planning");
}

export async function logoutAction(): Promise<void> {
  const token = await clearSessionCookie();
  if (token) await logout(getDb(), token);
  redirect("/login");
}
