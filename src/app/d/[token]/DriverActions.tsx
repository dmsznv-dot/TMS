"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { driverEventAction } from "@/app/actions/driver";

type Props = {
  token: string;
  type: "driver_confirmed" | "arrived" | "loaded" | "unloaded";
  stopId?: string;
  label: string;
  disabled?: boolean;
};

/** One big button that reports a single event. */
export function DriverButton({ token, type, stopId, label, disabled }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function send() {
    setError(null);
    startTransition(async () => {
      const result = await driverEventAction(token, type, stopId);
      if (!result.ok) return setError(result.message);
      router.refresh();
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={send}
        disabled={disabled || pending}
        className="w-full rounded-lg bg-blue-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-50"
      >
        {label}
      </button>
      {error && (
        <p role="alert" className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
