import { addDoc, collection, getDocs, query, serverTimestamp, where } from "firebase/firestore";

const apiBase = () => (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

const useRest = () => Boolean(apiBase());

/** Nest often returns JSON `{ message: string | string[] }`; surface that in the UI. */
async function parseApiErrorMessage(response) {
  const text = await response.text();
  if (!text?.trim()) return `Request failed (${response.status})`;
  const raw = text.trim();
  if (/^<!doctype html/i.test(raw) || /^<html/i.test(raw) || /<body[\s>]/i.test(raw)) {
    return "API endpoint misconfigured (received HTML page). Please try again later or contact support.";
  }
  try {
    const j = JSON.parse(raw);
    const m = j?.message;
    if (m != null) {
      return Array.isArray(m) ? m.map((x) => String(x)).join("; ") : String(m);
    }
  } catch {
    /* plain text body */
  }
  return raw;
}

/** Sole caller: `getAllRecords` after explicit staff dashboard form submit — not used for member flows. */
async function staffLoginRequest(email, password) {
  const response = await fetch(`${apiBase()}/auth/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new Error(await parseApiErrorMessage(response));
  }
  return response.json();
}

/**
 * Staff JWT when Firebase ID token email matches a `StaffUser` row (no staff password).
 * @returns {Promise<{ accessToken: string, role: string, dbRole?: string | null, email: string }>}
 */
async function staffSessionFromFirebaseRequest(firebaseIdToken) {
  const response = await fetch(`${apiBase()}/auth/staff/firebase-session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${String(firebaseIdToken ?? "").trim()}`,
    },
  });
  if (!response.ok) {
    throw new Error(await parseApiErrorMessage(response));
  }
  return response.json();
}

export const PmesService = {
  async saveRecord(db, appId, user, data) {
    if (!useRest() && !user) throw new Error("Auth Required");
    if (useRest()) {
      const response = await fetch(`${apiBase()}/pmes/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: data.fullName,
          email: data.email,
          phone: data.phone,
          dob: data.dob,
          gender: data.gender,
          score: data.score,
          passed: data.passed,
        }),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail?.trim() || `PMES save failed (${response.status})`);
      }
      const row = await response.json();
      return { success: true, id: row.id };
    }
    const pmesRef = collection(db, "artifacts", appId, "public", "data", "pmes_records");
    const docRef = await addDoc(pmesRef, {
      ...data,
      userId: user.uid,
      timestamp: new Date().toISOString(),
      createdAt: serverTimestamp(),
    });
    return { success: true, id: docRef.id };
  },

  async saveLoi(db, appId, user, data) {
    if (!useRest() && !user) throw new Error("Auth Required");
    if (useRest()) {
      const email = String(data.email || user?.email || "").trim();
      if (!email) {
        throw new Error("Missing email — sign in again, or reload the page so your account email can load.");
      }
      const capital = typeof data.initialCapital === "string" ? parseFloat(data.initialCapital) : data.initialCapital;
      const response = await fetch(`${apiBase()}/pmes/loi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          address: data.address,
          occupation: data.occupation,
          employer: data.employer ?? "",
          initialCapital: Number.isFinite(capital) ? capital : 0,
        }),
      });
      if (!response.ok) {
        throw new Error(await parseApiErrorMessage(response));
      }
      return { success: true, id: "api" };
    }
    const loiRef = collection(db, "artifacts", appId, "public", "data", "loi_records");
    const docRef = await addDoc(loiRef, {
      ...data,
      userId: user.uid,
      submittedAt: new Date().toISOString(),
      createdAt: serverTimestamp(),
    });
    return { success: true, id: docRef.id };
  },

  async findRecord(db, appId, email, dob, user) {
    if (useRest()) {
      const params = new URLSearchParams({ email, dob });
      const response = await fetch(`${apiBase()}/pmes/certificate?${params}`);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(await parseApiErrorMessage(response));
      }
      return response.json();
    }
    if (!user) throw new Error("Auth Required");
    const pmesRef = collection(db, "artifacts", appId, "public", "data", "pmes_records");
    const q = query(pmesRef, where("userId", "==", user.uid));
    const snapshot = await getDocs(q);
    const records = snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter(
        (record) =>
          record.email?.toLowerCase().trim() === email.toLowerCase().trim() && record.dob === dob,
      );
    return records.find((record) => record.passed) || records[0] || null;
  },

  /**
   * Staff dashboard: PMES master list + role + token for follow-up API calls.
   * @returns {{ records: unknown[], role: string, accessToken: string, dbRole?: string | null }}
   */
  async staffSessionFromFirebase(firebaseIdToken) {
    if (!useRest()) throw new Error("API required");
    const t = String(firebaseIdToken ?? "").trim();
    if (!t) throw new Error("Firebase ID token required");
    return staffSessionFromFirebaseRequest(t);
  },

  async getAllRecords(db, appId, credentials) {
    if (useRest()) {
      const email = String(credentials?.email ?? "").trim();
      const password = String(credentials?.password ?? "");
      if (!email || !password.trim()) {
        throw new Error("Staff email and password required");
      }
      const login = await staffLoginRequest(email, password);
      const accessToken = login.accessToken;
      const role = login.role;
      const dbRole = login.dbRole != null ? String(login.dbRole) : null;
      const response = await fetch(`${apiBase()}/pmes/admin/records`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new Error((await response.text()) || "Master list failed");
      }
      const records = await response.json();
      return {
        records: Array.isArray(records) ? records : [],
        role,
        accessToken,
        dbRole,
      };
    }
    throw new Error("Staff dashboard requires VITE_API_BASE_URL and the Nest API with a database superuser (npm run create-superuser).");
  },

  /** Reload PMES master list using an existing staff JWT (e.g. after page refresh). */
  async fetchAdminRecords(accessToken) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/pmes/admin/records`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error((await response.text()) || "Master list failed");
    }
    const records = await response.json();
    return Array.isArray(records) ? records : [];
  },

  /**
   * Superuser only: remove a PMES master list row (PmesRecord). Does not delete the participant.
   */
  async deletePmesRecord(accessToken, recordId) {
    if (!useRest()) throw new Error("API required");
    const id = String(recordId ?? "").trim();
    if (!id) throw new Error("Record id required");
    const response = await fetch(`${apiBase()}/pmes/admin/records/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text?.trim() || `Delete failed (${response.status})`;
      try {
        const j = JSON.parse(text);
        const m = j?.message;
        if (m != null) {
          detail = Array.isArray(m) ? m.map((x) => String(x)).join("; ") : String(m);
        }
      } catch {
        /* keep detail */
      }
      if (response.status === 404 && detail.includes("Cannot DELETE")) {
        throw new Error(
          "The backend on your API port is an old Node process (it does not have the delete route). Stop it and restart: press Ctrl+C in the terminal running the API, then from the repo root run npm run dev. If it still fails, free the port: lsof -nP -iTCP:3000 -sTCP:LISTEN then kill -9 the listed PID(s).",
        );
      }
      throw new Error(detail);
    }
    if (!text?.trim()) return {};
    return JSON.parse(text);
  },

  async listStaffAdmins(accessToken) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/auth/staff/admins`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error((await response.text()) || "Could not load admin accounts");
    }
    return response.json();
  },

  async createStaffAdmin(accessToken, email, password) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/auth/staff/admins`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) {
      throw new Error((await response.text()) || "Could not create admin");
    }
    return response.json();
  },

  async promoteStaffToSuperuser(accessToken, email) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/auth/staff/superusers/promote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ email }),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  async changeOwnStaffPassword(accessToken, currentPassword, newPassword) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/auth/staff/password`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  /** Cooperative membership pipeline (PostgreSQL participant row). */
  async fetchMembershipLifecycle(email) {
    if (!useRest() || !String(email || "").trim()) return null;
    const response = await fetch(`${apiBase()}/pmes/membership-lifecycle?email=${encodeURIComponent(String(email).trim())}`);
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  /** Map email, callsign, lastname-seq label, or member ID → Firebase email. Returns null if 404. */
  async resolveLoginEmail(login) {
    if (!useRest() || !String(login || "").trim()) return null;
    const response = await fetch(
      `${apiBase()}/pmes/member/resolve-login-email?login=${encodeURIComponent(String(login).trim())}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  /** Updates Firebase primary email + Participant row; Bearer must match current email. */
  async patchMemberLoginEmail({ email, newEmail, idToken }) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/pmes/member/login-email`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify({ email: String(email || "").trim(), newEmail: String(newEmail || "").trim() }),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  async submitFullProfile({ email, profileJson, sheetFileName, notes, expectedProfileRecordVersion, signal }) {
    if (!useRest()) throw new Error("API required");
    const body = {
      email,
      profileJson,
      sheetFileName,
      notes,
      ...(typeof expectedProfileRecordVersion === "number" && Number.isFinite(expectedProfileRecordVersion)
        ? { expectedProfileRecordVersion }
        : {}),
    };
    const response = await fetch(`${apiBase()}/pmes/full-profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const msg = await parseApiErrorMessage(response);
      const err = new Error(msg);
      if (response.status === 409) err.pmesConflict = true;
      throw err;
    }
    return response.json();
  },

  /** Optional callsign; Firebase Bearer required when Admin is configured. Empty string clears. */
  async patchMemberCallsign({ email, callsign, idToken }) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/pmes/member/callsign`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify({ email: String(email || "").trim(), callsign }),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  /**
   * Persist portal “Member profile” fields (name, mobile, DOB, gender, residence as mailing) to the participant row.
   * Requires Firebase Bearer for the same email.
   */
  async patchMemberBasicProfile({ email, fullName, phone, dob, gender, mailingAddress, tinNo, idToken }) {
    if (!useRest()) throw new Error("API required");
    const body = { email: String(email || "").trim() };
    if (fullName !== undefined) body.fullName = fullName;
    if (phone !== undefined) body.phone = phone;
    if (dob !== undefined) body.dob = dob;
    if (gender !== undefined) body.gender = gender;
    if (mailingAddress !== undefined) body.mailingAddress = mailingAddress;
    if (tinNo !== undefined) body.tinNo = tinNo;
    const response = await fetch(`${apiBase()}/pmes/member/basic-profile`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  async fetchMembershipPipeline(accessToken) {
    if (!useRest()) return [];
    const response = await fetch(`${apiBase()}/pmes/admin/membership-pipeline`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const msg = await parseApiErrorMessage(response);
      const err = new Error(msg || `Pipeline load failed (${response.status})`);
      /** @type {Error & { pmesHttpStatus?: number }} */ (err).pmesHttpStatus = response.status;
      throw err;
    }
    return response.json();
  },

  async updateParticipantMembership(accessToken, participantId, { initialFeesPaid, boardApproved }) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/pmes/admin/participant/membership`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ participantId, initialFeesPaid, boardApproved }),
    });
    if (!response.ok) {
      throw new Error((await response.text()) || "Membership update failed");
    }
    return response.json();
  },

  async recordMembershipPayment(accessToken, participantId, { paymentType, period }) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/pmes/admin/participant/membership-payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ participantId, paymentType, period }),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  async recordBodVote(accessToken, participantId, approve) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/pmes/admin/participant/bod-vote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ participantId, approve }),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  async recordSecretaryBoardConfirm(accessToken, participantId, { forcePmesOverride } = {}) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/pmes/admin/participant/secretary-confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ participantId, forcePmesOverride: forcePmesOverride === true }),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  /**
   * Superuser only: delete one participant (all PMES rows + LOI). Removes a membership pipeline row.
   */
  async deleteParticipant(accessToken, participantId) {
    if (!useRest()) throw new Error("API required");
    const id = String(participantId ?? "").trim();
    if (!id) throw new Error("Participant id required");
    const response = await fetch(`${apiBase()}/pmes/admin/participants/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text?.trim() || `Delete failed (${response.status})`;
      try {
        const j = JSON.parse(text);
        const m = j?.message;
        if (m != null) {
          detail = Array.isArray(m) ? m.map((x) => String(x)).join("; ") : String(m);
        }
      } catch {
        /* keep detail */
      }
      if (response.status === 404 && detail.includes("Cannot DELETE")) {
        throw new Error(
          "The backend on your API port is an old Node process (it does not have participant delete). Restart the API from the repo root (npm run dev) or free port 3000.",
        );
      }
      throw new Error(detail);
    }
    if (!text?.trim()) return {};
    return JSON.parse(text);
  },

  /** Admin: full members registry (search + pagination). */
  async fetchMemberRegistry(accessToken, { q = "", page = 1, pageSize = 50, includeAll = false } = {}) {
    if (!useRest()) throw new Error("API required");
    const params = new URLSearchParams();
    if (String(q || "").trim()) params.set("q", String(q).trim());
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    if (includeAll) params.set("includeAll", "true");
    const response = await fetch(`${apiBase()}/pmes/admin/member-registry?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error((await response.text()) || "Member registry failed");
    }
    return response.json();
  },

  async fetchParticipantAdminDetail(accessToken, participantId) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(
      `${apiBase()}/pmes/admin/participants/${encodeURIComponent(String(participantId))}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) {
      throw new Error((await response.text()) || "Participant detail failed");
    }
    return response.json();
  },

  /** Admin or superuser: update core participant fields (Postgres + Firebase email when linked). */
  async patchAdminParticipantProfile(accessToken, participantId, fields) {
    if (!useRest()) throw new Error("API required");
    const id = String(participantId ?? "").trim();
    if (!id) throw new Error("Participant id required");
    const response = await fetch(`${apiBase()}/pmes/admin/participants/${encodeURIComponent(id)}/profile`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(fields && typeof fields === "object" ? fields : {}),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  /** Admin or superuser: set member Firebase password (member must have firebaseUid). */
  async resetMemberFirebasePassword(accessToken, participantId, newPassword) {
    if (!useRest()) throw new Error("API required");
    const id = String(participantId ?? "").trim();
    if (!id) throw new Error("Participant id required");
    const response = await fetch(`${apiBase()}/pmes/admin/participants/${encodeURIComponent(id)}/reset-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ newPassword: String(newPassword ?? "") }),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  /**
   * Superuser only: set or correct cooperative member ID (must be unique; syncs stored profile JSON when present).
   */
  async superuserSetMemberId(accessToken, participantId, memberIdNo) {
    if (!useRest()) throw new Error("API required");
    const id = String(participantId ?? "").trim();
    if (!id) throw new Error("Participant id required");
    const response = await fetch(`${apiBase()}/pmes/admin/participants/${encodeURIComponent(id)}/member-id`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ memberIdNo: String(memberIdNo ?? "").trim() }),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text?.trim() || `Update failed (${response.status})`;
      try {
        const j = JSON.parse(text);
        const m = j?.message;
        if (m != null) {
          detail = Array.isArray(m) ? m.map((x) => String(x)).join("; ") : String(m);
        }
      } catch {
        /* keep detail */
      }
      throw new Error(detail);
    }
    if (!text?.trim()) return {};
    return JSON.parse(text);
  },

  /** Public: roster full name + TIN match a legacy-imported pioneer; returns { eligible, signInEmail? }. */
  async checkPioneerEligibility(payload) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/pmes/pioneer/check-eligibility`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: String(payload?.firstName ?? "").trim(),
        middleName: String(payload?.middleName ?? "").trim(),
        lastName: String(payload?.lastName ?? "").trim(),
        tinNo: String(payload?.tinNo ?? "").trim(),
      }),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  /** Admin: bulk-create legacy pioneer rows (pipeline ends at full membership form). */
  async importLegacyPioneers(accessToken, rows) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/pmes/admin/import-legacy-pioneers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ rows: Array.isArray(rows) ? rows : [] }),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  /** Superuser: add one legacy pioneer row (same reclaim flow as bulk import). */
  /** Superuser: set staff login role for a member email (Treasurer, Secretary, BOD, Admin). */
  async patchMemberStaffPosition(accessToken, memberEmail, role) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/auth/staff/member-position`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ memberEmail: String(memberEmail || "").trim(), role: String(role || "").trim() }),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  async addLegacyPioneer(accessToken, row) {
    if (!useRest()) throw new Error("API required");
    const response = await fetch(`${apiBase()}/pmes/admin/legacy-pioneer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(row && typeof row === "object" ? row : {}),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  async getStoreCatalog() {
    if (!useRest()) throw new Error("Store requires VITE_API_BASE_URL and the Nest API");
    const response = await fetch(`${apiBase()}/store/catalog`);
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  async getMemberPatronageSummary(email, firebaseIdToken) {
    if (!useRest()) {
      return {
        patronageAccruedBalance: "0.00",
        purchaseCount: 0,
        accruals: [],
        note: "Patronage ledger requires VITE_API_BASE_URL",
      };
    }
    const response = await fetch(
      `${apiBase()}/members/patronage-summary?email=${encodeURIComponent(String(email ?? "").trim())}`,
      {
        headers: {
          Authorization: `Bearer ${String(firebaseIdToken ?? "").trim()}`,
        },
      },
    );
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  async getMemberPassbookSummary(email, firebaseIdToken) {
    if (!useRest()) {
      return {
        currency: "PHP",
        dues: null,
        passbook: [],
        note: "Member passbook requires VITE_API_BASE_URL",
      };
    }
    const response = await fetch(
      `${apiBase()}/members/passbook-summary?email=${encodeURIComponent(String(email ?? "").trim())}`,
      {
        headers: {
          Authorization: `Bearer ${String(firebaseIdToken ?? "").trim()}`,
        },
      },
    );
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },

  async checkoutStore(email, items, firebaseIdToken) {
    if (!useRest()) throw new Error("Store checkout requires VITE_API_BASE_URL and the Nest API");
    const response = await fetch(`${apiBase()}/store/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${String(firebaseIdToken ?? "").trim()}`,
      },
      body: JSON.stringify({ email: String(email ?? "").trim(), items }),
    });
    if (!response.ok) {
      throw new Error(await parseApiErrorMessage(response));
    }
    return response.json();
  },
};
