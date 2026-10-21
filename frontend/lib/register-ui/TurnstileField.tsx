"use client";

import { useEffect, useId, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; "expired-callback"?: () => void }) => string;
      reset: (id?: string) => void;
    };
  }
}

export function turnstileSiteKey(): string {
  if (typeof import.meta !== "undefined") {
    const vite = (import.meta as { env?: { VITE_TURNSTILE_SITE_KEY?: string; NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string } }).env;
    return String(vite?.VITE_TURNSTILE_SITE_KEY || vite?.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "").trim();
  }
  return String(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? process.env.VITE_TURNSTILE_SITE_KEY ?? "").trim();
}

export function TurnstileField({ onToken }: { onToken: (token: string) => void }) {
  const hostId = useId().replace(/:/g, "");
  const widget = useRef<string | null>(null);
  const siteKey = turnstileSiteKey();

  useEffect(() => {
    if (!siteKey || typeof document === "undefined") return;
    const existing = document.querySelector('script[src="https://challenges.cloudflare.com/turnstile/v0/api.js"]');
    const start = () => {
      const el = document.getElementById(`cf-turnstile-${hostId}`);
      if (!el || !window.turnstile || widget.current) return;
      widget.current = window.turnstile.render(el, {
        sitekey: siteKey,
        callback: onToken,
        "expired-callback": () => onToken(""),
      });
    };
    if (existing) {
      start();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = start;
    document.head.appendChild(script);
  }, [hostId, onToken, siteKey]);

  return (
    <div data-testid="turnstile-widget" className="min-h-[65px]">
      {siteKey ? <div id={`cf-turnstile-${hostId}`} /> : <p className="text-xs font-semibold text-amber-800">Captcha is not configured.</p>}
    </div>
  );
}
