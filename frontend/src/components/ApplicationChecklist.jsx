import { useEffect, useState } from "react";

/**
 * Pending-member checklist: Payment confirmed, PMES, TIN.
 * Draft continue links cannot use Firebase email templates (no account yet),
 * so the link is shown on-screen at start and again here when this browser saved it.
 */
export function ApplicationChecklist({ lifecycle }) {
  const payment = Boolean(lifecycle?.initialFeesPaid);
  const pmes = Boolean(lifecycle?.pmEsPassed);
  const tinOk = lifecycle?.needsTin !== true;
  const [continueHref, setContinueHref] = useState(null);
  useEffect(() => {
    try {
      setContinueHref(sessionStorage.getItem("b2c_membership_continue"));
    } catch {
      setContinueHref(null);
    }
  }, []);
  const items = [
    { key: "pay", label: "Payment confirmed", done: payment },
    { key: "pmes", label: "PMES", done: pmes },
    { key: "tin", label: "TIN", done: tinOk },
  ];
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Application status</p>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item.key} className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <span aria-hidden>{item.done ? "☑" : "☐"}</span>
            {item.label}
            {item.key === "tin" && !item.done ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-black uppercase text-amber-900">
                TIN missing
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs font-medium text-slate-600">
        After submit, Firebase Auth emails a password-reset link so you can set a login. Approval and payment status stay
        in this portal — they are not emailed.
      </p>
      {continueHref ? (
        <p className="mt-3 text-xs font-semibold text-slate-700">
          Continue an unfinished draft:{" "}
          <a className="break-all font-bold text-[#004aad]" href={continueHref}>
            {continueHref}
          </a>
        </p>
      ) : null}
    </section>
  );
}
