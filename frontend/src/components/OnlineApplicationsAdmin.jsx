import { useEffect, useState } from "react";

export function OnlineApplicationsAdmin({ staffAccessToken, staffRole, apiBase, onRefreshPipeline }) {
  const [rows, setRows] = useState([]);
  const [inbox, setInbox] = useState(0);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [receiptNo, setReceiptNo] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  async function load() {
    if (!staffAccessToken || !apiBase) return;
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (q.trim()) params.set("q", q.trim());
    const res = await fetch(`${apiBase}/pmes/admin/membership-applications?${params}`, {
      headers: { Authorization: `Bearer ${staffAccessToken}` },
    });
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json();
    setRows(json.applications || []);
    setInbox(Number(json.inbox?.paymentsToConfirm ?? 0));
  }

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  }, [staffAccessToken, status]);

  if (!staffAccessToken) return null;

  return (
    <section className="border-b border-slate-200 px-6 py-8 lg:px-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black uppercase tracking-tight text-slate-900">Online applications</h2>
          <p className="mt-1 text-sm font-medium text-slate-600">
            Public /register drafts and submitted files. Treasurer queue: payments to confirm.
          </p>
        </div>
        <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-black uppercase text-amber-900">
          Payments to confirm {inbox}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <input className="input-field" placeholder="Search name / email" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input-field" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {["DRAFT", "SUBMITTED", "PAYMENT_CONFIRMED", "BOD_APPROVED", "APPROVED", "REJECTED", "EXPIRED"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="button" className="rounded-xl border px-4 py-2 text-sm font-black" onClick={() => void load()}>
          Search
        </button>
        <button type="button" className="rounded-xl bg-amber-100 px-4 py-2 text-sm font-black text-amber-950" onClick={() => setStatus("SUBMITTED")}>
          Treasurer queue
        </button>
      </div>
      {error ? <p className="mt-3 text-sm font-bold text-red-700">{error}</p> : null}
      <ul className="mt-5 divide-y divide-slate-100 rounded-2xl border border-slate-200">
        {rows.map((row) => (
          <li key={row.id}>
            <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={() => setDetail(row)}>
              <span className="text-sm font-bold text-slate-900">{row.fullName || row.email}</span>
              <span className="text-xs font-black uppercase text-slate-500">{row.status}</span>
            </button>
          </li>
        ))}
        {rows.length === 0 ? <li className="px-4 py-6 text-sm font-medium text-slate-500">No applications.</li> : null}
      </ul>
      {detail ? (
        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm">
          <div className="flex justify-between gap-3">
            <h3 className="font-black text-slate-900">{detail.fullName || detail.email}</h3>
            <button type="button" onClick={() => setDetail(null)} className="text-xs font-black uppercase text-slate-500">
              Close
            </button>
          </div>
          <p className="mt-2">{detail.email} · {detail.mobile}</p>
          <p>Member ID: {detail.memberIdNo || "—"} · Status: {detail.status}</p>
          <p>Declared paid: share {detail.shareCapitalPaid ? "yes" : "no"} · fee {detail.membershipFeePaid ? "yes" : "no"}</p>
          <p>Mode: {detail.paymentMode || "—"} · GCash: {detail.gcashRefNo || "—"}</p>
          {detail.hasGcashScreenshot ? (
            <a
              className="mt-2 inline-block font-bold text-[#004aad]"
              href={`${apiBase}/pmes/admin/membership-applications/${detail.id}/screenshot`}
              target="_blank"
              rel="noreferrer"
            >
              View GCash screenshot
            </a>
          ) : null}
          {detail.possibleDuplicateOfId ? <p className="mt-2 font-bold text-amber-800">Possible duplicate of {detail.possibleDuplicateOfId}</p> : null}
          {["treasurer", "admin", "superuser"].includes(staffRole) ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <input className="input-field" placeholder="Receipt no." value={receiptNo} onChange={(e) => setReceiptNo(e.target.value)} />
              <button
                type="button"
                className="btn-primary"
                onClick={async () => {
                  const res = await fetch(`${apiBase}/pmes/admin/membership-applications/${detail.id}/confirm-payment`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${staffAccessToken}` },
                    body: JSON.stringify({ receiptNo }),
                  });
                  if (!res.ok) throw new Error(await res.text());
                  await load();
                  onRefreshPipeline?.();
                  setDetail(null);
                }}
              >
                Confirm payment
              </button>
            </div>
          ) : null}
          {["secretary", "superuser"].includes(staffRole) ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <input className="input-field" placeholder="Rejection reason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
              <button
                type="button"
                className="rounded-xl bg-red-100 px-4 py-2 text-sm font-black text-red-800"
                onClick={async () => {
                  const res = await fetch(`${apiBase}/pmes/admin/membership-applications/${detail.id}/reject`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${staffAccessToken}` },
                    body: JSON.stringify({ reason: rejectReason }),
                  });
                  if (!res.ok) throw new Error(await res.text());
                  await load();
                  setDetail(null);
                }}
              >
                Reject
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
