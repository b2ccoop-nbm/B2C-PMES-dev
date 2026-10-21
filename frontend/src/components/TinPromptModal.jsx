import { useState } from "react";

/**
 * Blocking-dismissible TIN prompt shown on every sign-in until TIN is saved (D7).
 */
export function TinPromptModal({ open, onSave, onDismiss }) {
  const [tin, setTin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-900/50 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="tin-prompt-title">
      <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-xl">
        <h2 id="tin-prompt-title" className="text-xl font-black text-slate-900">
          Add your TIN
        </h2>
        <p className="mt-2 text-sm font-medium text-slate-600">
          Your membership record is missing a TIN. You can dismiss this for now, but it will appear every time you sign in until a TIN is saved.
        </p>
        <label className="mt-4 block text-sm font-bold text-slate-700">
          TIN (9–12 digits)
          <input
            className="input-field mt-1 w-full"
            inputMode="numeric"
            value={tin}
            onChange={(e) => setTin(e.target.value)}
          />
        </label>
        {error ? <p className="mt-2 text-sm font-bold text-red-700">{error}</p> : null}
        <div className="mt-5 flex gap-3">
          <button type="button" className="flex-1 rounded-xl border px-4 py-3 text-sm font-black" onClick={onDismiss}>
            Later
          </button>
          <button
            type="button"
            className="btn-primary flex-1"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onSave(tin);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not save TIN");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save TIN"}
          </button>
        </div>
      </div>
    </div>
  );
}
