"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createApplication,
  flushOfflineQueue,
  enqueueOfflinePatch,
  loadApplication,
  lookupReferrer,
  patchApplication,
  readResume,
  resumeByToken,
  submitApplication,
  uploadScreenshot,
  type RegisterApplication,
} from "./registerApi";

const STEPS = ["Personal", "Contact", "Referral", "Payments", "Review"] as const;

type Props = {
  initialPath?: string;
  onExitToHome?: () => void;
};

export function RegisterApp({ initialPath, onExitToHome }: Props) {
  const path = initialPath || (typeof window !== "undefined" ? window.location.pathname : "/register");
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "offline">("idle");
  const [error, setError] = useState<string | null>(null);
  const [app, setApp] = useState<RegisterApplication | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [referrerHits, setReferrerHits] = useState<{ memberIdNo: string; displayName: string; participantId: string }[]>([]);
  const [form, setForm] = useState({
    email: "",
    mobile: "",
    dpaConsent: false,
    firstName: "",
    middleName: "",
    lastName: "",
    dob: "",
    gender: "",
    tinNo: "",
    street: "",
    barangay: "",
    cityMunicipality: "",
    province: "",
    zip: "",
    referralQuery: "",
    referredByParticipantId: "",
    shareCapitalAmount: "1000",
    shareCapitalPaid: false,
    membershipFeePaid: false,
    paymentMode: "" as "" | "CASH" | "GCASH",
    gcashRefNo: "",
  });

  const isDone = path.includes("/register/done") || Boolean(memberId);
  const isSetPassword = path.includes("/set-password");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref")?.trim();
    if (ref) setForm((f) => ({ ...f, referralQuery: ref }));
    const t = params.get("t")?.trim();
    if (t) {
      void resumeByToken(t)
        .then((row) => {
          applyRow(row, row.resumeToken || t);
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Could not resume"));
      return;
    }
    const stored = readResume();
    if (stored.id && stored.token) {
      void loadApplication(stored.id, stored.token)
        .then((row) => applyRow(row, stored.token!))
        .catch(() => undefined);
    }
  }, []);

  function applyRow(row: RegisterApplication, resume: string) {
    setApp(row);
    setToken(resume);
    const addr = row.residentialAddress || {};
    setForm((f) => ({
      ...f,
      email: row.email || f.email,
      mobile: row.mobile || f.mobile,
      firstName: row.firstName || f.firstName,
      middleName: row.middleName || f.middleName,
      lastName: row.lastName || f.lastName,
      dob: row.dob || f.dob,
      gender: row.gender || f.gender,
      tinNo: row.tinNo || f.tinNo,
      street: addr.street || f.street,
      barangay: addr.barangay || f.barangay,
      cityMunicipality: addr.cityMunicipality || f.cityMunicipality,
      province: addr.province || f.province,
      zip: addr.zip || f.zip,
      referredByParticipantId: row.referredByParticipantId || f.referredByParticipantId,
      shareCapitalAmount: String(row.shareCapitalAmount || 1000),
      shareCapitalPaid: row.shareCapitalPaid,
      membershipFeePaid: row.membershipFeePaid,
      paymentMode: row.paymentMode || "",
      gcashRefNo: row.gcashRefNo || "",
      dpaConsent: Boolean(row.dpaConsentAt),
    }));
  }

  async function persist(fields: Record<string, unknown>) {
    if (!app || !token) return;
    setSaved("saving");
    try {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        enqueueOfflinePatch(app.id, fields);
        setSaved("offline");
        return;
      }
      await flushOfflineQueue(app.id, token);
      const out = await patchApplication(app.id, token, fields);
      setApp(out.application);
      setSaved("saved");
    } catch {
      enqueueOfflinePatch(app.id, fields);
      setSaved("offline");
    }
  }

  const persistRef = useRef(persist);
  persistRef.current = persist;
  const debouncedPersist = useMemo(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    return (fields: Record<string, unknown>) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => void persistRef.current(fields), 800);
    };
  }, []);

  function setField<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (!app) return;
    const map: Record<string, unknown> = {};
    if (["firstName", "middleName", "lastName", "dob", "gender", "mobile", "tinNo"].includes(key)) {
      map[key] = value;
    } else if (["street", "barangay", "cityMunicipality", "province", "zip"].includes(key)) {
      map.residentialAddress = {
        street: key === "street" ? value : form.street,
        barangay: key === "barangay" ? value : form.barangay,
        cityMunicipality: key === "cityMunicipality" ? value : form.cityMunicipality,
        province: key === "province" ? value : form.province,
        zip: key === "zip" ? value : form.zip,
      };
    } else if (key === "shareCapitalAmount") map.shareCapitalAmount = Number(value);
    else if (key === "shareCapitalPaid") map.shareCapitalPaid = value;
    else if (key === "membershipFeePaid") map.membershipFeePaid = value;
    else if (key === "paymentMode") map.paymentMode = value || null;
    else if (key === "gcashRefNo") map.gcashRefNo = value;
    if (Object.keys(map).length) debouncedPersist(map);
  }

  async function startDraft(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const row = await createApplication({
        email: form.email,
        mobile: form.mobile,
        dpaConsent: form.dpaConsent,
        referralCode: form.referralQuery || undefined,
      });
      applyRow(row, row.resumeToken || readResume(row.id).token || "");
      setStep(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start application");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit() {
    if (!app || !token) return;
    setError(null);
    setBusy(true);
    try {
      await persist({
        firstName: form.firstName,
        middleName: form.middleName,
        lastName: form.lastName,
        fullName: [form.firstName, form.middleName, form.lastName].filter(Boolean).join(" "),
        dob: form.dob,
        gender: form.gender,
        mobile: form.mobile,
        tinNo: form.tinNo,
        residentialAddress: {
          street: form.street,
          barangay: form.barangay,
          cityMunicipality: form.cityMunicipality,
          province: form.province,
          zip: form.zip,
        },
        referredByParticipantId: form.referredByParticipantId || null,
        shareCapitalAmount: Number(form.shareCapitalAmount),
        shareCapitalPaid: form.shareCapitalPaid,
        membershipFeePaid: form.membershipFeePaid,
        paymentMode: form.paymentMode || null,
        gcashRefNo: form.gcashRefNo,
      });
      const out = await submitApplication(app.id, token);
      setMemberId(out.memberIdNo);
      if (typeof window !== "undefined") {
        window.history.replaceState({}, "", "/register/done");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  if (isSetPassword) {
    return (
      <Shell onHome={onExitToHome}>
        <h1 className="text-2xl font-black text-slate-900">Set your password</h1>
        <p className="mt-3 text-sm font-medium text-slate-600">
          Open the set-password link from your B2C email (<strong>b2ccoop@gmail.com</strong>). After you set a password,
          sign in with your email or member ID.
        </p>
      </Shell>
    );
  }

  if (isDone && memberId) {
    return (
      <Shell onHome={onExitToHome}>
        <p className="text-xs font-black uppercase tracking-widest text-emerald-700">Application received</p>
        <h1 className="mt-2 text-2xl font-black text-slate-900">Check your email to set a password</h1>
        <p className="mt-4 text-sm font-medium text-slate-600">
          Your login ID (member ID) is <strong>{memberId}</strong>. A set-password link was sent from b2ccoop@gmail.com.
          Payment stays self-declared until the Treasurer confirms it. You can complete PMES any time after you sign in.
        </p>
        <span className="mt-4 inline-flex rounded-full bg-amber-100 px-3 py-1 text-xs font-black uppercase text-amber-900">
          Pending
        </span>
      </Shell>
    );
  }

  if (!app) {
    return (
      <Shell onHome={onExitToHome}>
        <h1 className="text-2xl font-black text-slate-900">Apply for membership</h1>
        <p className="mt-2 text-sm font-medium text-slate-600">
          Start with your email and mobile. Your draft auto-saves for 60 days.
        </p>
        <form onSubmit={startDraft} className="mt-6 space-y-4">
          <label className="block text-sm font-bold text-slate-700">
            Email
            <input
              required
              type="email"
              className="input-field mt-1 w-full"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            />
          </label>
          <label className="block text-sm font-bold text-slate-700">
            Mobile
            <input
              required
              inputMode="tel"
              className="input-field mt-1 w-full"
              placeholder="09XXXXXXXXX"
              value={form.mobile}
              onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))}
            />
          </label>
          <label className="flex items-start gap-3 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              className="mt-1"
              checked={form.dpaConsent}
              onChange={(e) => setForm((f) => ({ ...f, dpaConsent: e.target.checked }))}
              required
            />
            <span>
              I consent to the processing of my personal data under the Data Privacy Act (RA 10173) for membership
              registration.
            </span>
          </label>
          {error ? <p className="text-sm font-bold text-red-700">{error}</p> : null}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? "Starting…" : "Continue"}
          </button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell onHome={onExitToHome} saved={saved}>
      <ol className="mb-6 flex flex-wrap gap-2 text-[11px] font-black uppercase tracking-wide">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={`rounded-full px-3 py-1 ${i === step ? "bg-[#004aad] text-white" : "bg-slate-100 text-slate-600"}`}
          >
            {label}
          </li>
        ))}
      </ol>
      {step === 0 ? (
        <div className="space-y-3">
          <Field label="First name" value={form.firstName} onChange={(v) => setField("firstName", v)} />
          <Field label="Middle name" value={form.middleName} onChange={(v) => setField("middleName", v)} />
          <Field label="Last name" value={form.lastName} onChange={(v) => setField("lastName", v)} />
          <Field label="Date of birth" type="date" value={form.dob} onChange={(v) => setField("dob", v)} />
          <label className="block text-sm font-bold text-slate-700">
            Gender
            <select className="input-field mt-1 w-full" value={form.gender} onChange={(e) => setField("gender", e.target.value)}>
              <option value="">Select</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other / prefer not to say</option>
            </select>
          </label>
        </div>
      ) : null}
      {step === 1 ? (
        <div className="space-y-3">
          <Field label="Mobile" value={form.mobile} onChange={(v) => setField("mobile", v)} />
          <Field label="TIN (optional)" value={form.tinNo} onChange={(v) => setField("tinNo", v)} />
          <Field label="Street" value={form.street} onChange={(v) => setField("street", v)} />
          <Field label="Barangay" value={form.barangay} onChange={(v) => setField("barangay", v)} />
          <Field label="City / municipality" value={form.cityMunicipality} onChange={(v) => setField("cityMunicipality", v)} />
          <Field label="Province" value={form.province} onChange={(v) => setField("province", v)} />
          <Field label="ZIP" value={form.zip} onChange={(v) => setField("zip", v)} />
        </div>
      ) : null}
      {step === 2 ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-slate-600">
            Referred by must be an approved member. Leave blank if you do not have a referrer.
          </p>
          <Field
            label="Referral code, member ID, callsign, or name"
            value={form.referralQuery}
            onChange={(v) => {
              setForm((f) => ({ ...f, referralQuery: v }));
              if (v.trim().length >= 2) {
                void lookupReferrer(v)
                  .then((r) => setReferrerHits(r.results || []))
                  .catch(() => setReferrerHits([]));
              }
            }}
          />
          <ul className="space-y-2">
            {referrerHits.map((hit) => (
              <li key={hit.participantId}>
                <button
                  type="button"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-left text-sm font-semibold"
                  onClick={() => {
                    setForm((f) => ({ ...f, referredByParticipantId: hit.participantId, referralQuery: hit.memberIdNo }));
                    void persist({ referredByParticipantId: hit.participantId });
                  }}
                >
                  {hit.displayName} · {hit.memberIdNo}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {step === 3 ? (
        <div className="space-y-3">
          <Field label="Initial share capital (₱)" value={form.shareCapitalAmount} onChange={(v) => setField("shareCapitalAmount", v)} />
          <label className="flex gap-2 text-sm font-semibold">
            <input type="checkbox" checked={form.shareCapitalPaid} onChange={(e) => setField("shareCapitalPaid", e.target.checked)} />
            I have paid the share capital
          </label>
          <label className="flex gap-2 text-sm font-semibold">
            <input type="checkbox" checked={form.membershipFeePaid} onChange={(e) => setField("membershipFeePaid", e.target.checked)} />
            I have paid the ₱500 membership fee
          </label>
          <label className="block text-sm font-bold">
            Mode of payment
            <select className="input-field mt-1 w-full" value={form.paymentMode} onChange={(e) => setField("paymentMode", e.target.value as "CASH" | "GCASH" | "")}>
              <option value="">Select</option>
              <option value="CASH">Cash</option>
              <option value="GCASH">GCash</option>
            </select>
          </label>
          {form.paymentMode === "GCASH" ? (
            <>
              <Field label="GCash reference (13 digits)" value={form.gcashRefNo} onChange={(v) => setField("gcashRefNo", v)} />
              <label className="block text-sm font-bold">
                GCash screenshot (optional)
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="mt-1 block w-full text-sm"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file && app && token) void uploadScreenshot(app.id, token, file);
                  }}
                />
              </label>
            </>
          ) : null}
          <p className="text-xs font-medium text-slate-500">You may submit before paying. Treasurer confirms later.</p>
        </div>
      ) : null}
      {step === 4 ? (
        <div className="space-y-2 text-sm font-medium text-slate-700">
          <p>
            {form.firstName} {form.middleName} {form.lastName}
          </p>
          <p>DOB: {form.dob} · {form.gender}</p>
          <p>{form.email} · {form.mobile}</p>
          <p>
            {form.street}, {form.barangay}, {form.cityMunicipality}, {form.province} {form.zip}
          </p>
          <p>Share capital ₱{form.shareCapitalAmount} · declared paid: {form.shareCapitalPaid ? "yes" : "no"}</p>
          <p>Membership fee declared paid: {form.membershipFeePaid ? "yes" : "no"}</p>
        </div>
      ) : null}
      {error ? <p className="mt-4 text-sm font-bold text-red-700">{error}</p> : null}
      <div className="mt-6 flex gap-3">
        {step > 0 ? (
          <button type="button" className="rounded-xl border px-4 py-3 text-sm font-black" onClick={() => setStep((s) => s - 1)}>
            Back
          </button>
        ) : null}
        {step < 4 ? (
          <button type="button" className="btn-primary flex-1" onClick={() => setStep((s) => s + 1)}>
            Next
          </button>
        ) : (
          <button type="button" className="btn-primary flex-1" disabled={busy} onClick={() => void onSubmit()}>
            {busy ? "Submitting…" : "Submit application"}
          </button>
        )}
      </div>
    </Shell>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block text-sm font-bold text-slate-700">
      {label}
      <input className="input-field mt-1 w-full" type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function Shell({
  children,
  onHome,
  saved = "idle",
}: {
  children: React.ReactNode;
  onHome?: () => void;
  saved?: "idle" | "saving" | "saved" | "offline";
}) {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 text-slate-900">
      <style>{`
        .input-field{border:1px solid #e2e8f0;border-radius:0.9rem;padding:0.85rem 1rem;font-size:1rem}
        .btn-primary{background:#004aad;color:#fff;border-radius:0.9rem;padding:0.85rem 1rem;font-weight:800}
      `}</style>
      <div className="mx-auto w-full max-w-lg rounded-3xl bg-white p-6 shadow-sm sm:p-8">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-xs font-black uppercase tracking-widest text-[#004aad]">B2C membership</p>
          <span className="text-xs font-bold text-slate-500">
            {saved === "saving" ? "Saving…" : saved === "saved" ? "Saved ✓" : saved === "offline" ? "Offline — will sync" : ""}
          </span>
        </div>
        {children}
        <button
          type="button"
          className="mt-8 text-sm font-bold text-[#004aad]"
          onClick={() => {
            if (onHome) onHome();
            else if (typeof window !== "undefined") window.location.assign("/");
          }}
        >
          Back to home
        </button>
      </div>
    </main>
  );
}
