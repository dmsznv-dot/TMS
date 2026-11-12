"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "@/app/actions/auth";
import { buttonClass, ErrorText, inputClass } from "@/components/ui";

const INITIAL: LoginState = { error: null };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, INITIAL);
  return (
    <form action={formAction} className="space-y-4">
      <label className="block">
        <span className="mb-1 block font-medium">Почта</span>
        <input name="email" type="email" autoComplete="username" required className={inputClass} />
      </label>
      <label className="block">
        <span className="mb-1 block font-medium">Пароль</span>
        <input name="password" type="password" autoComplete="current-password" required className={inputClass} />
      </label>
      <ErrorText>{state.error}</ErrorText>
      <button type="submit" disabled={pending} className={`${buttonClass()} w-full`}>
        Войти
      </button>
    </form>
  );
}
