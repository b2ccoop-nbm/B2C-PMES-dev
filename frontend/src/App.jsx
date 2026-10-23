import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reload,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateEmail,
  updatePassword,
  updateProfile,
} from "firebase/auth";
import {
  AlertCircle,
  Briefcase,
  Calendar,
  Check,
  CheckCircle2,
  Coins,
  Eye,
  FileText,
  HeartHandshake,
  IdCard,
  House,
  Loader2,
  LogIn,
  Lock,
  Mail,
  MapPin,
  Phone,
  Printer,
  Search,
  ShoppingBag,
  ShieldAlert,
  Trash2,
  Sparkles,
  ChevronDown,
  User,
  UserPlus,
  X,
} from "lucide-react";
import { queueSignupLiveActivityFromDevice } from "./lib/signupLiveActivity.js";
import { modules } from "./constants/modules";
import { questionPool } from "./constants/questionPool";
import { CourseAudioPreference, readCourseAudioPreference, writeCourseAudioPreference } from "./components/CourseAudioPreference";
import { NarrativeCard } from "./components/NarrativeCard";
import { Certificate } from "./components/Certificate";
import { LOIForm } from "./components/LOIForm";
import { pcmToWav, preloadAudioUrl } from "./lib/audio";
import { auth, db, appId, isFirebaseConfigured } from "./services/firebase";
import { PmesService } from "./services/pmesService";
import { resolveFirebaseLoginEmail } from "./services/resolveFirebaseLoginEmail.js";
import { clearPmesProgress, loadPmesProgress, savePmesProgress } from "./services/pmesProgressService";
import { syncMemberToPostgres } from "./services/memberSyncService.js";
import { requestTts } from "./services/ttsApi";
import { globalStyles } from "./styles/globalStyles";
import {
  PRIVACY_NOTICE_HEADING,
  PRIVACY_NOTICE_PARAGRAPHS,
  PRIVACY_PMES_CONSENT_CLOSING,
} from "./constants/privacyAgreement";
import LandingPage from "./landingpage/landing.jsx";
import { IdentityBanner } from "./components/IdentityBanner.jsx";
import { MessengerPaymentQr, MESSENGER_PAYMENT_CHAT_URL } from "./components/MessengerPaymentQr.jsx";
import { PortalHomeBar } from "./components/PortalHomeBar.jsx";
import { B2CLogo } from "./components/B2CLogo.jsx";
import { ReferralEngine } from "./components/ReferralEngine.jsx";
import { MemberSpotlight } from "./components/MemberSpotlight.jsx";
import { MemberLifecyclePortal } from "./components/MemberLifecyclePortal.jsx";
import { CoopStore } from "./components/CoopStore.jsx";
import { MemberPatronageCard } from "./components/MemberPatronageCard.jsx";
import { MemberPassbookCard } from "./components/MemberPassbookCard.jsx";
import { TreasurerMembershipPaymentActions } from "./components/TreasurerMembershipPaymentActions.jsx";
import { MemberSubmissionAckScreen } from "./components/MemberSubmissionAckScreen.jsx";
import { RegisterApp } from "./../lib/register-ui/RegisterApp";
import { TinPromptModal } from "./components/TinPromptModal.jsx";
import { ApplicationChecklist } from "./components/ApplicationChecklist.jsx";
import { OnlineApplicationsAdmin } from "./components/OnlineApplicationsAdmin.jsx";
import { PIONEER_POINTS_PER_JOIN } from "./lib/referralTiers.js";
import { PUBLIC_MEMBER_COUNT } from "./constants/cooperativeBrand.js";
import { derivePmesIntent } from "./lib/pmesIntent.js";
import {
  getJoinPipelineBanner,
  planJoinNavigation,
  shouldHidePmesEntry,
} from "./lib/joinJourney.js";
import { resolveMemberPortalAccess } from "./lib/membershipAccess.js";
import {
  canCastBodVote,
  countMembershipInboxByStage,
  staffPipelineInboxSummary,
} from "./lib/membershipInboxCounts.js";
import { canOpenAccounting } from "./lib/accountingAccess.js";

/** Pipeline row flags — BOD votes only while majority not yet reached. */
function flagsFromPipelineRow(row) {
  const needFees = row.loiSubmitted && !row.initialFeesPaid;
  const needBodVote =
    row.initialFeesPaid && row.loiSubmitted && !row.boardApproved && !row.bodMajorityReached;
  const needSecretary = row.initialFeesPaid && row.bodMajorityReached && !row.boardApproved;
  return { needFees, needBodVote, needSecretary };
}

/**
 * Gemini prebuilt voices currently accepted in production include Aoede.
 * OpenAI/Grok map unknown names server-side, but Gemini can reject retired names.
 */
const VOICE = "Aoede";
/** Bump when backend TTS output meaningfully changes — avoids replaying stale blob URLs from an old build. */
const TTS_CLIENT_CACHE_BUST = "4";
/** Member registry API page size — keep modest so each page fits typical screens; use Next for more rows. */
const REGISTRY_PAGE_SIZE = 15;

const RESUMABLE_APP_STATES = new Set([
  "consent",
  "registration",
  "seminar",
  "exam",
  "result",
  "certificate",
  "loi_form",
]);

/** PMES and related flows: never render without a Firebase sign-in (guarded below). */
const MEMBER_AUTH_REQUIRED_STATES = new Set([
  "consent",
  "registration",
  "member_portal",
  "member_pending",
  "member_submission_success",
  "seminar",
  "exam",
  "result",
  "certificate",
  "loi_form",
  "payment_portal",
  "coop_store",
]);

/** Join name parts for certificates, API `fullName`, and Firebase displayName. */
function composeFullName(first, middle, last) {
  return [first, middle, last]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

/** Treasurer fee confirmation → Accounting `membership.initial_fees` post result. */
function adminToastForAccountingFees(apiResponse) {
  const a = apiResponse?.accountingInitialFees;
  if (!a) return null;
  if (a.ok) {
    return {
      type: /** @type {"success"} */ ("success"),
      message: a.created
        ? "Fees recorded and posted to Accounting (new journal voucher)."
        : "Fees recorded — already in Accounting books.",
    };
  }
  return {
    type: /** @type {"error"} */ ("error"),
    message: `Fees saved in PMES, but Accounting post failed: ${a.error ?? "check ACCOUNTING_API_URL"}`,
  };
}

function formatMemberPositionLabel(rawRole) {
  const key = String(rawRole || "").trim().toUpperCase();
  if (!key) return "";
  const labels = {
    SUPERUSER: "Superuser",
    ADMIN: "Admin",
    TREASURER: "Treasurer",
    SECRETARY: "Secretary",
    BOARD_DIRECTOR: "Board Director",
    CHAIRMAN: "Chairperson",
    VICE_CHAIRMAN: "Vice Chairperson",
    GENERAL_MANAGER: "General Manager",
  };
  if (labels[key]) return labels[key];
  return key
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function escapeHtmlForPrint(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Staff JWT + role for this browser tab only (survives refresh until tab close or Logout). */
const STAFF_SS_TOKEN = "b2ccoop_webapp_staff_jwt";
const STAFF_SS_ROLE = "b2ccoop_webapp_staff_role";
const STAFF_SS_EMAIL = "b2ccoop_webapp_staff_email";
const STAFF_SS_DB_ROLE = "b2ccoop_webapp_staff_db_role";

function persistStaffSession(token, role, email, dbRole) {
  try {
    if (!token?.trim() || !email?.trim()) return;
    const allowed = ["admin", "superuser", "treasurer", "board_director", "secretary"];
    if (!allowed.includes(role)) return;
    sessionStorage.setItem(STAFF_SS_TOKEN, token.trim());
    sessionStorage.setItem(STAFF_SS_ROLE, role);
    sessionStorage.setItem(STAFF_SS_EMAIL, email.trim());
    if (dbRole && typeof dbRole === "string" && String(dbRole).trim()) {
      sessionStorage.setItem(STAFF_SS_DB_ROLE, String(dbRole).trim());
    } else {
      sessionStorage.removeItem(STAFF_SS_DB_ROLE);
    }
  } catch {
    /* quota / private mode */
  }
}

function clearStaffSession() {
  try {
    sessionStorage.removeItem(STAFF_SS_TOKEN);
    sessionStorage.removeItem(STAFF_SS_ROLE);
    sessionStorage.removeItem(STAFF_SS_EMAIL);
    sessionStorage.removeItem(STAFF_SS_DB_ROLE);
  } catch {
    /* noop */
  }
}

/** @returns {{ token: string; role: string; email: string; dbRole: string | null } | null} */
function readStaffSession() {
  try {
    const token = sessionStorage.getItem(STAFF_SS_TOKEN);
    const role = sessionStorage.getItem(STAFF_SS_ROLE);
    const email = sessionStorage.getItem(STAFF_SS_EMAIL);
    const dbRoleRaw = sessionStorage.getItem(STAFF_SS_DB_ROLE);
    if (!token?.trim() || !email?.trim()) return null;
    const allowed = ["admin", "superuser", "treasurer", "board_director", "secretary"];
    if (!role || !allowed.includes(role)) return null;
    return { token: token.trim(), role, email: email.trim(), dbRole: dbRoleRaw?.trim() || null };
  } catch {
    return null;
  }
}

/** Opens a print dialog with the current registry rows (browser can Save as PDF). */
function printMemberRegistryTable(rows, title = "Member registry") {
  const w = window.open("", "_blank");
  if (!w) return;
  const header =
    "<tr><th>Name</th><th>Email</th><th>Phone</th><th>DOB</th><th>Mailing address</th><th>Civil status</th><th>Member ID</th></tr>";
  const body = (rows || [])
    .map((r) => {
      const x = /** @type {Record<string, unknown>} */ (r);
      return `<tr><td>${escapeHtmlForPrint(x.fullName)}</td><td>${escapeHtmlForPrint(x.email)}</td><td>${escapeHtmlForPrint(x.phone)}</td><td>${escapeHtmlForPrint(x.dob)}</td><td>${escapeHtmlForPrint(x.mailingAddress)}</td><td>${escapeHtmlForPrint(x.civilStatus)}</td><td>${escapeHtmlForPrint(x.memberIdNo)}</td></tr>`;
    })
    .join("");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtmlForPrint(title)}</title><style>body{font-family:ui-sans-serif,system-ui,sans-serif;padding:20px;color:#0f172a;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #cbd5e1;padding:8px 10px;font-size:11px;vertical-align:top;}th{background:#f1f5f9;font-weight:700;text-align:left;}h1{font-size:18px;margin:0 0 16px;}</style></head><body><h1>${escapeHtmlForPrint(title)}</h1><table><thead>${header}</thead><tbody>${body || '<tr><td colspan="7">No rows</td></tr>'}</tbody></table></body></html>`;
  w.document.write(html);
  w.document.close();
  w.onload = () => {
    w.print();
    w.close();
  };
}

/** Identity ribbon: show first + last only (no middle name). */
function displayNameFirstLast(formData, activeRecordFullName, authDisplayName) {
  const fn = String(formData?.firstName || "").trim();
  const ln = String(formData?.lastName || "").trim();
  if (fn && ln) return `${fn} ${ln}`;
  const fromFull = (s) => {
    const t = String(s || "").trim();
    if (!t) return "";
    const parts = t.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts[parts.length - 1]}`;
  };
  return (
    fromFull(formData?.fullName) ||
    fromFull(activeRecordFullName) ||
    fromFull(authDisplayName) ||
    ""
  );
}

/**
 * Profile: name (composed or legacy single fullName), DOB, email, gender, phone — for PMES / exam gate.
 * Residence is required when first+last name were captured (new sign-up); older saves may only have `fullName`.
 */
function isParticipantProfileComplete(fd) {
  if (!fd || typeof fd !== "object") return false;
  const nameOk =
    String(fd.fullName || "").trim() ||
    (String(fd.firstName || "").trim() && String(fd.lastName || "").trim());
  if (!nameOk || !fd.dob || !String(fd.email || "").trim() || !fd.gender || !String(fd.phone || "").trim()) {
    return false;
  }
  const hasResidence = String(fd.residenceAddress || "").trim();
  const splitNames = Boolean(String(fd.firstName || "").trim() && String(fd.lastName || "").trim());
  if (splitNames) return Boolean(hasResidence);
  return true;
}

function mapFirebaseAuthError(code) {
  switch (code) {
    case "auth/email-already-in-use":
      return "This email is already registered. Try logging in instead.";
    case "auth/invalid-email":
      return "Enter a valid email address.";
    case "auth/weak-password":
      return "Use at least 6 characters for your password.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect email or password.";
    case "auth/too-many-requests":
      return "Too many attempts. Try again later.";
    default:
      return "Something went wrong. Check your connection and try again.";
  }
}

function isValidEmailAddress(raw) {
  const s = String(raw || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 320;
}

/** Legacy pioneer placeholder login generated by import/reclaim flow. */
function isPlaceholderRegistryLoginEmail(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return s.endsWith("@b2c-registry.example.com");
}

function formatTtsError(err) {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes("503") && /TTS is disabled|AI_PROVIDER=noop/i.test(raw)) {
    return "Course audio is unavailable at the moment. Proceed with no audio.";
  }
  if (raw.includes("500") || raw.includes("Gemini TTS failed")) {
    return "Voice could not be generated. Check API settings (GEMINI_API_KEY and AI_PROVIDER) or turn course audio off.";
  }
  if (raw.length > 180) {
    return `${raw.slice(0, 180)}…`;
  }
  return raw;
}

export default function App() {
  const [registerPath, setRegisterPath] = useState(/** @type {string | null} */ (null));
  const [tinPromptOpen, setTinPromptOpen] = useState(false);
  const [tinDismissedThisView, setTinDismissedThisView] = useState(false);
  const [appState, setAppState] = useState("landing");
  const appStateRef = useRef(appState);
  useEffect(() => {
    appStateRef.current = appState;
  }, [appState]);

  const [authReady, setAuthReady] = useState(false);

  /** Store `?ref=PIONEER-...` for POST /auth/sync-member; strip from URL after capture. */
  /** Open staff admin: ?admin=1 — native dev store: ?coop_store=1 (after sign-in). */
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const params = new URLSearchParams(window.location.search);
      const ref = params.get("ref")?.trim();
      const wantsAdmin = params.get("admin");
      const wantsCoopStore = params.get("coop_store");
      let changed = false;
      if (ref) {
        if (!sessionStorage.getItem("b2ccoop_webapp_referral_code")) {
          sessionStorage.setItem("b2ccoop_webapp_referral_code", ref);
        }
        params.delete("ref");
        changed = true;
      }
      if (wantsAdmin === "1" || wantsAdmin === "true") {
        params.delete("admin");
        changed = true;
        setAppState("admin_login");
      }
      if (wantsCoopStore === "1" || wantsCoopStore === "true") {
        params.delete("coop_store");
        changed = true;
        sessionStorage.setItem("b2ccoop_open_coop_store", "1");
      }
      if (changed) {
        const qs = params.toString();
        const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
        window.history.replaceState({}, "", next);
      }
      const path = window.location.pathname.replace(/\/$/, "") || "/";
      if (path === "/register" || path.startsWith("/register/") || path === "/set-password") {
        setRegisterPath(path);
      }
    } catch {
      /* sessionStorage / history may be unavailable */
    }
  }, []);


  const [signUp, setSignUp] = useState({
    firstName: "",
    middleName: "",
    lastName: "",
    phone: "",
    dob: "",
    residenceAddress: "",
    email: "",
    password: "",
    confirm: "",
  });
  const [logIn, setLogIn] = useState({ email: "", password: "" });
  /** Single screen for member sign-in vs register */
  const [memberAuthMode, setMemberAuthMode] = useState(/** @type {"signup" | "login"} */ ("login"));
  /** Pioneer reclaim: import email is fixed; signup collects password + prefilled roster names only. */
  const [pioneerClaimAuthActive, setPioneerClaimAuthActive] = useState(false);
  /** Staff email after successful admin dashboard login (for identity ribbon). */
  const [staffSessionEmail, setStaffSessionEmail] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [forgotPasswordBusy, setForgotPasswordBusy] = useState(false);
  const [forgotPasswordNotice, setForgotPasswordNotice] = useState(/** @type {string | null} */ (null));
  const [user, setUser] = useState(null);
  const hydratingRef = useRef(false);
  /** Last uid we ran Postgres sync for inside this auth listener (avoids double fire when sign-up also calls sync). */
  const memberSyncOncePerUidRef = useRef(/** @type {string | null} */ (null));
  /** Last PMES flow screen (consent, seminar, …) — used for resume snapshot + landing “Continue PMES”. Starts null until user enters a resumable step or progress loads. */
  const lastFlowAppStateRef = useRef(/** @type {string | null} */ (null));
  /** Where `registration` was opened from: exam gate, member portal, or default (legacy → seminar). */
  const registrationNavRef = useRef(/** @type {"exam" | "portal" | "menu"} */ ("menu"));
  /** After email/password auth: certificate retrieval or pioneer reclaim — not the unified join path. */
  const pendingAfterAuthRef = useRef(/** @type {'retrieval' | 'pioneer_portal' | null} */ (null));
  /** After guest taps Join / Start PMES, run unified join navigation once logged in. */
  const pendingPostAuthUnifiedJoinRef = useRef(false);
  const [formData, setFormData] = useState({
    fullName: "",
    firstName: "",
    middleName: "",
    lastName: "",
    gender: "",
    email: "",
    phone: "",
    dob: "",
    residenceAddress: "",
  });
  /** Member profile screen: optional Firebase + Postgres sign-in email change */
  const [memberLoginEmailNew, setMemberLoginEmailNew] = useState("");
  const [memberLoginEmailConfirm, setMemberLoginEmailConfirm] = useState("");
  const [memberLoginEmailBusy, setMemberLoginEmailBusy] = useState(false);
  const [memberLoginEmailError, setMemberLoginEmailError] = useState(/** @type {string | null} */ (null));
  const [memberLoginEmailSuccess, setMemberLoginEmailSuccess] = useState(/** @type {string | null} */ (null));
  const [memberPasswordForm, setMemberPasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [memberPasswordBusy, setMemberPasswordBusy] = useState(false);
  const [memberPasswordError, setMemberPasswordError] = useState(/** @type {string | null} */ (null));
  const [memberPasswordSuccess, setMemberPasswordSuccess] = useState(/** @type {string | null} */ (null));
  const [loiData, setLoiData] = useState({ address: "", occupation: "", employer: "", initialCapital: "", agreement: false });
  const [retrievalData, setRetrievalData] = useState({ email: "", dob: "" });
  const [pioneerReclaimFirstName, setPioneerReclaimFirstName] = useState("");
  const [pioneerReclaimMiddleName, setPioneerReclaimMiddleName] = useState("");
  const [pioneerReclaimLastName, setPioneerReclaimLastName] = useState("");
  const [pioneerReclaimTin, setPioneerReclaimTin] = useState("");
  /** Set when eligibility succeeds — Firebase account must use this email (synthesized on import if sheet had none). */
  const [pioneerReclaimSignInEmail, setPioneerReclaimSignInEmail] = useState(/** @type {string | null} */ (null));
  const [pioneerReclaimLoading, setPioneerReclaimLoading] = useState(false);
  const [pioneerReclaimError, setPioneerReclaimError] = useState(null);
  const [pioneerReclaimEligible, setPioneerReclaimEligible] = useState(/** @type {boolean | null} */ (null));
  const [pioneerReclaimFailReason, setPioneerReclaimFailReason] = useState(/** @type {"not_found" | "ambiguous" | null} */ (null));
  const [legacyImportJson, setLegacyImportJson] = useState(`[
  {
    "lastName": "Academia",
    "firstName": "Mary Kate",
    "middleName": "Momongan",
    "sexGender": "Female",
    "registryTimestamp": "1/25/25 12:33",
    "civilStatus": "Married",
    "street": "Saint Matthew Street",
    "barangay": "Tabok",
    "cityMunicipality": "Mandaue",
    "province": "Cebu",
    "tinNo": "207863868",
    "initialSubscriptionAmount": "4,000.00",
    "paidUpShareAmount": "1,000.00",
    "email": "member@example.com",
    "phone": "+639171234567",
    "dob": "1985-06-15"
  }
]`);
  const [legacyImportMsg, setLegacyImportMsg] = useState(null);
  /** `"error"` when `legacyImportMsg` is a failure message; otherwise success / parse result. */
  const [legacyImportMsgKind, setLegacyImportMsgKind] = useState(/** @type {"success" | "error" | null} */ (null));
  const [legacyImportLoading, setLegacyImportLoading] = useState(false);
  /** Superuser: modal to add one legacy pioneer not on the bulk roster. */
  const [addLegacyOpen, setAddLegacyOpen] = useState(false);
  const [addLegacyLoading, setAddLegacyLoading] = useState(false);
  const [addLegacyForm, setAddLegacyForm] = useState({
    firstName: "",
    lastName: "",
    middleName: "",
    tinNo: "",
    phone: "",
    dob: "",
    email: "",
    civilStatus: "",
    sexGender: "",
  });
  /** Bump after add-legacy success to refetch member registry. */
  const [registryRefreshNonce, setRegistryRefreshNonce] = useState(0);
  const [adminToast, setAdminToast] = useState(/** @type {null | { type: "success" | "error"; message: string }} */ (null));
  const [adminCreds, setAdminCreds] = useState({ email: "", password: "" });
  /** Staff JWT role after admin dashboard login; JWT also in sessionStorage for this tab (refresh-safe). */
  const [staffRole, setStaffRole] = useState(
    /** @type {null | "admin" | "superuser" | "treasurer" | "board_director" | "secretary"} */ (null),
  );
  /** Prisma `StaffUser.role` from login — needed when JWT is `admin` (Chairperson / Vice Chairperson / GM). */
  const [staffDbRole, setStaffDbRole] = useState(/** @type {string | null} */ (null));
  const [staffAccessToken, setStaffAccessToken] = useState(null);
  const [managedStaffAdmins, setManagedStaffAdmins] = useState([]);
  const [newStaffAdmin, setNewStaffAdmin] = useState({ email: "", password: "" });
  const [staffAdminError, setStaffAdminError] = useState(null);
  const [staffPasswordForm, setStaffPasswordForm] = useState({ currentPassword: "", newPassword: "" });
  const [staffPasswordError, setStaffPasswordError] = useState(null);
  const [staffPasswordSuccess, setStaffPasswordSuccess] = useState(null);
  /** Admin dashboard: collapsed by default — only toggle buttons until opened. */
  const [staffPasswordPanelOpen, setStaffPasswordPanelOpen] = useState(false);
  const [adminAccountsPanelOpen, setAdminAccountsPanelOpen] = useState(false);
  /** Large admin lists start collapsed so officers open only the section they need. */
  const [adminDashPmesRecordsOpen, setAdminDashPmesRecordsOpen] = useState(false);
  const [adminDashMemberRegistryOpen, setAdminDashMemberRegistryOpen] = useState(false);
  const [adminDashLegacyImportOpen, setAdminDashLegacyImportOpen] = useState(false);
  const [adminDashPipelineOpen, setAdminDashPipelineOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [openCardIndex, setOpenCardIndex] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  /** Which narrative card key (`index-title`) is fetching/buffering audio — avoids disabling every card. */
  const [loadingTtsKey, setLoadingTtsKey] = useState(null);
  /** Which section is currently playing TTS (for per-card Pause in the header). */
  const [speakingTtsKey, setSpeakingTtsKey] = useState(null);
  const [ttsError, setTtsError] = useState(null);
  const [activeRecord, setActiveRecord] = useState(null);
  const [masterList, setMasterList] = useState([]);
  /** While a superuser delete request is in flight (row id). */
  const [deletingMasterListId, setDeletingMasterListId] = useState(null);
  /** Superuser: membership pipeline participant delete in flight. */
  const [deletingPipelineParticipantId, setDeletingPipelineParticipantId] = useState(null);
  const [examQuestions, setExamQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [score, setScore] = useState(0);
  const [courseAudioEnabled, setCourseAudioEnabledState] = useState(readCourseAudioPreference);
  /** True when the member left PMES for the marketing home but has not finished the flow (resume later). */
  const [pmesPaused, setPmesPaused] = useState(false);
  /** PostgreSQL membership pipeline when `VITE_API_BASE_URL` is set */
  const [membershipLifecycle, setMembershipLifecycle] = useState(/** @type {Record<string, unknown> | null} */ (null));
  const [membershipLoading, setMembershipLoading] = useState(false);

  useEffect(() => {
    if (!user?.email) {
      setTinDismissedThisView(false);
      setTinPromptOpen(false);
      return;
    }
    if (membershipLifecycle?.needsTin === true && !tinDismissedThisView) {
      setTinPromptOpen(true);
    } else if (membershipLifecycle?.needsTin !== true) {
      setTinPromptOpen(false);
    }
  }, [membershipLifecycle?.needsTin, user?.email, tinDismissedThisView]);
  /** Snapshot for the post–full-profile confirmation screen (Member ID, email). */
  const [memberSubmissionAck, setMemberSubmissionAck] = useState(
    /** @type {null | { memberIdNo: string; memberIdIsProvisional: boolean; loginEmail: string; officialContactEmail: string; displayName: string; alternatePublicHandle: string; callsign: string }} */ (
      null
    ),
  );
  const [membershipPipeline, setMembershipPipeline] = useState(/** @type {unknown[]} */ ([]));
  /** Admin dashboard: participant card opened from pipeline name click. */
  const [pipelineDetailRow, setPipelineDetailRow] = useState(/** @type {Record<string, unknown> | null} */ (null));
  /** Admin member registry (full membership submissions) */
  const [registryRows, setRegistryRows] = useState(/** @type {unknown[]} */ ([]));
  const [registryTotal, setRegistryTotal] = useState(0);
  const [registryPage, setRegistryPage] = useState(1);
  const [registrySearchInput, setRegistrySearchInput] = useState("");
  const [registryAppliedSearch, setRegistryAppliedSearch] = useState("");
  const [registryIncludeAll, setRegistryIncludeAll] = useState(false);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryDetail, setRegistryDetail] = useState(/** @type {Record<string, unknown> | null} */ (null));
  /** Member registry detail modal: split long content into tabs (screen-sized chunks). */
  const [registryDetailTab, setRegistryDetailTab] = useState(
    /** @type {"summary" | "edit" | "account" | "json"} */ ("summary"),
  );
  const [registryProfileDraft, setRegistryProfileDraft] = useState(
    /** @type {null | { fullName: string; email: string; phone: string; dob: string; gender: string; tinNo: string; mailingAddress: string; civilStatus: string }} */ (
      null
    ),
  );
  const [registryProfileSaving, setRegistryProfileSaving] = useState(false);
  const [registryStaffRoleSelect, setRegistryStaffRoleSelect] = useState("ADMIN");
  const [registryStaffPositionSaving, setRegistryStaffPositionSaving] = useState(false);
  const [memberResetPwd, setMemberResetPwd] = useState({ newPassword: "", confirm: "" });
  const [memberResetPwdSaving, setMemberResetPwdSaving] = useState(false);
  const [superuserMemberIdDraft, setSuperuserMemberIdDraft] = useState("");
  const [superuserMemberIdSaving, setSuperuserMemberIdSaving] = useState(false);
  const audioCache = useRef({});
  const inflightTts = useRef({});
  const currentAudio = useRef(null);
  /** Prevents duplicate POST /auth/admin/login if the staff form is submitted twice quickly. */
  const adminLoginInFlightRef = useRef(false);
  /** Prevents double navigation when opening the admin portal from the landing page. */
  const adminPortalNavInFlightRef = useRef(false);

  const ensureTtsUrl = useCallback(async (text, cacheKey) => {
    const cacheId = `${VOICE}::${TTS_CLIENT_CACHE_BUST}::${cacheKey}`;
    const hit = audioCache.current[cacheId];
    if (hit) return hit;
    const pending = inflightTts.current[cacheId];
    if (pending) return pending;

    const p = (async () => {
      try {
        const result = await requestTts({ text, voice: VOICE });
        const base64 = result?.audioBase64;
        const encoding = result?.encoding ?? "pcm16";
        if (!base64) throw new Error("No TTS data");
        let wavUrl;
        if (encoding === "mp3") {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          wavUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
        } else {
          const pcm = new Int16Array(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer);
          wavUrl = URL.createObjectURL(pcmToWav(pcm));
        }
        audioCache.current[cacheId] = wavUrl;
        return wavUrl;
      } finally {
        delete inflightTts.current[cacheId];
      }
    })();

    inflightTts.current[cacheId] = p;
    return p;
  }, [VOICE]);

  const prefetchTts = useCallback(
    (text, cacheKey) => {
      void ensureTtsUrl(text, cacheKey).catch(() => null);
    },
    [ensureTtsUrl],
  );

  const applyLoadedProgress = useCallback((prog) => {
    if (!prog || typeof prog !== "object") return;
    if (prog.formData && typeof prog.formData === "object") {
      setFormData((prev) => ({ ...prev, ...prog.formData }));
    }
    if (prog.loiData && typeof prog.loiData === "object") {
      setLoiData((prev) => ({ ...prev, ...prog.loiData }));
    }
    if (prog.retrievalData && typeof prog.retrievalData === "object") {
      setRetrievalData((prev) => ({ ...prev, ...prog.retrievalData }));
    }
    if (typeof prog.currentStep === "number") setCurrentStep(prog.currentStep);
    if (typeof prog.openCardIndex === "number") setOpenCardIndex(prog.openCardIndex);
    if (Array.isArray(prog.examQuestions)) setExamQuestions(prog.examQuestions);
    if (prog.answers && typeof prog.answers === "object") setAnswers(prog.answers);
    if (typeof prog.score === "number") setScore(prog.score);
    if (prog.activeRecord && typeof prog.activeRecord === "object") setActiveRecord(prog.activeRecord);
    if (typeof prog.courseAudioEnabled === "boolean") setCourseAudioEnabledState(prog.courseAudioEnabled);
    if (typeof prog.pmesPaused === "boolean") setPmesPaused(prog.pmesPaused);
    if (typeof prog.appState === "string" && RESUMABLE_APP_STATES.has(prog.appState)) {
      lastFlowAppStateRef.current = prog.appState;
    }
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured) {
      if (import.meta.env.DEV) {
        console.info(
          "[PMES] Set VITE_FIREBASE_API_KEY and VITE_FIREBASE_PROJECT_ID in frontend/.env for Email/Password auth and Firestore.",
        );
      }
      setAuthReady(true);
      return undefined;
    }

    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (!u) {
        memberSyncOncePerUidRef.current = null;
        hydratingRef.current = false;
        setPmesPaused(false);
        lastFlowAppStateRef.current = null;
        const api = (import.meta.env.VITE_API_BASE_URL || "").trim();
        if (api) {
          const staff = readStaffSession();
          if (staff) {
            try {
              const records = await PmesService.fetchAdminRecords(staff.token);
              setStaffAccessToken(staff.token);
              setStaffRole(staff.role);
              setStaffDbRole(staff.dbRole ?? null);
              setStaffSessionEmail(staff.email);
              setMasterList(records);
              if (staff.role === "superuser") {
                try {
                  const admins = await PmesService.listStaffAdmins(staff.token);
                  setManagedStaffAdmins(Array.isArray(admins) ? admins : []);
                } catch {
                  setManagedStaffAdmins([]);
                }
              } else {
                setManagedStaffAdmins([]);
              }
              setAppState("admin_dashboard");
              setAuthReady(true);
              return;
            } catch {
              clearStaffSession();
            }
          }
        }
        setStaffAccessToken(null);
        setStaffRole(null);
        setStaffDbRole(null);
        setStaffSessionEmail(null);
        setManagedStaffAdmins([]);
        setStaffPasswordPanelOpen(false);
        setAdminAccountsPanelOpen(false);
        setAppState("landing");
        setAuthReady(true);
        return;
      }

      /** Keep staff JWT in sessionStorage when a member Firebase session is active so admins can use Home then return to the admin portal without signing in again. */

      const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").trim();
      if (apiBaseUrl) {
        const sid = u.uid;
        if (memberSyncOncePerUidRef.current !== sid) {
          memberSyncOncePerUidRef.current = sid;
          await syncMemberToPostgres(u, u.displayName?.trim() || undefined);
        }
      }

      hydratingRef.current = true;

      const pending = pendingAfterAuthRef.current;
      if (pending === "retrieval") {
        pendingAfterAuthRef.current = null;
        setRetrievalData((d) => ({ ...d, email: u.email || d.email }));
        setPmesPaused(false);
        setAppState("login_retrieval");
        hydratingRef.current = false;
        setAuthReady(true);
        return;
      }

      const pioneerIntent = pending === "pioneer_portal";
      if (pioneerIntent) {
        pendingAfterAuthRef.current = null;
        setPmesPaused(false);
      }

      /** Imported pioneers: DB already reflects PMES / LOI / fees / board — never resume PMES from Firestore. */
      if (apiBaseUrl && u.email) {
        try {
          const life = await PmesService.fetchMembershipLifecycle(u.email);
          setMembershipLifecycle(life);
          if (life?.isLegacyFounderImport) {
            if (life.canAccessFullMemberPortal) {
              setAppState("member_portal");
            } else {
              setAppState("member_pending");
            }
            hydratingRef.current = false;
            setAuthReady(true);
            return;
          }
        } catch {
          if (pioneerIntent) {
            setAppState("member_pending");
            hydratingRef.current = false;
            setAuthReady(true);
            return;
          }
        }
      }

      try {
        const prog = await loadPmesProgress(db, appId, u.uid);
        if (prog && typeof prog === "object") {
          applyLoadedProgress(prog);
          const saved = prog.appState;
          if (prog.pmesPaused && typeof saved === "string" && RESUMABLE_APP_STATES.has(saved)) {
            setAppState("landing");
          } else if (typeof saved === "string") {
            if (saved === "login_retrieval") {
              setAppState("login_retrieval");
            } else if (saved === "landing") {
              setAppState("landing");
            } else if (saved === "payment_portal") {
              setAppState("payment_portal");
            } else if (saved === "coop_store") {
              setAppState("coop_store");
            } else if (RESUMABLE_APP_STATES.has(saved)) {
              if (saved === "registration" && isParticipantProfileComplete(prog.formData)) {
                setAppState("seminar");
              } else {
                setAppState(saved);
              }
            }
          }
        } else if (appStateRef.current === "login" || appStateRef.current === "member_auth") {
          setAppState("landing");
        }
      } catch {
        if (appStateRef.current === "login" || appStateRef.current === "member_auth") {
          setAppState("landing");
        }
      } finally {
        hydratingRef.current = false;
        setAuthReady(true);
      }
    });

    return unsub;
  }, [applyLoadedProgress]);

  /**
   * After refresh (or first paint) with a Firebase user, rehydrate staff JWT from sessionStorage into React state.
   * Staff session is no longer cleared on Firebase sign-in, so this keeps admin tools available without re-login.
   */
  useEffect(() => {
    if (!authReady) return;
    const api = (import.meta.env.VITE_API_BASE_URL || "").trim();
    if (!api || !user) return;
    if (staffAccessToken) return;
    const staff = readStaffSession();
    if (!staff) return;

    let cancelled = false;
    (async () => {
      try {
        const records = await PmesService.fetchAdminRecords(staff.token);
        if (cancelled) return;
        setStaffAccessToken(staff.token);
        setStaffRole(staff.role);
        setStaffDbRole(staff.dbRole ?? null);
        setStaffSessionEmail(staff.email);
        setMasterList(Array.isArray(records) ? records : []);
        if (staff.role === "superuser") {
          try {
            const admins = await PmesService.listStaffAdmins(staff.token);
            if (!cancelled) setManagedStaffAdmins(Array.isArray(admins) ? admins : []);
          } catch {
            if (!cancelled) setManagedStaffAdmins([]);
          }
        } else if (!cancelled) {
          setManagedStaffAdmins([]);
        }
      } catch {
        clearStaffSession();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authReady, user, staffAccessToken]);

  useEffect(() => {
    if (appState === "loi_success") {
      lastFlowAppStateRef.current = null;
      return;
    }
    if (RESUMABLE_APP_STATES.has(appState)) {
      lastFlowAppStateRef.current = appState;
    }
  }, [appState]);

  /**
   * Staff login fields only belong on `admin_login`. Clear when navigating anywhere else so credentials
   * cannot linger in memory while members use PMES (and so no code path can reuse them accidentally).
   */
  useEffect(() => {
    if (appState === "admin_login") return;
    setAdminCreds({ email: "", password: "" });
  }, [appState]);

  useEffect(() => {
    if (!authReady || !user || !isFirebaseConfigured) return undefined;
    if (hydratingRef.current) return undefined;
    if (appState === "member_auth" || appState === "admin_login" || appState === "admin_dashboard") return undefined;

    const persistStates = new Set([...RESUMABLE_APP_STATES, "landing", "login_retrieval", "payment_portal", "coop_store"]);
    if (!persistStates.has(appState)) return undefined;

    const id = window.setTimeout(() => {
      if (hydratingRef.current) return;
      const effectiveAppState =
        appState === "landing"
          ? pmesPaused
            ? lastFlowAppStateRef.current || "seminar"
            : lastFlowAppStateRef.current || "landing"
          : appState;
      const snapshot = {
        appState: effectiveAppState,
        pmesPaused: appState === "landing" ? pmesPaused : false,
        currentStep,
        openCardIndex,
        formData,
        loiData,
        retrievalData,
        examQuestions,
        answers,
        score,
        activeRecord,
        courseAudioEnabled,
        accountEmail: user.email || null,
      };
      void savePmesProgress(db, appId, user.uid, snapshot);
    }, 700);
    return () => window.clearTimeout(id);
  }, [
    authReady,
    user,
    appState,
    currentStep,
    openCardIndex,
    formData,
    loiData,
    retrievalData,
    examQuestions,
    answers,
    score,
    activeRecord,
    courseAudioEnabled,
    pmesPaused,
  ]);

  useEffect(() => {
    if (appState !== "registration" || !user?.email) return;
    setFormData((prev) => ({ ...prev, email: user.email || prev.email }));
  }, [appState, user]);

  /** After pioneer reclaim, prefill member auth + roster fields; membership form reads `b2c_pioneer_membership_prefill`. */
  useEffect(() => {
    if (appState !== "member_auth") return;
    try {
      const raw = sessionStorage.getItem("b2c_pioneer_prefill");
      if (!raw) return;
      const p = JSON.parse(raw);
      sessionStorage.removeItem("b2c_pioneer_prefill");
      const email = typeof p.email === "string" ? p.email.trim() : "";
      const pioneerClaim = p.pioneerClaim === true;
      const fn = typeof p.firstName === "string" ? p.firstName : "";
      const mn = typeof p.middleName === "string" ? p.middleName : "";
      const ln = typeof p.lastName === "string" ? p.lastName : "";
      const tin = typeof p.tinNo === "string" ? p.tinNo : "";
      if (email) {
        setSignUp((s) => ({
          ...s,
          email,
          ...(fn ? { firstName: fn } : {}),
          ...(mn !== undefined ? { middleName: mn } : {}),
          ...(ln ? { lastName: ln } : {}),
        }));
        setLogIn((l) => ({ ...l, email }));
      }
      if (pioneerClaim && email) {
        setPioneerClaimAuthActive(true);
        try {
          sessionStorage.setItem(
            "b2c_pioneer_membership_prefill",
            JSON.stringify({
              firstName: fn,
              middleName: mn,
              lastName: ln,
              tinNo: tin,
            }),
          );
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }, [appState]);

  useEffect(() => {
    if (appState === "member_auth") return;
    setPioneerClaimAuthActive(false);
  }, [appState]);

  /** LOI header shows formData name/email — fill gaps when opening from member portal (user may skip registration PMES form). */
  useEffect(() => {
    if (appState !== "loi_form" || !user) return;
    setFormData((prev) => {
      let email = String(prev.email || "").trim();
      if (!email && user.email) email = user.email;

      let fullName = String(prev.fullName || "").trim();
      if (!fullName) {
        const fromParts = composeFullName(prev.firstName, prev.middleName, prev.lastName);
        if (fromParts) fullName = fromParts;
      }
      if (!fullName && activeRecord?.fullName) fullName = String(activeRecord.fullName).trim();
      if (!fullName && user.displayName) fullName = String(user.displayName).trim();

      if (email === String(prev.email || "").trim() && fullName === String(prev.fullName || "").trim()) return prev;
      return { ...prev, email, fullName };
    });
  }, [appState, user, activeRecord]);

  useEffect(() => {
    if (!ttsError) return undefined;
    const id = setTimeout(() => setTtsError(null), 12000);
    return () => clearTimeout(id);
  }, [ttsError]);

  /** Initialize editable fields when admin opens member registry detail. */
  useEffect(() => {
    if (!registryDetail || typeof registryDetail !== "object") {
      setRegistryProfileDraft(null);
      return;
    }
    const reg = /** @type {Record<string, unknown> | undefined} */ (registryDetail).registry;
    if (!reg || typeof reg !== "object") {
      setRegistryProfileDraft(null);
      return;
    }
    const g = /** @type {Record<string, unknown>} */ (reg);
    setRegistryProfileDraft({
      fullName: String(g.fullName ?? ""),
      email: String(g.email ?? ""),
      phone: String(g.phone ?? ""),
      dob: String(g.dob ?? ""),
      gender: String(g.gender ?? ""),
      tinNo: String(g.tinNo ?? ""),
      mailingAddress: String(g.mailingAddress ?? ""),
      civilStatus: String(g.civilStatus ?? ""),
    });
    setMemberResetPwd({ newPassword: "", confirm: "" });
  }, [registryDetail]);

  useEffect(() => {
    const r =
      registryDetail && typeof registryDetail === "object"
        ? /** @type {Record<string, unknown>} */ (registryDetail).registry
        : null;
    const sr = r && typeof r === "object" && r.staffRole != null ? String(r.staffRole) : "";
    if (
      sr &&
      [
        "ADMIN",
        "TREASURER",
        "SECRETARY",
        "BOARD_DIRECTOR",
        "CHAIRMAN",
        "VICE_CHAIRMAN",
        "GENERAL_MANAGER",
        "SUPERUSER",
      ].includes(sr)
    ) {
      setRegistryStaffRoleSelect(sr === "SUPERUSER" ? "ADMIN" : sr);
    } else {
      setRegistryStaffRoleSelect("ADMIN");
    }
  }, [registryDetail]);

  const setCourseAudioEnabled = (enabled) => {
    if (!enabled) {
      currentAudio.current?.pause();
      setIsSpeaking(false);
      setSpeakingTtsKey(null);
    }
    setCourseAudioEnabledState(enabled);
    writeCourseAudioPreference(enabled);
  };

  const pauseTts = useCallback(() => {
    currentAudio.current?.pause();
    setIsSpeaking(false);
    setSpeakingTtsKey(null);
  }, []);

  const playTts = async (text, cacheKey) => {
    if (isSpeaking) {
      pauseTts();
      return;
    }
    setTtsError(null);
    setLoadingTtsKey(cacheKey);
    try {
      const wavUrl = await ensureTtsUrl(text, cacheKey);
      const audio = await preloadAudioUrl(wavUrl);
      currentAudio.current = audio;
      audio.onended = () => {
        setIsSpeaking(false);
        setSpeakingTtsKey(null);
      };
      setSpeakingTtsKey(cacheKey);
      setIsSpeaking(true);
      await audio.play();
    } catch (err) {
      setTtsError(formatTtsError(err));
      setIsSpeaking(false);
      setSpeakingTtsKey(null);
    } finally {
      setLoadingTtsKey(null);
    }
  };

  const refreshMembershipLifecycle = useCallback(async () => {
    const api = (import.meta.env.VITE_API_BASE_URL || "").trim();
    if (!api || !user?.email) {
      setMembershipLifecycle(null);
      return null;
    }
    setMembershipLoading(true);
    try {
      const row = await PmesService.fetchMembershipLifecycle(user.email);
      setMembershipLifecycle(row);
      return row;
    } catch {
      const err = { stage: "UNKNOWN", canAccessFullMemberPortal: false };
      setMembershipLifecycle(err);
      return err;
    } finally {
      setMembershipLoading(false);
    }
  }, [user?.email]);

  const handleFinishExam = async () => {
    setLoading(true);
    setError(null);
    const correct = examQuestions.reduce((sum, question, index) => sum + Number(answers[index] === question.c), 0);
    setScore(correct);
    try {
      const saved = await PmesService.saveRecord(db, appId, user, { ...formData, score: correct, passed: correct >= 7 });
      const recordId = saved?.id;
      setActiveRecord({
        ...formData,
        score: correct,
        id: recordId ?? `local-${Date.now()}`,
        passed: correct >= 7,
        timestamp: new Date().toISOString(),
      });
      if ((import.meta.env.VITE_API_BASE_URL || "").trim()) {
        void refreshMembershipLifecycle();
      }
      setAppState("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed. Check all fields and API connection.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!authReady || !user?.email || !(import.meta.env.VITE_API_BASE_URL || "").trim()) return;
    void refreshMembershipLifecycle();
  }, [authReady, user?.email, refreshMembershipLifecycle]);

  const coopStoreExternalUrl = (import.meta.env.VITE_COOP_STORE_URL ?? "").trim();

  useEffect(() => {
    if (!user?.email) return;
    if (sessionStorage.getItem("b2ccoop_open_coop_store") !== "1") return;
    sessionStorage.removeItem("b2ccoop_open_coop_store");
    if (coopStoreExternalUrl) {
      window.open(coopStoreExternalUrl, "_blank", "noopener,noreferrer");
      return;
    }
    setAppState("coop_store");
  }, [user?.email, coopStoreExternalUrl]);

  const openCoopStore = useCallback(() => {
    if (user?.email) {
      if (coopStoreExternalUrl) {
        window.open(coopStoreExternalUrl, "_blank", "noopener,noreferrer");
        return;
      }
      setAppState("coop_store");
      return;
    }
    sessionStorage.setItem("b2ccoop_open_coop_store", "1");
    setMemberAuthMode("login");
    setAppState("member_auth");
  }, [user?.email, coopStoreExternalUrl]);

  const coopStoreBackTarget = useCallback(() => {
    if (membershipLifecycle?.canAccessFullMemberPortal) return "member_portal";
    if (user?.email) return "member_pending";
    if (staffAccessToken) return "admin_dashboard";
    return "landing";
  }, [membershipLifecycle?.canAccessFullMemberPortal, user?.email, staffAccessToken]);

  useEffect(() => {
    if (!adminToast) return undefined;
    const id = setTimeout(() => setAdminToast(null), 9000);
    return () => clearTimeout(id);
  }, [adminToast]);

  const refreshMembershipPipelineRows = useCallback(async () => {
    if (!staffAccessToken) return [];
    const rows = await PmesService.fetchMembershipPipeline(staffAccessToken);
    const list = Array.isArray(rows) ? rows : [];
    setMembershipPipeline(list);
    return list;
  }, [staffAccessToken]);

  const afterPipelineMutation = useCallback(async () => {
    const list = await refreshMembershipPipelineRows();
    setPipelineDetailRow((prev) => {
      if (!prev) return null;
      const id = String(prev.participantId);
      const next = list.find((x) => String(x.participantId) === id);
      return next ?? null;
    });
  }, [refreshMembershipPipelineRows]);

  useEffect(() => {
    if (!staffAccessToken) return;
    if (appState !== "admin_dashboard" && appState !== "landing") return;
    let cancelled = false;
    void PmesService.fetchMembershipPipeline(staffAccessToken)
      .then((rows) => {
        if (!cancelled) setMembershipPipeline(Array.isArray(rows) ? rows : []);
      })
      .catch((e) => {
        if (!cancelled) {
          setMembershipPipeline([]);
          const status =
            e && typeof e === "object" && "pmesHttpStatus" in e
              ? Number(/** @type {{ pmesHttpStatus?: number }} */ (e).pmesHttpStatus)
              : NaN;
          const msg = e instanceof Error ? e.message : String(e);
          if (status === 401) {
            clearStaffSession();
            setStaffAccessToken(null);
            setStaffRole(null);
            setStaffDbRole(null);
            setStaffSessionEmail(null);
            setStaffPasswordPanelOpen(false);
            setAdminAccountsPanelOpen(false);
            setAdminToast({
              type: "error",
              message: "Admin session expired or invalid. Sign in to the admin portal again.",
            });
          } else if (appState === "admin_dashboard") {
            setAdminToast({
              type: "error",
              message: msg?.trim() || "Membership pipeline could not be loaded.",
            });
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, [appState, staffAccessToken]);

  useEffect(() => {
    if (appState !== "admin_dashboard") setPipelineDetailRow(null);
  }, [appState]);

  useEffect(() => {
    if (appState !== "admin_dashboard" || !staffAccessToken) return;
    let cancelled = false;
    setRegistryLoading(true);
    void PmesService.fetchMemberRegistry(staffAccessToken, {
      q: registryAppliedSearch,
      page: registryPage,
      pageSize: REGISTRY_PAGE_SIZE,
      includeAll: registryIncludeAll,
    })
      .then((data) => {
        if (cancelled) return;
        setRegistryRows(Array.isArray(data?.rows) ? data.rows : []);
        setRegistryTotal(typeof data?.total === "number" ? data.total : 0);
      })
      .catch(() => {
        if (!cancelled) {
          setRegistryRows([]);
          setRegistryTotal(0);
        }
      })
      .finally(() => {
        if (!cancelled) setRegistryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appState, staffAccessToken, registryAppliedSearch, registryIncludeAll, registryPage, registryRefreshNonce]);

  const handleLoiSubmit = async () => {
    if (!loiData.address || !loiData.occupation || !loiData.initialCapital || !loiData.agreement) {
      setError("Please complete all fields.");
      return;
    }
    setLoading(true);
    try {
      await PmesService.saveLoi(db, appId, user, {
        ...formData,
        ...loiData,
        ...(activeRecord?.id != null ? { pmesRecordId: activeRecord.id } : {}),
      });
      void refreshMembershipLifecycle();
      setAppState("loi_success");
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : typeof e === "string" ? e : "Submission failed.";
      console.error("[LOI submit]", e);
      setError(msg?.trim() || "Submission failed.");
    } finally {
      setLoading(false);
    }
  };

  const hydrateStaffDashboardFromToken = useCallback(async (accessToken, role, emailForStaff, dbRole, preloadedRecords) => {
    const records =
      preloadedRecords != null
        ? preloadedRecords
        : await PmesService.fetchAdminRecords(accessToken);
    setMasterList(Array.isArray(records) ? records : []);
    setStaffAccessToken(accessToken);
    setStaffRole(role);
    setStaffDbRole(dbRole ?? null);
    const em = String(emailForStaff ?? "").trim();
    setStaffSessionEmail(em);
    persistStaffSession(accessToken, role, em, dbRole ?? null);
    setAdminCreds({ email: "", password: "" });
    if (role === "superuser") {
      try {
        const admins = await PmesService.listStaffAdmins(accessToken);
        setManagedStaffAdmins(Array.isArray(admins) ? admins : []);
      } catch {
        setManagedStaffAdmins([]);
      }
    } else {
      setManagedStaffAdmins([]);
    }
    setStaffPasswordPanelOpen(false);
    setAdminAccountsPanelOpen(false);
    setAppState("admin_dashboard");
  }, []);

  const resetStaffPortalToPasswordForm = useCallback((prefillEmail = "") => {
    clearStaffSession();
    setStaffAccessToken(null);
    setStaffRole(null);
    setStaffDbRole(null);
    setStaffSessionEmail(null);
    setManagedStaffAdmins([]);
    setNewStaffAdmin({ email: "", password: "" });
    setStaffAdminError(null);
    setStaffPasswordForm({ currentPassword: "", newPassword: "" });
    setStaffPasswordError(null);
    setStaffPasswordSuccess(null);
    setStaffPasswordPanelOpen(false);
    setAdminAccountsPanelOpen(false);
    setAdminCreds({ email: prefillEmail, password: "" });
    setAppState("admin_login");
  }, []);

  const handleAdminPortal = () => {
    setError(null);
    const useApi = Boolean((import.meta.env.VITE_API_BASE_URL || "").trim());
    if (!useApi) {
      resetStaffPortalToPasswordForm("");
      return;
    }
    if (adminPortalNavInFlightRef.current) return;
    adminPortalNavInFlightRef.current = true;
    setLoading(true);

    void (async () => {
      try {
        const existing = readStaffSession();
        if (existing?.token) {
          try {
            await hydrateStaffDashboardFromToken(existing.token, existing.role, existing.email, existing.dbRole);
            return;
          } catch {
            clearStaffSession();
          }
        }

        const u = user ?? auth.currentUser;
        const withEmail = u?.email?.trim();
        if (withEmail) {
          try {
            const idToken = await u.getIdToken();
            const session = await PmesService.staffSessionFromFirebase(idToken);
            const staffEmail = String(session?.email ?? withEmail).trim();
            await hydrateStaffDashboardFromToken(
              session.accessToken,
              session.role,
              staffEmail,
              session.dbRole != null ? String(session.dbRole) : null,
            );
            return;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const noStaff =
              /\b404\b/i.test(msg) ||
              msg.toLowerCase().includes("no cooperative staff account") ||
              msg.toLowerCase().includes("no staff account");
            resetStaffPortalToPasswordForm(withEmail);
            if (noStaff) {
              setError(
                "No cooperative staff profile on this Google email yet. Sign in with staff email and password below, or ask a superuser to create your admin account.",
              );
            } else {
              setError(msg?.trim() || "Could not open the admin portal with your Google sign-in.");
            }
            return;
          }
        }

        resetStaffPortalToPasswordForm("");
      } finally {
        adminPortalNavInFlightRef.current = false;
        setLoading(false);
      }
    })();
  };

  const handleAdminLoginSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    const useApi = Boolean((import.meta.env.VITE_API_BASE_URL || "").trim());
    if (!useApi) {
      setError("Set VITE_API_BASE_URL (e.g. http://localhost:3000) in frontend/.env for admin sign-in.");
      return;
    }
    const email = String(adminCreds.email ?? "").trim();
    const password = String(adminCreds.password ?? "");
    if (!email || !password.trim()) {
      setError("Enter staff email and password.");
      return;
    }
    if (adminLoginInFlightRef.current) return;
    adminLoginInFlightRef.current = true;
    setLoading(true);
    try {
      const result = await PmesService.getAllRecords(db, appId, { email, password });
      await hydrateStaffDashboardFromToken(
        result.accessToken,
        result.role,
        email,
        result.dbRole != null ? String(result.dbRole) : null,
        result.records,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Admin sign-in failed.");
    } finally {
      adminLoginInFlightRef.current = false;
      setLoading(false);
    }
  };

  const handleCreateStaffAdminSubmit = async (event) => {
    event.preventDefault();
    if (!staffAccessToken || staffRole !== "superuser") return;
    setStaffAdminError(null);
    if (!newStaffAdmin.email?.trim() || (newStaffAdmin.password?.length ?? 0) < 8) {
      setStaffAdminError("Enter an email and a password of at least 8 characters.");
      return;
    }
    setLoading(true);
    try {
      await PmesService.createStaffAdmin(staffAccessToken, newStaffAdmin.email.trim(), newStaffAdmin.password);
      setNewStaffAdmin({ email: "", password: "" });
      const admins = await PmesService.listStaffAdmins(staffAccessToken);
      setManagedStaffAdmins(Array.isArray(admins) ? admins : []);
    } catch (e) {
      setStaffAdminError(e instanceof Error ? e.message : "Could not create admin.");
    } finally {
      setLoading(false);
    }
  };

  const handlePromoteAdminToSuperuser = async (adminEmail) => {
    if (!staffAccessToken || staffRole !== "superuser") return;
    const email = String(adminEmail ?? "").trim().toLowerCase();
    if (!email) return;
    const confirmed = window.confirm(
      `Promote ${email} to superuser? They will be able to manage admin accounts and destructive admin actions.`,
    );
    if (!confirmed) return;
    setStaffAdminError(null);
    setLoading(true);
    try {
      await PmesService.promoteStaffToSuperuser(staffAccessToken, email);
      const admins = await PmesService.listStaffAdmins(staffAccessToken);
      setManagedStaffAdmins(Array.isArray(admins) ? admins : []);
      window.alert(`Promoted ${email} to superuser.`);
    } catch (e) {
      setStaffAdminError(e instanceof Error ? e.message : "Could not promote admin.");
    } finally {
      setLoading(false);
    }
  };

  const handleChangeStaffPasswordSubmit = async (event) => {
    event.preventDefault();
    if (!staffAccessToken) return;
    setStaffPasswordError(null);
    setStaffPasswordSuccess(null);
    const currentPassword = String(staffPasswordForm.currentPassword ?? "");
    const newPassword = String(staffPasswordForm.newPassword ?? "");
    if (currentPassword.length < 8 || newPassword.length < 8) {
      setStaffPasswordError("Current and new password must both be at least 8 characters.");
      return;
    }
    setLoading(true);
    try {
      await PmesService.changeOwnStaffPassword(staffAccessToken, currentPassword, newPassword);
      setStaffPasswordForm({ currentPassword: "", newPassword: "" });
      setStaffPasswordSuccess("Password updated successfully.");
    } catch (e) {
      setStaffPasswordError(e instanceof Error ? e.message : "Could not update password.");
    } finally {
      setLoading(false);
    }
  };

  const handleDeletePipelineParticipant = async (row) => {
    if (!staffAccessToken || staffRole !== "superuser" || !row?.participantId) return;
    const email = String(row.email ?? "").trim() || "this participant";
    if (
      !window.confirm(
        `Permanently remove ${email} from the database (all PMES attempts and LOI for this account)? This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeletingPipelineParticipantId(String(row.participantId));
    try {
      await PmesService.deleteParticipant(staffAccessToken, row.participantId);
      setMembershipPipeline((list) =>
        Array.isArray(list) ? list.filter((r) => String(r.participantId) !== String(row.participantId)) : [],
      );
      setPipelineDetailRow((p) =>
        p && String(p.participantId) === String(row.participantId) ? null : p,
      );
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeletingPipelineParticipantId(null);
    }
  };

  const handleDeleteMasterListRow = async (item) => {
    if (!staffAccessToken || staffRole !== "superuser" || !item?.id) return;
    const name = String(item.fullName ?? "this participant").trim() || "this participant";
    if (!window.confirm(`Remove the PMES master list row for ${name}? This cannot be undone.`)) return;
    setDeletingMasterListId(item.id);
    try {
      await PmesService.deletePmesRecord(staffAccessToken, item.id);
      setMasterList((list) => list.filter((r) => r.id !== item.id));
      if (activeRecord?.id === item.id) {
        setActiveRecord(null);
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeletingMasterListId(null);
    }
  };

  const handleRetrieval = async () => {
    setLoading(true);
    setError(null);
    const useApi = Boolean((import.meta.env.VITE_API_BASE_URL || "").trim());
    if (!useApi && !user) {
      setError("Sign in with your member email and password, then try again.");
      setLoading(false);
      return;
    }
    try {
      const record = await PmesService.findRecord(db, appId, retrievalData.email, retrievalData.dob, user);
      if (record?.passed) {
        setActiveRecord(record);
        setAppState("certificate");
      } else {
        setError(record ? "Passing record not found." : "Record not found.");
      }
    } catch {
      setError("Lookup failed. Check connection or try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch {
      /* ignore */
    }
    setPmesPaused(false);
    setMembershipLifecycle(null);
    setAppState("landing");
  };

  const switchMemberAuthMode = (mode) => {
    if (mode === "signup" && logIn.email.trim()) {
      setSignUp((s) => ({ ...s, email: logIn.email }));
    }
    if (mode === "login" && signUp.email.trim()) {
      setLogIn((l) => ({ ...l, email: signUp.email }));
    }
    setMemberAuthMode(mode);
    setError(null);
    setForgotPasswordNotice(null);
  };

  const handleSignUpSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    if (!isFirebaseConfigured) {
      setError("Firebase is not configured. Add VITE_FIREBASE_* keys in frontend/.env.");
      return;
    }
    const fn = signUp.firstName.trim();
    const ln = signUp.lastName.trim();
    const mn = signUp.middleName.trim();
    const email = signUp.email.trim();
    const pioneerSignup = pioneerClaimAuthActive;

    if (!fn || !ln) {
      setError("First name and last name are required.");
      return;
    }
    if (!email || !signUp.password) {
      setError("Email and password are required.");
      return;
    }
    if (signUp.password !== signUp.confirm) {
      setError("Passwords do not match.");
      return;
    }

    let phone = signUp.phone.trim();
    let addr = signUp.residenceAddress.trim();
    let dob = signUp.dob;
    if (!pioneerSignup) {
      if (!dob) {
        setError("Date of birth is required.");
        return;
      }
      if (!phone) {
        setError("Mobile number is required.");
        return;
      }
      if (!addr) {
        setError("Residence address is required.");
        return;
      }
    } else {
      if (!phone) phone = "+639000000000";
      if (!addr) addr = "(Complete in membership profile)";
      if (!dob) dob = "1900-01-01";
    }

    const fullName = composeFullName(fn, mn, ln);
    setLoading(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, signUp.password);
      await cred.user.getIdToken(true);
      await updateProfile(cred.user, { displayName: fullName }).catch(() => null);
      if (import.meta.env.VITE_API_BASE_URL?.trim()) {
        void syncMemberToPostgres(cred.user, fullName);
      }
      setFormData((prev) => ({
        ...prev,
        email,
        firstName: fn,
        middleName: mn,
        lastName: ln,
        fullName,
        phone,
        dob,
        residenceAddress: addr,
      }));
      setLogIn({ email, password: "" });
      setPmesPaused(false);
      queueSignupLiveActivityFromDevice();

      if (pioneerSignup) {
        setPioneerClaimAuthActive(false);
        try {
          const life = await PmesService.fetchMembershipLifecycle(email);
          setMembershipLifecycle(life);
          if (life?.isLegacyFounderImport) {
            setAppState(life.canAccessFullMemberPortal ? "member_portal" : "member_pending");
          } else {
            setAppState("member_pending");
          }
        } catch {
          setAppState("member_pending");
        }
        return;
      }

      setAppState("consent");
    } catch (err) {
      setError(mapFirebaseAuthError(err?.code));
    } finally {
      setLoading(false);
    }
  };

  const handleLoginSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    setForgotPasswordNotice(null);
    if (!isFirebaseConfigured) {
      setError("Firebase is not configured.");
      return;
    }
    const raw = logIn.email.trim();
    setLoading(true);
    try {
      const resolved = await resolveFirebaseLoginEmail(raw, "signin");
      if (!resolved.ok) {
        setError(resolved.message);
        return;
      }
      await signInWithEmailAndPassword(auth, resolved.email, logIn.password);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
      if (typeof code === "string" && code.startsWith("auth/")) {
        setError(mapFirebaseAuthError(code));
      } else if (err instanceof Error && err.message) {
        setError(err.message);
      } else {
        setError(mapFirebaseAuthError(undefined));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    const raw = logIn.email.trim();
    setError(null);
    setForgotPasswordNotice(null);
    if (!isFirebaseConfigured) {
      setError("Firebase is not configured.");
      return;
    }
    if (!raw) {
      setError("Enter your login email/callsign/member ID first, then tap Forgot password.");
      return;
    }
    setForgotPasswordBusy(true);
    try {
      const resolved = await resolveFirebaseLoginEmail(raw, "forgot");
      if (!resolved.ok) {
        setError(resolved.message);
        return;
      }
      await sendPasswordResetEmail(auth, resolved.email);
      setForgotPasswordNotice(`Password reset email sent to ${resolved.email}. Check your inbox and spam folder.`);
    } catch (err) {
      setError(mapFirebaseAuthError(err?.code));
    } finally {
      setForgotPasswordBusy(false);
    }
  };

  const goHomeFromPmes = () => {
    setPmesPaused(true);
    setAppState("landing");
  };

  const continuePmesFromLanding = () => {
    const sessionUser = user ?? (isFirebaseConfigured ? auth.currentUser : null);
    if (!sessionUser) return;

    hydratingRef.current = true;
    setPmesPaused(false);

    void loadPmesProgress(db, appId, sessionUser.uid)
      .then((prog) => {
        if (prog && typeof prog === "object") {
          applyLoadedProgress({ ...prog, pmesPaused: false });
        }

        const saved = typeof prog?.appState === "string" ? prog.appState : null;
        let next;

        if (saved && RESUMABLE_APP_STATES.has(saved)) {
          next = saved;
          if (next === "registration" && prog?.formData && isParticipantProfileComplete(prog.formData)) {
            next = "seminar";
          }
        } else {
          next = lastFlowAppStateRef.current || "seminar";
          if (next === "registration" && prog?.formData && isParticipantProfileComplete(prog.formData)) {
            next = "seminar";
          }
        }

        setAppState(next);
      })
      .catch(() => {
        setAppState(lastFlowAppStateRef.current || "seminar");
      })
      .finally(() => {
        hydratingRef.current = false;
      });
  };

  const beginJoinAsGuest = useCallback(
    (authMode) => {
      if (!isFirebaseConfigured) return;
      pendingPostAuthUnifiedJoinRef.current = true;
      setMemberAuthMode(authMode);
      setAppState("member_auth");
    },
    [isFirebaseConfigured],
  );

  const goJoinUnified = useCallback(async () => {
    if (!isFirebaseConfigured) return;
    const sessionUser = user ?? (isFirebaseConfigured ? auth.currentUser : null);
    if (!sessionUser) return;
    const api = Boolean((import.meta.env.VITE_API_BASE_URL || "").trim());
    let life = membershipLifecycle;
    if (api && sessionUser.email) {
      life = await refreshMembershipLifecycle();
    }
    const examPassed = Boolean((typeof score === "number" && score >= 7) || activeRecord?.passed === true);
    const intent = derivePmesIntent({
      pmesPaused,
      lastFlowAppState: lastFlowAppStateRef.current,
      pmesExamPassed: examPassed,
    });
    const resumeSuggested = Boolean(sessionUser) && !examPassed && intent.resumeRecommended;
    const plan = planJoinNavigation({
      useApi: api,
      lifecycle: life,
      pmesExamPassed: examPassed,
      resumePmesSuggested: resumeSuggested,
      isLoggedIn: true,
    });
    setPmesPaused(false);
    if (plan.type === "state") {
      setAppState(plan.value);
    } else if (plan.type === "continue_pmes") {
      continuePmesFromLanding();
    }
  }, [
    isFirebaseConfigured,
    user,
    membershipLifecycle,
    score,
    activeRecord,
    pmesPaused,
    refreshMembershipLifecycle,
    continuePmesFromLanding,
  ]);

  useEffect(() => {
    if (!authReady || !user || !pendingPostAuthUnifiedJoinRef.current) return;
    /** Brief delay so Firestore PMES progress can load before we branch the join path. */
    const t = window.setTimeout(() => {
      if (!pendingPostAuthUnifiedJoinRef.current) return;
      pendingPostAuthUnifiedJoinRef.current = false;
      void goJoinUnified();
    }, 450);
    return () => window.clearTimeout(t);
  }, [authReady, user?.uid, goJoinUnified]);

  /** Must run before any early return — same hook order when `authReady` flips from false → true. */
  const staffInboxCounts = useMemo(
    () => countMembershipInboxByStage(membershipPipeline),
    [membershipPipeline],
  );
  const staffInboxSummary = useMemo(
    () => staffPipelineInboxSummary(staffRole, staffInboxCounts, staffDbRole),
    [staffRole, staffInboxCounts, staffDbRole],
  );

  if (!authReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <Loader2 className="h-12 w-12 animate-spin text-[#004aad]" aria-hidden />
      </div>
    );
  }

  /** `auth.currentUser` covers the brief window after sign-up before React `user` state updates. */
  const sessionUser = isFirebaseConfigured ? user ?? auth.currentUser : null;

  /** Staff JWT session: show ribbon on admin dashboard, landing (when staff session retained), and certificate preview without member sign-in. */
  const staffForBanner =
    staffSessionEmail &&
    staffRole &&
    (appState === "admin_dashboard" ||
      (appState === "landing" && staffAccessToken) ||
      (appState === "certificate" && staffAccessToken))
      ? { email: staffSessionEmail, role: staffRole }
      : null;
  /** Ribbon shows first + last only (middle omitted; legacy full names → first token + last token). */
  const memberDisplayNameForBanner =
    displayNameFirstLast(formData, activeRecord?.fullName, user?.displayName) || "Member";

  /** Home + optional Admin portal when a staff JWT is active; on landing, only Admin portal when staff is signed in. */
  const portalHomeBar =
    appState === "landing" && staffAccessToken ? (
      <PortalHomeBar
        variant="adminOnly"
        staffAccessToken={staffAccessToken}
        onGoAdmin={() => setAppState("admin_dashboard")}
      />
    ) : appState !== "landing" && appState !== "admin_dashboard" ? (
      <PortalHomeBar
        onGoHome={() => setAppState("landing")}
        staffAccessToken={staffAccessToken}
        onGoAdmin={() => setAppState("admin_dashboard")}
      />
    ) : null;

  /** Passed PMES: session score or saved API record — hides “Continue PMES” on the landing page when complete. */
  const pmesExamPassed = Boolean(
    user && ((typeof score === "number" && score >= 7) || activeRecord?.passed === true),
  );

  const pmesIntent = derivePmesIntent({
    pmesPaused,
    lastFlowAppState: lastFlowAppStateRef.current,
    pmesExamPassed,
  });

  const resumePmesSuggested = Boolean(user) && !pmesExamPassed && pmesIntent.resumeRecommended;

  const useApiMembership = Boolean((import.meta.env.VITE_API_BASE_URL || "").trim());
  const accessForRibbon = resolveMemberPortalAccess({
    useApi: useApiMembership,
    apiLifecycle: membershipLifecycle,
    pmesExamPassed,
  });

  const joinPipelineBanner =
    sessionUser && appState === "landing"
      ? getJoinPipelineBanner({
          useApi: useApiMembership,
          lifecycle: membershipLifecycle,
          pmesExamPassed,
        })
      : null;
  const landingIdentityLabel =
    typeof membershipLifecycle?.callsign === "string" && String(membershipLifecycle.callsign).trim()
      ? String(membershipLifecycle.callsign).trim()
      : memberDisplayNameForBanner;

  const hidePmesEntry = shouldHidePmesEntry({
    useApi: useApiMembership,
    lifecycle: membershipLifecycle,
    pmesExamPassed,
  });

  const memberIdentityForBanner =
    user && appState !== "member_auth" && !staffForBanner
      ? {
          fullName: memberDisplayNameForBanner,
          email: user.email || String(formData.email || "").trim() || "",
          ribbonStatus: accessForRibbon.ribbonStatus,
          positionLabel:
            typeof membershipLifecycle?.staffPosition === "string" && String(membershipLifecycle.staffPosition).trim()
              ? String(membershipLifecycle.staffPosition).trim()
              : formatMemberPositionLabel(membershipLifecycle?.staffRole),
          callsign:
            typeof membershipLifecycle?.callsign === "string" && String(membershipLifecycle.callsign).trim()
              ? String(membershipLifecycle.callsign).trim()
              : "",
        }
      : null;
  /** Member portal / pending use in-flow identity so the fixed ribbon does not cover the hero on small screens. */
  const memberIdentityFixedRibbon =
    memberIdentityForBanner &&
    appState !== "member_portal" &&
    appState !== "member_pending" &&
    appState !== "landing"
      ? memberIdentityForBanner
      : null;
  const memberPortalIdentityInline =
    (appState === "member_portal" || appState === "member_pending") && memberIdentityForBanner ? (
      <IdentityBanner member={memberIdentityForBanner} staff={null} memberLayout="inline" />
    ) : null;
  const identityRibbon = (
    <IdentityBanner
      member={memberIdentityFixedRibbon}
      staff={appState === "admin_dashboard" ? null : staffForBanner}
    />
  );

  /** Admins preview certificates via API rows — no Firebase member session; do not force the public sign-in gate. */
  const staffBypassMemberAuthGate =
    Boolean(staffAccessToken) && appState === "certificate";

  if (
    isFirebaseConfigured &&
    !sessionUser &&
    MEMBER_AUTH_REQUIRED_STATES.has(appState) &&
    !staffBypassMemberAuthGate
  ) {
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="flex min-h-screen flex-col sm:flex-row">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
          <aside className="relative flex flex-col justify-start overflow-hidden bg-gradient-to-br from-[#004aad] via-[#003d8f] to-slate-900 px-8 py-12 text-white sm:w-[42%] sm:min-h-screen sm:shrink-0 sm:py-12 sm:pl-8 sm:pr-6 md:py-14 md:pl-10 md:pr-8 xl:py-16 xl:pl-14 xl:pr-10">
            <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-white/10 blur-3xl" aria-hidden />
            <div className="pointer-events-none absolute -bottom-16 left-10 h-48 w-48 rounded-full bg-blue-400/20 blur-2xl" aria-hidden />
            <div className="relative z-10 mb-8">
              <B2CLogo size="lg" className="max-w-[min(100%,18rem)] drop-shadow-md md:max-w-[20rem] lg:max-w-[22rem]" />
            </div>
            <p className="relative z-10 text-xs font-black uppercase tracking-[0.25em] text-white/70">B2CCoop WebApp</p>
            <h1 className="relative z-10 mt-4 max-w-md text-3xl font-black leading-tight tracking-tight sm:text-4xl md:text-[2.35rem] md:leading-[1.15]">
              Continue your membership journey
            </h1>
            <p className="relative z-10 mt-4 max-w-sm text-base font-medium leading-relaxed text-white/85">
              Sign in or create one account for the seminar, exam, and digital certificate.
            </p>
            <ul className="relative z-10 mt-8 max-w-sm space-y-3 text-sm font-semibold text-white/90">
              <li className="flex gap-3">
                <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" aria-hidden />
                Privacy notice, then interactive modules
              </li>
              <li className="flex gap-3">
                <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" aria-hidden />
                Assessment &amp; certificate in one place
              </li>
            </ul>
          </aside>
          <div className="flex flex-1 items-center justify-center bg-slate-100/90 px-5 py-10 sm:px-10 sm:bg-[#f1f5f9] sm:py-12">
            <div className="w-full max-w-2xl rounded-[2rem] border border-slate-200/80 bg-white p-8 shadow-xl shadow-slate-900/5 sm:p-10 sm:rounded-[2.25rem]">
              <div className="mb-6 flex justify-center sm:hidden">
                <B2CLogo size="nav" align="center" />
              </div>
              <div className="text-center sm:text-left">
                <p className="text-xs font-black uppercase tracking-widest text-[#004aad]/80">Member access</p>
                <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-900 sm:text-3xl">Continue to PMES</h2>
                <p className="mt-2 text-sm font-medium leading-relaxed text-slate-600 sm:text-base">
                  Use the same email and password you&apos;ll use for certificates and member tools.
                </p>
              </div>
              <div className="mt-8 flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setMemberAuthMode("login");
                    setAppState("member_auth");
                  }}
                  className="btn-primary flex w-full items-center justify-center gap-2 py-4 text-base font-black sm:py-5 sm:text-lg"
                >
                  <LogIn className="h-5 w-5 shrink-0" aria-hidden />
                  Sign in or create account
                </button>
                <button
                  type="button"
                  onClick={() => setAppState("landing")}
                  className="w-full rounded-2xl py-3 text-sm font-bold text-slate-500 transition-colors hover:bg-slate-50 hover:text-[#004aad]"
                >
                  Back to home
                </button>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (registerPath) {
    return (
      <RegisterApp
        initialPath={registerPath}
        onExitToHome={() => {
          setRegisterPath(null);
          if (typeof window !== "undefined") window.history.pushState({}, "", "/");
          setAppState("landing");
        }}
      />
    );
  }

  const tinModal = (
    <TinPromptModal
      open={tinPromptOpen}
      onDismiss={() => {
        setTinDismissedThisView(true);
        setTinPromptOpen(false);
      }}
      onSave={async (tin) => {
        const idToken = await auth.currentUser?.getIdToken();
        await PmesService.patchMemberBasicProfile({ email: user.email, tinNo: tin, idToken });
        await refreshMembershipLifecycle();
        setTinPromptOpen(false);
      }}
    />
  );

  if (appState === "member_auth") {
    const isSignup = memberAuthMode === "signup";
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="animate-in fade-in duration-500 flex min-h-screen flex-col sm:flex-row">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
          <aside className="relative flex flex-col justify-start overflow-hidden bg-gradient-to-br from-[#004aad] via-[#003d8f] to-slate-900 px-8 py-10 text-white sm:w-[42%] sm:min-h-screen sm:shrink-0 sm:py-14 sm:pl-8 sm:pr-6 md:pl-10 md:pr-8 xl:py-16 xl:pl-14 xl:pr-12">
            <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-white/10 blur-3xl" aria-hidden />
            <div className="pointer-events-none absolute bottom-0 left-0 h-56 w-56 rounded-full bg-blue-400/15 blur-2xl" aria-hidden />
            <div className="relative z-10 mb-8">
              <B2CLogo size="lg" className="max-w-[min(100%,18rem)] drop-shadow-md md:max-w-[20rem] lg:max-w-[22rem]" />
            </div>
            <p className="relative z-10 text-xs font-black uppercase tracking-[0.25em] text-white/70">Member account</p>
            <h1 className="relative z-10 mt-4 max-w-lg text-3xl font-black leading-[1.12] tracking-tight sm:text-4xl md:text-[2.5rem] xl:text-[2.75rem]">
              {isSignup ? "Create your cooperative login" : "Welcome back, member"}
            </h1>
            <p className="relative z-10 mt-5 max-w-md text-base font-medium leading-relaxed text-white/88 sm:text-lg">
              {isSignup && pioneerClaimAuthActive
                ? "Create a password for the login email tied to your pioneer roster row. Next: member onboarding and your digital membership form."
                : isSignup
                  ? "One account for PMES modules, your exam, and your certificate. Next: privacy notice, then the seminar."
                  : "Pick up where you left off — modules, exam, certificate, or Letter of Intent."}
            </p>
            <ul className="relative z-10 mt-8 hidden max-w-md space-y-3 text-sm font-semibold leading-snug text-white/90 sm:block">
              <li className="flex gap-3">
                <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" aria-hidden />
                Sign in with email, callsign, or alternate label — same password
              </li>
              <li className="flex gap-3">
                <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" aria-hidden />
                Progress saved so you can resume anytime
              </li>
            </ul>
          </aside>
          <div className="flex flex-1 items-center justify-center bg-slate-100/90 px-4 py-10 sm:px-8 sm:bg-[#f1f5f9] sm:py-12">
            <form
              onSubmit={isSignup ? handleSignUpSubmit : handleLoginSubmit}
              className="w-full max-w-xl rounded-[1.75rem] border border-slate-200/90 bg-white p-7 shadow-xl shadow-slate-900/[0.06] sm:max-w-2xl sm:rounded-[2rem] sm:p-10"
            >
              <div className="mb-5 flex justify-center sm:hidden">
                <B2CLogo size="nav" align="center" />
              </div>
              <div className="text-center sm:text-left">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#004aad]/10 text-[#004aad] sm:mx-0 sm:mb-5 sm:h-14 sm:w-14">
                  {isSignup ? <UserPlus className="h-7 w-7" aria-hidden /> : <Lock className="h-7 w-7" aria-hidden />}
                </div>
                <p className="text-xs font-black uppercase tracking-widest text-[#004aad]/80">
                  {isSignup ? "New registration" : "Member sign-in"}
                </p>
                {isSignup ? (
                  <p className="mt-2 text-sm font-medium text-slate-600">
                    Prefer the official membership form?{" "}
                    <a href="/register" className="font-black text-[#004aad] underline">
                      Apply online
                    </a>
                  </p>
                ) : null}
                <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-900 sm:text-3xl">
                  {isSignup ? "Create your login" : "Log in to continue"}
                </h2>
                {!isSignup ? (
                  <p className="mt-2 text-sm font-medium leading-relaxed text-slate-600 sm:text-base">
                    Resume your PMES, certificate, and member tools.
                  </p>
                ) : null}
              </div>
              <div className="mt-8 flex gap-2 rounded-2xl bg-slate-100 p-1.5">
                <button
                  type="button"
                  onClick={() => switchMemberAuthMode("login")}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-black transition-all ${
                    !isSignup ? "bg-white text-[#004aad] shadow-sm" : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  <LogIn className="h-4 w-4 shrink-0" aria-hidden />
                  Sign in
                </button>
                <button
                  type="button"
                  onClick={() => switchMemberAuthMode("signup")}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-black transition-all ${
                    isSignup ? "bg-white text-[#004aad] shadow-sm" : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  <UserPlus className="h-4 w-4 shrink-0" aria-hidden />
                  Register
                </button>
              </div>
              {error && (
                <div
                  className={`mt-6 rounded-2xl p-4 text-center text-sm font-bold sm:text-base ${isSignup ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-900"}`}
                >
                  {error}
                </div>
              )}
              {!isSignup && forgotPasswordNotice ? (
                <div className="mt-4 rounded-2xl bg-emerald-50 p-4 text-center text-sm font-semibold text-emerald-900 sm:text-base">
                  {forgotPasswordNotice}
                </div>
              ) : null}
              <div className="mt-6 space-y-4 sm:mt-8 sm:space-y-5">
                {isSignup && pioneerClaimAuthActive ? (
                  <>
                    <p className="text-sm font-medium leading-relaxed text-slate-600">
                      Names below are from your pioneer roster check — change only if something was mistyped.
                    </p>
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div className="relative">
                        <User className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
                        <input
                          type="text"
                          name="given-name"
                          autoComplete="given-name"
                          className="input-field !py-[1.1rem] !pl-12 !text-base sm:!text-lg"
                          placeholder="First name"
                          value={signUp.firstName}
                          onChange={(e) => setSignUp((s) => ({ ...s, firstName: e.target.value }))}
                          required
                        />
                      </div>
                      <div className="relative">
                        <User className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
                        <input
                          type="text"
                          name="additional-name"
                          autoComplete="additional-name"
                          className="input-field !py-[1.1rem] !pl-12 !text-base sm:!text-lg"
                          placeholder="Optional middle name"
                          value={signUp.middleName}
                          onChange={(e) => setSignUp((s) => ({ ...s, middleName: e.target.value }))}
                        />
                      </div>
                      <div className="relative">
                        <User className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
                        <input
                          type="text"
                          name="family-name"
                          autoComplete="family-name"
                          className="input-field !py-[1.1rem] !pl-12 !text-base sm:!text-lg"
                          placeholder="Last name"
                          value={signUp.lastName}
                          onChange={(e) => setSignUp((s) => ({ ...s, lastName: e.target.value }))}
                          required
                        />
                      </div>
                    </div>
                  </>
                ) : isSignup ? (
                  <>
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div className="relative">
                        <User className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
                        <input
                          type="text"
                          name="given-name"
                          autoComplete="given-name"
                          className="input-field !py-[1.1rem] !pl-12 !text-base sm:!text-lg"
                          placeholder="First name"
                          value={signUp.firstName}
                          onChange={(e) => setSignUp((s) => ({ ...s, firstName: e.target.value }))}
                          required
                        />
                      </div>
                      <div className="relative">
                        <User className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
                        <input
                          type="text"
                          name="additional-name"
                          autoComplete="additional-name"
                          className="input-field !py-[1.1rem] !pl-12 !text-base sm:!text-lg"
                          placeholder="Optional middle name"
                          value={signUp.middleName}
                          onChange={(e) => setSignUp((s) => ({ ...s, middleName: e.target.value }))}
                        />
                      </div>
                      <div className="relative">
                        <User className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
                        <input
                          type="text"
                          name="family-name"
                          autoComplete="family-name"
                          className="input-field !py-[1.1rem] !pl-12 !text-base sm:!text-lg"
                          placeholder="Last name"
                          value={signUp.lastName}
                          onChange={(e) => setSignUp((s) => ({ ...s, lastName: e.target.value }))}
                          required
                        />
                      </div>
                    </div>
                    <div className="relative">
                      <Phone className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
                      <input
                        type="tel"
                        autoComplete="tel-national"
                        inputMode="tel"
                        className="input-field !py-[1.1rem] !pl-12 !text-base sm:!text-lg"
                        placeholder="Mobile number"
                        value={signUp.phone}
                        onChange={(e) => setSignUp((s) => ({ ...s, phone: e.target.value }))}
                        required
                      />
                    </div>
                    <div className="relative">
                      <Calendar className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
                      <input
                        type="date"
                        className="input-field !py-[1.1rem] !pl-12 !text-base sm:!text-lg"
                        value={signUp.dob}
                        onChange={(e) => setSignUp((s) => ({ ...s, dob: e.target.value }))}
                        required
                      />
                    </div>
                    <div className="relative">
                      <MapPin className="pointer-events-none absolute left-4 top-4 h-5 w-5 text-slate-400" aria-hidden />
                      <textarea
                        autoComplete="street-address"
                        className="input-field min-h-[5.5rem] resize-y !py-[1rem] !pl-12 !text-base sm:!text-lg"
                        placeholder="Residence address"
                        rows={3}
                        value={signUp.residenceAddress}
                        onChange={(e) => setSignUp((s) => ({ ...s, residenceAddress: e.target.value }))}
                        required
                      />
                    </div>
                  </>
                ) : null}
                {pioneerClaimAuthActive ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left">
                    <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Login email (assigned for your import)</p>
                    <p className="mt-1 break-all font-mono text-sm font-bold text-slate-900">{isSignup ? signUp.email : logIn.email}</p>
                    <p className="mt-2 text-xs font-medium leading-relaxed text-slate-600">
                      You won&apos;t use this address for mail — add your real email on the membership form after sign-in.
                    </p>
                  </div>
                ) : (
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
                    <input
                      type={isSignup ? "email" : "text"}
                      autoComplete={isSignup ? "email" : "username"}
                      className="input-field !py-[1.1rem] !pl-12 !text-base sm:!text-lg"
                      placeholder={
                        isSignup ? "Email address" : "Email, callsign, or label (e.g. delacruz-2)"
                      }
                      value={isSignup ? signUp.email : logIn.email}
                      onChange={(e) =>
                        isSignup
                          ? setSignUp((s) => ({ ...s, email: e.target.value }))
                          : setLogIn((l) => ({ ...l, email: e.target.value }))
                      }
                      required
                    />
                  </div>
                )}
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
                  <input
                    type="password"
                    autoComplete={isSignup ? "new-password" : "current-password"}
                    className="input-field !py-[1.1rem] !pl-12 !text-base sm:!text-lg"
                    placeholder={isSignup ? "Password (6+ characters)" : "Password"}
                    value={isSignup ? signUp.password : logIn.password}
                    onChange={(e) =>
                      isSignup
                        ? setSignUp((s) => ({ ...s, password: e.target.value }))
                        : setLogIn((l) => ({ ...l, password: e.target.value }))
                    }
                    required
                    minLength={6}
                  />
                </div>
                {isSignup ? (
                  <div className="relative">
                    <Lock className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
                    <input
                      type="password"
                      autoComplete="new-password"
                      className="input-field !py-[1.1rem] !pl-12 !text-base sm:!text-lg"
                      placeholder="Confirm password"
                      value={signUp.confirm}
                      onChange={(e) => setSignUp((s) => ({ ...s, confirm: e.target.value }))}
                      required
                      minLength={6}
                    />
                  </div>
                ) : null}
              </div>
              <button
                type="submit"
                disabled={loading}
                className="btn-primary mt-8 flex w-full items-center justify-center gap-2 !py-4 text-base font-black sm:!py-5 sm:text-lg"
              >
                {loading ? <Loader2 className="animate-spin" /> : null}
                {isSignup ? (pioneerClaimAuthActive ? "Create password & continue" : "Create account & continue") : "Sign in"}
              </button>
              {!isSignup ? (
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={forgotPasswordBusy}
                  className="mt-4 w-full text-sm font-bold text-slate-500 hover:text-[#004aad] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {forgotPasswordBusy ? "Sending reset email..." : "Forgot password?"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setAppState("landing")}
                className={`w-full rounded-2xl py-3 text-sm font-bold text-slate-500 transition-colors hover:bg-slate-50 hover:text-[#004aad] ${!isSignup ? "mt-4" : "mt-6"}`}
              >
                Back to home
              </button>
              {!isSignup ? (
                <button
                  type="button"
                  onClick={() => switchMemberAuthMode("signup")}
                  className="mt-3 w-full text-sm font-bold text-[#004aad] hover:underline"
                >
                  New member? Create an account
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => switchMemberAuthMode("login")}
                  className="mt-3 w-full text-sm font-bold text-slate-500 hover:text-[#004aad]"
                >
                  Already have an account? Sign in
                </button>
              )}
            </form>
          </div>
        </div>
      </>
    );
  }

  if (appState === "pioneer_reclaim")
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-6 sm:p-8">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
          <div className="card-senior w-full max-w-lg space-y-6">
            <B2CLogo size="md" align="center" />
            <div className="flex items-start gap-3">
              <HeartHandshake className="mt-1 h-10 w-10 shrink-0 text-[#004aad]" aria-hidden />
              <div>
                <h1 className="text-2xl font-black uppercase tracking-tight text-[#004aad]">Founding pioneer</h1>
                <p className="mt-2 text-sm font-medium leading-relaxed text-slate-600">
                  Enter your name and TIN <strong>as on the cooperative roster</strong>. We&apos;ll show the login email this
                  system created for you (the sheet often had no email column). Use that email for Firebase, then complete your
                  profile including real email and birth date.
                </p>
              </div>
            </div>
            {!Boolean((import.meta.env.VITE_API_BASE_URL || "").trim()) ? (
              <div className="rounded-2xl bg-amber-50 p-4 text-sm font-semibold text-amber-950">
                Set <code className="rounded bg-white px-1">VITE_API_BASE_URL</code> in <code className="rounded bg-white px-1">frontend/.env</code>{" "}
                so we can verify your roster row.
              </div>
            ) : (
              <>
                <form
                  className="space-y-4"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setPioneerReclaimError(null);
                    setPioneerReclaimEligible(null);
                    setPioneerReclaimSignInEmail(null);
                    setPioneerReclaimFailReason(null);
                    setPioneerReclaimLoading(true);
                    try {
                      const res = await PmesService.checkPioneerEligibility({
                        firstName: pioneerReclaimFirstName,
                        middleName: pioneerReclaimMiddleName,
                        lastName: pioneerReclaimLastName,
                        tinNo: pioneerReclaimTin,
                      });
                      const ok = Boolean(res?.eligible);
                      setPioneerReclaimEligible(ok);
                      if (ok && typeof res?.signInEmail === "string" && res.signInEmail.trim()) {
                        setPioneerReclaimSignInEmail(res.signInEmail.trim());
                      }
                      if (!ok && res?.reason) {
                        setPioneerReclaimFailReason(res.reason === "ambiguous" ? "ambiguous" : "not_found");
                      }
                    } catch (err) {
                      setPioneerReclaimError(err instanceof Error ? err.message : "Verification failed.");
                    } finally {
                      setPioneerReclaimLoading(false);
                    }
                  }}
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-1">
                      <label className="mb-1 block text-xs font-black uppercase tracking-wider text-slate-500" htmlFor="pioneer-fn">
                        First name <span className="text-red-600">*</span>
                      </label>
                      <input
                        id="pioneer-fn"
                        type="text"
                        autoComplete="given-name"
                        className="input-field w-full"
                        value={pioneerReclaimFirstName}
                        onChange={(ev) => setPioneerReclaimFirstName(ev.target.value)}
                        required
                      />
                    </div>
                    <div className="sm:col-span-1">
                      <label className="mb-1 block text-xs font-black uppercase tracking-wider text-slate-500" htmlFor="pioneer-mn">
                        Middle name
                      </label>
                      <input
                        id="pioneer-mn"
                        type="text"
                        autoComplete="additional-name"
                        className="input-field w-full"
                        value={pioneerReclaimMiddleName}
                        onChange={(ev) => setPioneerReclaimMiddleName(ev.target.value)}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-xs font-black uppercase tracking-wider text-slate-500" htmlFor="pioneer-ln">
                        Last name <span className="text-red-600">*</span>
                      </label>
                      <input
                        id="pioneer-ln"
                        type="text"
                        autoComplete="family-name"
                        className="input-field w-full"
                        value={pioneerReclaimLastName}
                        onChange={(ev) => setPioneerReclaimLastName(ev.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-black uppercase tracking-wider text-slate-500" htmlFor="pioneer-tin">
                      TIN (Tax Identification Number) <span className="text-red-600">*</span>
                    </label>
                    <p className="mb-2 text-xs font-medium leading-relaxed text-slate-600">
                      Digits only after we normalize (spaces and dashes OK). Must match the roster import.
                    </p>
                    <input
                      id="pioneer-tin"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="e.g. 123456789 or 000000000"
                      className="input-field w-full font-mono"
                      value={pioneerReclaimTin}
                      onChange={(ev) => setPioneerReclaimTin(ev.target.value)}
                      required
                    />
                    <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50/95 px-3 py-2 text-xs font-medium leading-relaxed text-amber-950">
                      <strong className="font-black">No TIN on the sheet?</strong> Enter nine zeroes:{" "}
                      <span className="font-mono font-bold">000000000</span> — only if your row was imported that way. After
                      sign-in, update TIN, email, and birth date in your membership profile.
                    </p>
                  </div>
                  {pioneerReclaimError ? (
                    <div className="rounded-2xl bg-red-50 p-3 text-center text-sm font-bold text-red-800">{pioneerReclaimError}</div>
                  ) : null}
                  <button type="submit" disabled={pioneerReclaimLoading} className="btn-primary flex w-full items-center justify-center gap-2 py-4">
                    {pioneerReclaimLoading ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
                    Check eligibility
                  </button>
                </form>
                {pioneerReclaimEligible === true && pioneerReclaimSignInEmail ? (
                  <div className="space-y-3 rounded-2xl border border-emerald-200 bg-emerald-50/90 p-4">
                    <p className="text-sm font-bold text-emerald-950">
                      You&apos;re on the pioneer import list and still need the digital profile. Use this email for Firebase — it
                      was generated when your row was imported:
                    </p>
                    <p className="break-all rounded-xl bg-white px-3 py-2 text-center font-mono text-sm font-black text-emerald-950 shadow-inner">
                      {pioneerReclaimSignInEmail}
                    </p>
                    <p className="text-xs font-medium leading-relaxed text-emerald-900">
                      After sign-in, open your membership form to add your real email, birth date, and correct TIN if you used
                      nine zeroes.
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        className="btn-primary flex-1 py-3 text-sm font-black uppercase"
                        onClick={() => {
                          try {
                            sessionStorage.setItem(
                              "b2c_pioneer_prefill",
                              JSON.stringify({
                                email: pioneerReclaimSignInEmail,
                                pioneerClaim: true,
                                firstName: pioneerReclaimFirstName,
                                middleName: pioneerReclaimMiddleName,
                                lastName: pioneerReclaimLastName,
                                tinNo: pioneerReclaimTin,
                              }),
                            );
                          } catch {
                            /* ignore */
                          }
                          pendingAfterAuthRef.current = "pioneer_portal";
                          setMemberAuthMode("login");
                          setAppState("member_auth");
                        }}
                      >
                        Sign in
                      </button>
                      <button
                        type="button"
                        className="btn-secondary flex-1 py-3 text-sm font-black uppercase"
                        onClick={() => {
                          try {
                            sessionStorage.setItem(
                              "b2c_pioneer_prefill",
                              JSON.stringify({
                                email: pioneerReclaimSignInEmail,
                                pioneerClaim: true,
                                firstName: pioneerReclaimFirstName,
                                middleName: pioneerReclaimMiddleName,
                                lastName: pioneerReclaimLastName,
                                tinNo: pioneerReclaimTin,
                              }),
                            );
                          } catch {
                            /* ignore */
                          }
                          pendingAfterAuthRef.current = "pioneer_portal";
                          setMemberAuthMode("signup");
                          setAppState("member_auth");
                        }}
                      >
                        Create account
                      </button>
                    </div>
                  </div>
                ) : null}
                {pioneerReclaimEligible === false ? (
                  <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-950">
                    <p className="font-bold">
                      {pioneerReclaimFailReason === "ambiguous"
                        ? "We found more than one matching pioneer roster row."
                        : "We could not match an unclaimed pioneer roster row with this entry."}
                    </p>
                    {pioneerReclaimFailReason === "ambiguous" ? (
                      <p className="font-medium leading-relaxed">
                        Contact the cooperative office and provide your full name and TIN so staff can identify the correct record.
                      </p>
                    ) : (
                      <ul className="list-disc space-y-1 pl-5 font-medium leading-relaxed">
                        <li>Required fields: First name, Last name, and TIN.</li>
                        <li>Use your exact roster spelling (include middle name if listed in the roster).</li>
                        <li>TIN can include dashes/spaces; only digits are matched after normalization.</li>
                        <li>Use <span className="font-mono">000000000</span> only if your imported roster row used that placeholder.</li>
                        <li>If this account was already claimed before, use normal Sign in instead of pioneer claim.</li>
                      </ul>
                    )}
                  </div>
                ) : null}
              </>
            )}
            <button
              type="button"
              onClick={() => {
                setPioneerReclaimError(null);
                setPioneerReclaimEligible(null);
                setPioneerReclaimSignInEmail(null);
                setPioneerReclaimFailReason(null);
                setPioneerReclaimFirstName("");
                setPioneerReclaimMiddleName("");
                setPioneerReclaimLastName("");
                setPioneerReclaimTin("");
                setAppState("landing");
              }}
              className="w-full text-center text-sm font-bold text-slate-500 hover:text-[#004aad]"
            >
              Back to home
            </button>
          </div>
        </div>
      </>
    );

  if (appState === "landing")
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <LandingPage
          isFirebaseConfigured={isFirebaseConfigured}
          authUser={user}
          resumePmesSuggested={resumePmesSuggested}
          pmesExamPassed={pmesExamPassed}
          joinPipelineBanner={joinPipelineBanner}
          landingIdentityLabel={landingIdentityLabel}
          hidePmesEntry={hidePmesEntry}
          onJoinUs={() => {
            if (!isFirebaseConfigured) return;
            if (!user) {
              beginJoinAsGuest("signup");
              return;
            }
            void goJoinUnified();
          }}
          onAfterSignupStartPmes={() => {
            queueSignupLiveActivityFromDevice();
            void goJoinUnified();
          }}
          onOpenFullMemberAuth={beginJoinAsGuest}
          onLogout={handleLogout}
          onContinuePmes={user && resumePmesSuggested ? continuePmesFromLanding : undefined}
          onStartPmes={() => {
            if (!isFirebaseConfigured) return;
            if (!user) {
              beginJoinAsGuest("login");
              return;
            }
            void goJoinUnified();
          }}
          onRetrieveCertificate={() => {
            if (!isFirebaseConfigured) return;
            if (user) {
              setRetrievalData((d) => ({ ...d, email: user.email || d.email }));
              setPmesPaused(false);
              setAppState("login_retrieval");
              return;
            }
            pendingAfterAuthRef.current = "retrieval";
            setMemberAuthMode("login");
            setAppState("member_auth");
          }}
          onAdminPortal={handleAdminPortal}
          onPioneerReclaim={() => {
            if (!isFirebaseConfigured) return;
            setPioneerReclaimError(null);
            setPioneerReclaimEligible(null);
            setPioneerReclaimSignInEmail(null);
            setPioneerReclaimFailReason(null);
            setPioneerReclaimFirstName("");
            setPioneerReclaimMiddleName("");
            setPioneerReclaimLastName("");
            setPioneerReclaimTin("");
            setAppState("pioneer_reclaim");
          }}
          onMemberPortal={async () => {
            if (!user) return;
            const api = Boolean((import.meta.env.VITE_API_BASE_URL || "").trim());
            if (api) await refreshMembershipLifecycle();
            setAppState("member_portal");
          }}
          onCoopStore={() => openCoopStore()}
          onMemberProfile={() => {
            if (!user) return;
            registrationNavRef.current = "portal";
            setAppState("registration");
          }}
          staffPipelineInbox={
            useApiMembership && staffAccessToken && staffInboxSummary
              ? {
                  lines: staffInboxSummary.lines,
                  onOpenAdmin: () => setAppState("admin_dashboard"),
                }
              : null
          }
          staffTreasuryLink={(() => {
            const url = (import.meta.env.VITE_ACCOUNTING_APP_URL || "").trim();
            const can =
              staffAccessToken &&
              canOpenAccounting(staffRole);
            return url && can ? { url, label: "Treasury / Accounting" } : null;
          })()}
        />
      </>
    );

  if (appState === "seminar")
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="min-h-screen px-4 py-8 sm:px-6 md:py-12 lg:px-8">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <div className="mx-auto max-w-6xl overflow-hidden rounded-3xl bg-white shadow-2xl md:rounded-[2.5rem] lg:rounded-[3rem]">
          <div className="flex flex-col gap-4 bg-[#004aad] p-5 text-white sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-6 md:p-8 lg:p-10">
            <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 md:gap-6">
              <B2CLogo size="nav" priority className="shrink-0 self-start drop-shadow-sm" />
              <div className="flex min-w-0 items-start gap-3 sm:items-center sm:gap-4 md:gap-5">
              {(() => {
                const Icon = modules[currentStep].icon;
                return <Icon className="h-10 w-10 shrink-0 sm:h-11 sm:w-11 md:h-14 md:w-14" aria-hidden />;
              })()}
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-white/80 sm:text-xs">Current module</p>
                <h2 className="text-xl font-bold leading-tight tracking-tight sm:text-2xl md:text-3xl lg:text-4xl">
                  {modules[currentStep].title}
                </h2>
              </div>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 self-start sm:self-auto">
              <button
                type="button"
                onClick={goHomeFromPmes}
                className="inline-flex items-center gap-2 rounded-xl bg-white/15 px-4 py-2 text-sm font-bold text-white hover:bg-white/25"
              >
                <House className="h-4 w-4 shrink-0" aria-hidden />
                Save &amp; home
              </button>
              <div className="rounded-full bg-black/20 px-4 py-2 text-lg font-bold tabular-nums md:px-6 md:text-xl">
                {currentStep + 1} / {modules.length}
              </div>
            </div>
          </div>

          <div className="space-y-6 p-6 sm:p-10 md:space-y-8 md:p-12 lg:p-14">
            <CourseAudioPreference enabled={courseAudioEnabled} onChange={setCourseAudioEnabled} />
            {ttsError && (
              <div
                className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between"
                role="alert"
              >
                <span className="min-w-0 leading-snug">{ttsError}</span>
                <button
                  type="button"
                  className="shrink-0 rounded-xl bg-white/80 px-3 py-1.5 text-sm font-semibold text-amber-900 ring-1 ring-amber-300 hover:bg-white"
                  onClick={() => setTtsError(null)}
                >
                  Dismiss
                </button>
              </div>
            )}
            {modules[currentStep].items.map((item, index) => (
              <NarrativeCard
                key={item.t}
                index={index}
                title={item.t}
                outline={item.outline}
                script={item.script}
                illustration={item.illustration}
                isOpen={openCardIndex === index}
                onClick={() => setOpenCardIndex(index)}
                courseAudioEnabled={courseAudioEnabled}
                onCourseAudioChange={setCourseAudioEnabled}
                prefetchTts={prefetchTts}
                playTts={playTts}
                pauseTts={pauseTts}
                isSpeaking={isSpeaking}
                speakingTtsKey={speakingTtsKey}
                audioLoading={loadingTtsKey === `${index}-${item.t}`}
              />
            ))}
          </div>

          <div className="flex flex-col gap-4 border-t border-slate-100 bg-slate-50/80 p-6 sm:flex-row sm:gap-6 sm:p-10 md:p-12">
            <button
              type="button"
              disabled={currentStep === 0}
              onClick={() => {
                setCurrentStep((step) => step - 1);
                setOpenCardIndex(0);
                currentAudio.current?.pause();
                setIsSpeaking(false);
              }}
              className={`flex-1 rounded-2xl py-5 text-lg font-bold tracking-tight transition-colors md:rounded-3xl md:py-8 md:text-2xl ${
                currentStep === 0 ? "cursor-not-allowed bg-slate-200 text-slate-400" : "bg-white text-slate-800 shadow-md hover:bg-slate-50"
              }`}
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => {
                currentAudio.current?.pause();
                setIsSpeaking(false);
                if (currentStep < modules.length - 1) {
                  setCurrentStep((step) => step + 1);
                  setOpenCardIndex(0);
                } else {
                  const questions = [...questionPool].sort(() => 0.5 - Math.random()).slice(0, 10);
                  if (!isParticipantProfileComplete(formData)) {
                    setExamQuestions(questions);
                    registrationNavRef.current = "exam";
                    setAppState("registration");
                    return;
                  }
                  setExamQuestions(questions);
                  setAppState("exam");
                }
              }}
              className="btn-primary flex-[2] rounded-2xl py-5 text-lg font-bold tracking-tight md:rounded-3xl md:py-8 md:text-2xl"
            >
              {currentStep === modules.length - 1 ? "Go to exam" : "Next"}
            </button>
          </div>
        </div>
      </div>
      </>
    );

  if (appState === "exam")
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="min-h-screen px-8 py-16">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <div className="mx-auto mb-10 flex max-w-5xl items-center justify-between gap-4">
          <B2CLogo size="nav" className="shrink-0" />
          <button
            type="button"
            onClick={goHomeFromPmes}
            className="btn-secondary inline-flex shrink-0 items-center gap-2 py-3 text-lg font-bold"
          >
            <House className="h-5 w-5" aria-hidden />
            Save &amp; home
          </button>
        </div>
        <div className="mx-auto w-full max-w-5xl space-y-16 rounded-[4rem] bg-white p-16 shadow-2xl">
          <B2CLogo size="md" align="center" className="mb-2" />
          <h2 className="text-center text-6xl font-black uppercase tracking-tighter text-[#004aad]">FINAL CHALLENGE</h2>
          <div className="space-y-16">
            {examQuestions.map((question, index) => (
              <div key={question.q} className="space-y-10 rounded-[4rem] border-4 border-slate-200 bg-slate-50 p-12 shadow-inner">
                <h3 className="flex gap-6 text-4xl font-black text-slate-800"><span className="text-[#004aad]">{index + 1}.</span>{question.q}</h3>
                <div className="grid grid-cols-1 gap-6">
                  {question.a.map((option, optionIndex) => (
                    <button
                      key={option}
                      onClick={() => setAnswers({ ...answers, [index]: optionIndex })}
                      className={`rounded-[2.5rem] border-8 p-10 text-left text-3xl font-black transition-all ${
                        answers[index] === optionIndex
                          ? "scale-[1.03] border-[#004aad] bg-[#004aad] text-white shadow-2xl"
                          : "border-slate-100 bg-white text-slate-700"
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {error && (
            <div className="rounded-3xl border-2 border-red-200 bg-red-50 p-6 text-center text-lg font-bold text-red-800">{error}</div>
          )}
          <button onClick={handleFinishExam} disabled={loading} className="btn-primary h-32 w-full text-4xl font-black uppercase tracking-tighter">
            {loading ? <Loader2 className="animate-spin" /> : "SUBMIT EXAM"}
          </button>
        </div>
      </div>
      </>
    );

  if (appState === "result")
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="flex min-h-screen items-center justify-center p-8">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <div className="card-senior w-full max-w-4xl space-y-10 text-center">
          <B2CLogo size="md" align="center" className="mb-2" />
          <div className={`mx-auto flex h-40 w-40 items-center justify-center rounded-full border-[12px] sm:h-48 sm:w-48 ${score >= 7 ? "bg-emerald-100 text-emerald-600" : "bg-amber-50 text-amber-600"}`}>
            {score >= 7 ? <CheckCircle2 className="h-20 w-20 sm:h-24 sm:w-24" /> : <AlertCircle className="h-20 w-20 sm:h-24 sm:w-24" />}
          </div>
          {score >= 7 ? (
            <>
              <h1 className="text-5xl font-black uppercase tracking-tighter text-[#004aad] sm:text-6xl">Well done!</h1>
              <p className="text-2xl font-bold leading-relaxed text-slate-700 sm:text-3xl">
                You scored <span className="tabular-nums text-[#004aad]">{score} out of 10</span> — you have passed the PMES assessment.
              </p>
              <p className="mx-auto max-w-2xl text-lg leading-relaxed text-slate-600">
                Your result has been saved. Next, open your certificate. After that, you can complete the{" "}
                <strong>Letter of Intent</strong> from the certificate screen whenever you are ready.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-5xl font-black uppercase tracking-tighter text-[#004aad] sm:text-6xl">Keep going!</h1>
              <p className="text-2xl font-bold leading-relaxed text-slate-700 sm:text-3xl">
                You scored <span className="tabular-nums text-[#004aad]">{score} out of 10</span>. You need at least 7 to pass.
              </p>
              <p className="mx-auto max-w-2xl text-lg leading-relaxed text-slate-600">
                Review the modules and try the exam again when you feel ready — many members pass on their next attempt.
              </p>
            </>
          )}
          <button
            type="button"
            onClick={() => setAppState(score >= 7 ? "certificate" : "seminar")}
            className="btn-primary py-10 text-3xl uppercase tracking-tighter sm:py-12 sm:text-4xl"
          >
            {score >= 7 ? "View certificate" : "Back to seminar & re-take"}
          </button>
        </div>
      </div>
      </>
    );

  if (appState === "certificate")
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="flex min-h-screen flex-col items-center bg-slate-100 p-8 sm:p-20">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        {!activeRecord?.fullName ? (
          <div className="card-senior w-full max-w-lg space-y-8 text-center">
            <B2CLogo size="md" align="center" />
            <p className="text-xl font-bold text-slate-700">Certificate data is missing. Complete the exam with a passing score, or retrieve your record from “My Certificate.”</p>
            <button
              type="button"
              onClick={() => setAppState(staffAccessToken ? "admin_dashboard" : "landing")}
              className="btn-primary w-full py-6"
            >
              {staffAccessToken ? "Back to admin dashboard" : "Back to home"}
            </button>
          </div>
        ) : (
          <>
            <Certificate
              record={{
                ...activeRecord,
                legacyPioneerImport:
                  Boolean(activeRecord?.legacyPioneerImport) ||
                  Boolean(membershipLifecycle?.isLegacyFounderImport),
              }}
            />
            <div className="no-print mt-16 flex w-full max-w-4xl flex-col gap-8 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                onClick={() => window.print()}
                className="btn-secondary flex-1 py-8 text-2xl uppercase tracking-tighter"
              >
                <Printer aria-hidden />
                Print / Save as PDF
              </button>
              {staffAccessToken && !sessionUser ? (
                <button
                  type="button"
                  onClick={() => setAppState("admin_dashboard")}
                  className="btn-primary flex-1 py-8 text-2xl uppercase tracking-tighter"
                >
                  Back to admin dashboard
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setLoiData((prev) => ({
                        ...prev,
                        address: String(prev.address || "").trim() || String(formData.residenceAddress || "").trim() || "",
                      }));
                      setAppState("loi_form");
                    }}
                    className="btn-primary flex-1 py-8 text-2xl uppercase tracking-tighter"
                  >
                    <Briefcase aria-hidden />
                    Letter of Intent
                  </button>
                  <button type="button" onClick={goHomeFromPmes} className="btn-secondary flex-1 py-8 text-lg font-bold">
                    Home
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
      </>
    );

  if (appState === "loi_form")
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="flex min-h-screen items-center justify-center bg-slate-50 p-8">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <div className="card-senior w-full max-w-4xl space-y-12">
          <B2CLogo size="lg" align="center" />
          <h1 className="text-center text-5xl font-black uppercase tracking-tighter text-[#004aad]">LETTER OF INTENT</h1>
          <LOIForm
            formData={formData}
            loiData={loiData}
            setLoiData={setLoiData}
            error={error}
            loading={loading}
            onSubmit={handleLoiSubmit}
            onBack={() => setAppState("certificate")}
          />
        </div>
      </div>
      </>
    );

  if (appState === "loi_success")
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="flex min-h-screen items-center justify-center p-8">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <div className="card-senior w-full max-w-4xl space-y-10 border-emerald-100 text-center">
          <B2CLogo size="md" align="center" />
          <Sparkles className="mx-auto h-32 w-32 animate-pulse text-emerald-500" />
          <h1 className="text-6xl font-black uppercase tracking-tighter text-[#004aad]">THANK YOU!</h1>
          <button
            type="button"
            onClick={async () => {
              if (user && isFirebaseConfigured) {
                try {
                  await clearPmesProgress(db, appId, user.uid);
                } catch {
                  /* ignore */
                }
              }
              setPmesPaused(false);
              setAppState("landing");
            }}
            className="btn-primary w-full py-10 text-3xl"
          >
            FINISH
          </button>
        </div>
      </div>
      </>
    );

  if (appState === "payment_portal")
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="flex min-h-screen items-center justify-center bg-slate-50 p-8">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <div className="card-senior w-full max-w-2xl space-y-8 text-center">
          <B2CLogo size="lg" align="center" />
          <Coins className="mx-auto h-16 w-16 text-[#004aad]" aria-hidden />
          <h1 className="text-3xl font-black uppercase tracking-tighter text-[#004aad] md:text-4xl">Share capital &amp; membership</h1>
          <p className="text-lg font-medium leading-relaxed text-slate-600">
            <strong>Scan the code below</strong> with your phone camera. It will open{" "}
            <strong>Facebook Messenger</strong> so you can chat with us about share capital and membership fee payments.
          </p>
          <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-6">
            <MessengerPaymentQr />
            <p className="mt-4 text-sm font-medium text-slate-500">
              Tip: use your camera app or Messenger — scan, then tap the banner to open the chat.
            </p>
          </div>
          <p className="text-lg font-medium leading-relaxed text-slate-600">
            On a computer or if you prefer a link: contact <strong>B2CCoop</strong> via Facebook Messenger at{" "}
            <a
              href={MESSENGER_PAYMENT_CHAT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-[#004aad] underline decoration-2 underline-offset-2 hover:text-[#004aad]/90"
            >
              m.me/278382175357935
            </a>
            .
          </p>
          <button type="button" onClick={() => setAppState("landing")} className="btn-primary w-full py-5 text-xl font-black">
            Back to home
          </button>
        </div>
      </div>
      </>
    );

  if (appState === "coop_store")
    return (
      <>
        {identityRibbon}
        {portalHomeBar}
        <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <CoopStore
          email={formData.email || user?.email || ""}
          getFirebaseIdToken={async () => {
            if (!auth?.currentUser) throw new Error("Sign in required");
            return auth.currentUser.getIdToken();
          }}
          onBack={() => setAppState(coopStoreBackTarget())}
        />
      </>
    );

  if (appState === "login_retrieval")
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="flex min-h-screen items-center justify-center p-8">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
          <div className="card-senior w-full max-w-2xl space-y-10">
            <B2CLogo size="lg" align="center" />
            <h2 className="text-center text-4xl font-black uppercase tracking-tighter text-[#004aad]">RETRIEVE CERTIFICATE</h2>
            <div className="space-y-6">
              <input type="email" placeholder="Email Address" className="input-field" value={retrievalData.email} onChange={(event) => setRetrievalData({ ...retrievalData, email: event.target.value })} />
              <input type="date" className="input-field" value={retrievalData.dob} onChange={(event) => setRetrievalData({ ...retrievalData, dob: event.target.value })} />
              {error && <div className="rounded-2xl bg-red-50 p-6 font-bold text-red-600">{error}</div>}
              <button onClick={handleRetrieval} disabled={loading} className="btn-primary w-full">
                SEARCH
              </button>
            </div>
          </div>
        </div>
      </>
    );

  if (appState === "consent")
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="flex min-h-screen items-center justify-center p-8">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <div className="card-senior w-full max-w-4xl space-y-8">
          <div className="text-center">
            <B2CLogo size="lg" align="center" className="mb-6" />
            <ShieldAlert className="mx-auto h-20 w-20 animate-bounce text-[#004aad]" />
            <h1 className="mt-4 text-4xl font-black uppercase tracking-tighter text-[#004aad] sm:text-5xl">{PRIVACY_NOTICE_HEADING}</h1>
            <p className="mt-3 text-lg font-semibold text-slate-600">Please read the following before continuing.</p>
          </div>
          <div
            className="max-h-[min(28rem,55vh)] space-y-4 overflow-y-auto rounded-2xl border-2 border-slate-200 bg-slate-50 p-6 text-left text-lg leading-relaxed text-slate-700 shadow-inner"
            role="region"
            aria-label="Privacy agreement text"
          >
            {PRIVACY_NOTICE_PARAGRAPHS.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
            <p>{PRIVACY_PMES_CONSENT_CLOSING}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setFormData((prev) => ({ ...prev, email: user?.email || prev.email }));
              setAppState("seminar");
            }}
            className="btn-primary flex w-full items-center justify-center gap-2"
          >
            <Lock className="h-6 w-6 shrink-0" />
            I AGREE AND CONTINUE
          </button>
        </div>
      </div>
      </>
    );

  if (appState === "registration") {
    const regNav = registrationNavRef.current;
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="flex min-h-screen flex-col items-center justify-center gap-10 p-4 pb-16 pt-8 sm:p-8">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <div className="card-senior w-full max-w-3xl space-y-8">
          <div className="text-center">
            <B2CLogo size="lg" align="center" className="mb-6" />
            <h1 className="text-4xl font-black uppercase tracking-tighter text-[#004aad] sm:text-5xl">Member profile</h1>
            <p className="mt-3 text-lg font-semibold text-slate-600">
              Confirm or edit your details for your PMES record, certificate, LOI, and retrieval. Sign-up already captured your
              login email and basic profile.
            </p>
            {regNav === "exam" ? (
              <p className="mt-2 text-sm font-bold text-amber-800">Complete these details to continue to the exam.</p>
            ) : null}
          </div>
          <div className="space-y-8">
            {error && <div className="rounded-2xl bg-red-50 p-4 text-center font-bold text-red-600">{error}</div>}
            <div className="grid gap-6 sm:grid-cols-3">
              <input
                type="text"
                className="input-field"
                placeholder="First name"
                value={formData.firstName}
                onChange={(event) =>
                  setFormData((prev) => {
                    const next = { ...prev, firstName: event.target.value };
                    next.fullName = composeFullName(next.firstName, next.middleName, next.lastName);
                    return next;
                  })
                }
              />
              <input
                type="text"
                className="input-field"
                placeholder="Optional middle name"
                value={formData.middleName}
                onChange={(event) =>
                  setFormData((prev) => {
                    const next = { ...prev, middleName: event.target.value };
                    next.fullName = composeFullName(next.firstName, next.middleName, next.lastName);
                    return next;
                  })
                }
              />
              <input
                type="text"
                className="input-field"
                placeholder="Last name"
                value={formData.lastName}
                onChange={(event) =>
                  setFormData((prev) => {
                    const next = { ...prev, lastName: event.target.value };
                    next.fullName = composeFullName(next.firstName, next.middleName, next.lastName);
                    return next;
                  })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-6">
              <input type="date" className="input-field" value={formData.dob} onChange={(event) => setFormData({ ...formData, dob: event.target.value })} />
              <select className="input-field" value={formData.gender} onChange={(event) => setFormData({ ...formData, gender: event.target.value })}>
                <option value="">Gender</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
              </select>
            </div>
            <input
              type="email"
              className="input-field"
              placeholder="Email Address"
              value={formData.email}
              onChange={(event) => setFormData({ ...formData, email: event.target.value })}
              readOnly={Boolean(user?.email)}
              title={user?.email ? "Email is tied to your member login." : undefined}
            />
            {user && useApiMembership && regNav === "portal" ? (
              <div className="rounded-2xl border border-[#004aad]/20 bg-slate-50/90 p-4 text-left sm:p-5">
                <p className="text-sm font-black uppercase tracking-wide text-[#004aad]">Change sign-in email</p>
                <p className="mt-2 text-xs font-medium leading-relaxed text-slate-600">
                  Updates your Firebase login and the cooperative member record. Use an inbox you control for password resets.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <input
                    type="email"
                    className="input-field"
                    autoComplete="off"
                    placeholder="New email address"
                    value={memberLoginEmailNew}
                    onChange={(e) => {
                      setMemberLoginEmailNew(e.target.value);
                      setMemberLoginEmailError(null);
                      setMemberLoginEmailSuccess(null);
                    }}
                    disabled={memberLoginEmailBusy}
                  />
                  <input
                    type="email"
                    className="input-field"
                    autoComplete="off"
                    placeholder="Confirm new email"
                    value={memberLoginEmailConfirm}
                    onChange={(e) => {
                      setMemberLoginEmailConfirm(e.target.value);
                      setMemberLoginEmailError(null);
                      setMemberLoginEmailSuccess(null);
                    }}
                    disabled={memberLoginEmailBusy}
                  />
                </div>
                {memberLoginEmailError ? (
                  <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{memberLoginEmailError}</div>
                ) : null}
                {memberLoginEmailSuccess ? (
                  <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
                    {memberLoginEmailSuccess}
                  </div>
                ) : null}
                <button
                  type="button"
                  disabled={memberLoginEmailBusy}
                  onClick={async () => {
                    setMemberLoginEmailError(null);
                    setMemberLoginEmailSuccess(null);
                    const n = String(memberLoginEmailNew || "").trim();
                    const c = String(memberLoginEmailConfirm || "").trim();
                    if (!n || !c) {
                      setMemberLoginEmailError("Enter and confirm the new email address.");
                      return;
                    }
                    if (n.toLowerCase() !== c.toLowerCase()) {
                      setMemberLoginEmailError("Confirmation does not match the new email.");
                      return;
                    }
                    const cur = String(user?.email || "").trim();
                    if (!cur || n.toLowerCase() === cur.toLowerCase()) {
                      setMemberLoginEmailError("Choose an address different from your current sign-in email.");
                      return;
                    }
                    setMemberLoginEmailBusy(true);
                    try {
                      /** Force refresh so the API always gets a valid Bearer (avoids stale-session errors). */
                      const token = await user.getIdToken(true);
                      /** @type {{ newLoginEmail?: string; loginEmailUpdated?: boolean }} */
                      const out = await PmesService.patchMemberLoginEmail({
                        email: cur,
                        newEmail: n,
                        idToken: token,
                      });
                      const nextEmail = typeof out?.newLoginEmail === "string" ? out.newLoginEmail.trim() : n;
                      setFormData((prev) => ({ ...prev, email: nextEmail }));
                      setRetrievalData((prev) => ({ ...prev, email: nextEmail }));
                      setMemberLoginEmailNew("");
                      setMemberLoginEmailConfirm("");
                      void refreshMembershipLifecycle();
                      let successMsg = "Sign-in email updated. Use this address the next time you log in.";
                      if (out?.loginEmailUpdated && auth.currentUser) {
                        try {
                          await auth.currentUser.getIdToken(true);
                          await reload(auth.currentUser);
                          await auth.currentUser.getIdToken(true);
                        } catch {
                          successMsg =
                            "Sign-in email was saved on the server. If the header still shows an old address, sign out and sign in once.";
                        }
                      }
                      setMemberLoginEmailSuccess(successMsg);
                    } catch (e) {
                      setMemberLoginEmailError(e instanceof Error ? e.message : "Could not update sign-in email.");
                    } finally {
                      setMemberLoginEmailBusy(false);
                    }
                  }}
                  className="mt-4 inline-flex min-h-[44px] w-full items-center justify-center rounded-2xl border-2 border-[#004aad]/30 bg-white px-4 py-3 text-sm font-black uppercase tracking-wide text-[#004aad] shadow-sm transition hover:border-[#004aad]/50 hover:bg-[#004aad]/5 disabled:opacity-50 sm:w-auto"
                >
                  {memberLoginEmailBusy ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden />
                      Updating…
                    </>
                  ) : (
                    "Update sign-in email"
                  )}
                </button>
              </div>
            ) : null}
            {user && regNav === "portal" ? (
              <div className="rounded-2xl border border-[#004aad]/20 bg-slate-50/90 p-4 text-left sm:p-5">
                <p className="text-sm font-black uppercase tracking-wide text-[#004aad]">Change password</p>
                <p className="mt-2 text-xs font-medium leading-relaxed text-slate-600">
                  For security, enter your current password first. Your new password must be at least 6 characters.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <input
                    type="password"
                    className="input-field"
                    autoComplete="current-password"
                    placeholder="Current password"
                    value={memberPasswordForm.currentPassword}
                    onChange={(e) => {
                      setMemberPasswordForm((prev) => ({ ...prev, currentPassword: e.target.value }));
                      setMemberPasswordError(null);
                      setMemberPasswordSuccess(null);
                    }}
                    disabled={memberPasswordBusy}
                  />
                  <input
                    type="password"
                    className="input-field"
                    autoComplete="new-password"
                    placeholder="New password"
                    value={memberPasswordForm.newPassword}
                    onChange={(e) => {
                      setMemberPasswordForm((prev) => ({ ...prev, newPassword: e.target.value }));
                      setMemberPasswordError(null);
                      setMemberPasswordSuccess(null);
                    }}
                    disabled={memberPasswordBusy}
                  />
                  <input
                    type="password"
                    className="input-field"
                    autoComplete="new-password"
                    placeholder="Confirm new password"
                    value={memberPasswordForm.confirmPassword}
                    onChange={(e) => {
                      setMemberPasswordForm((prev) => ({ ...prev, confirmPassword: e.target.value }));
                      setMemberPasswordError(null);
                      setMemberPasswordSuccess(null);
                    }}
                    disabled={memberPasswordBusy}
                  />
                </div>
                {memberPasswordError ? (
                  <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{memberPasswordError}</div>
                ) : null}
                {memberPasswordSuccess ? (
                  <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
                    {memberPasswordSuccess}
                  </div>
                ) : null}
                <button
                  type="button"
                  disabled={memberPasswordBusy}
                  onClick={async () => {
                    setMemberPasswordError(null);
                    setMemberPasswordSuccess(null);
                    const current = String(memberPasswordForm.currentPassword ?? "");
                    const next = String(memberPasswordForm.newPassword ?? "");
                    const confirm = String(memberPasswordForm.confirmPassword ?? "");
                    if (!current || !next || !confirm) {
                      setMemberPasswordError("Enter your current password, new password, and confirmation.");
                      return;
                    }
                    if (next.length < 6) {
                      setMemberPasswordError("New password must be at least 6 characters.");
                      return;
                    }
                    if (next !== confirm) {
                      setMemberPasswordError("New password and confirmation do not match.");
                      return;
                    }
                    const currentEmail = String(user.email ?? "").trim();
                    if (!currentEmail) {
                      setMemberPasswordError("Your account email is unavailable. Sign out then sign in again.");
                      return;
                    }
                    setMemberPasswordBusy(true);
                    try {
                      const cred = EmailAuthProvider.credential(currentEmail, current);
                      await reauthenticateWithCredential(user, cred);
                      await updatePassword(user, next);
                      setMemberPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
                      setMemberPasswordSuccess("Password updated successfully. Use the new password on your next sign-in.");
                    } catch (e) {
                      const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
                      if (code === "auth/wrong-password" || code === "auth/invalid-credential") {
                        setMemberPasswordError("Current password is incorrect.");
                      } else if (code === "auth/weak-password") {
                        setMemberPasswordError("New password is too weak. Use at least 6 characters.");
                      } else if (code === "auth/too-many-requests") {
                        setMemberPasswordError("Too many attempts. Wait a moment and try again.");
                      } else {
                        setMemberPasswordError(e instanceof Error ? e.message : "Could not change password.");
                      }
                    } finally {
                      setMemberPasswordBusy(false);
                    }
                  }}
                  className="mt-4 inline-flex min-h-[44px] w-full items-center justify-center rounded-2xl border-2 border-[#004aad]/30 bg-white px-4 py-3 text-sm font-black uppercase tracking-wide text-[#004aad] shadow-sm transition hover:border-[#004aad]/50 hover:bg-[#004aad]/5 disabled:opacity-50 sm:w-auto"
                >
                  {memberPasswordBusy ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden />
                      Updating…
                    </>
                  ) : (
                    "Update password"
                  )}
                </button>
              </div>
            ) : null}
            <input type="tel" className="input-field" placeholder="Mobile number" value={formData.phone} onChange={(event) => setFormData({ ...formData, phone: event.target.value })} />
            <textarea
              className="input-field min-h-[6rem] resize-y"
              placeholder="Residence address"
              rows={3}
              value={formData.residenceAddress}
              onChange={(event) => setFormData({ ...formData, residenceAddress: event.target.value })}
            />
            <button
              type="button"
              onClick={async () => {
                const composed =
                  composeFullName(formData.firstName, formData.middleName, formData.lastName).trim() ||
                  String(formData.fullName || "").trim();
                if (!composed || !formData.dob || !formData.email || !formData.gender) {
                  setError("Fill all required fields including name, gender, and date of birth.");
                  return;
                }
                if (!String(formData.phone || "").trim()) {
                  setError("Mobile number is required.");
                  return;
                }
                if (!String(formData.residenceAddress || "").trim()) {
                  setError("Residence address is required.");
                  return;
                }
                setError(null);
                setFormData((prev) => ({ ...prev, fullName: composed }));
                const from = registrationNavRef.current;

                if (from === "portal" && useApiMembership && user?.email) {
                  try {
                    const token = await user.getIdToken(true);
                    await PmesService.patchMemberBasicProfile({
                      email: user.email,
                      idToken: token,
                      fullName: composed.trim(),
                      phone: String(formData.phone || "").trim(),
                      dob: String(formData.dob || "").trim(),
                      gender: String(formData.gender || "").trim(),
                      mailingAddress: String(formData.residenceAddress || "").trim(),
                    });
                    void refreshMembershipLifecycle();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Could not save your profile to the server.");
                    return;
                  }
                }

                if (user) {
                  void updateProfile(user, { displayName: composed.trim() }).catch(() => null);
                }
                registrationNavRef.current = "menu";
                if (from === "exam") {
                  setAppState("exam");
                } else if (from === "portal") {
                  setAppState("member_portal");
                } else {
                  setAppState("seminar");
                }
              }}
              className="btn-primary w-full py-6 text-2xl font-black uppercase tracking-tighter sm:py-8 sm:text-3xl"
            >
              {regNav === "exam"
                ? "Continue to exam"
                : regNav === "portal"
                  ? "Save & return to portal"
                  : "Save & continue"}
            </button>
            <div className="flex flex-wrap justify-center gap-4">
              <button
                type="button"
                onClick={() => {
                  const from = registrationNavRef.current;
                  registrationNavRef.current = "menu";
                  if (from === "exam") setAppState("seminar");
                  else if (from === "portal") setAppState("member_portal");
                  else setAppState("landing");
                }}
                className="text-sm font-bold text-slate-500 hover:text-[#004aad]"
              >
                {regNav === "exam" ? "Back to modules" : regNav === "portal" ? "Back to member portal" : "Cancel"}
              </button>
            </div>
          </div>
        </div>
      </div>
      </>
    );
  }

  if (appState === "member_pending") {
    const memberDisplayName = displayNameFirstLast(formData, activeRecord?.fullName, user?.displayName);
    const referralCodePending = user?.uid
      ? `PIONEER-${String(user.uid).replace(/-/g, "").slice(-8).toUpperCase()}`
      : "PIONEER-PENDING";
    const rr = membershipLifecycle?.referralRewards;
    const pioneerReferralStats = {
      successfulJoinCount: typeof rr?.successfulJoinCount === "number" ? rr.successfulJoinCount : 0,
      invitesThisMonth: typeof rr?.invitesThisMonth === "number" ? rr.invitesThisMonth : 0,
      pioneerPoints:
        typeof rr?.pioneerPoints === "number"
          ? rr.pioneerPoints
          : (typeof rr?.successfulJoinCount === "number" ? rr.successfulJoinCount * PIONEER_POINTS_PER_JOIN : 0),
    };
    const showLegacyInvitePanel =
      Boolean(membershipLifecycle?.isLegacyFounderImport) &&
      String(membershipLifecycle?.stage || "") === "AWAITING_FULL_PROFILE";
    return (
      <>
        {identityRibbon}
        {portalHomeBar}
        <div className="flex min-h-screen flex-col items-center bg-slate-100/80 p-4 pb-24 pt-8 sm:p-8">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
          <div className="flex w-full max-w-5xl flex-col gap-10">
            {memberPortalIdentityInline}
            {tinModal}
            <ApplicationChecklist lifecycle={membershipLifecycle} />
            <div className="flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={() => openCoopStore()}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl border-2 border-[#004aad]/40 bg-[#004aad]/10 px-5 py-3 text-sm font-black uppercase tracking-wide text-[#004aad] shadow-sm transition hover:border-[#004aad]/60 hover:bg-[#004aad]/15"
              >
                <ShoppingBag className="h-5 w-5 shrink-0" aria-hidden />
                Coop store
              </button>
              {membershipLifecycle?.canAccessFullMemberPortal ? (
                <button
                  type="button"
                  onClick={() => setAppState("member_portal")}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl border-2 border-slate-200 bg-white px-5 py-3 text-sm font-black uppercase tracking-wide text-slate-800 shadow-sm transition hover:border-[#004aad]/40"
                >
                  <IdCard className="h-5 w-5 shrink-0" aria-hidden />
                  Full member portal
                </button>
              ) : null}
            </div>
            <MemberLifecyclePortal
              lifecycle={membershipLifecycle}
              displayName={memberDisplayName}
              email={user?.email || ""}
              loading={membershipLoading}
              apiConfigured={useApiMembership}
              clientPmesPassed={pmesExamPassed}
              onViewCertificate={() => setAppState("certificate")}
              onContinuePmes={() => {
                void continuePmesFromLanding();
              }}
              onOpenLoi={() => {
                setLoiData((prev) => ({
                  ...prev,
                  address: String(prev.address || "").trim() || String(formData.residenceAddress || "").trim() || "",
                }));
                setAppState("loi_form");
              }}
              onOpenPayment={() => setAppState("payment_portal")}
              onRefreshLifecycle={() => refreshMembershipLifecycle()}
              onSubmitFullProfile={async ({
                profileJson,
                sheetFileName,
                notes,
                abortSignal,
                expectedProfileRecordVersion,
              }) => {
                if (!user?.email) throw new Error("You must be signed in to submit the membership form.");
                /** @type {{ success?: boolean; loginEmailUpdated?: boolean; newLoginEmail?: string }} */
                const submitResult = await PmesService.submitFullProfile({
                  email: user.email,
                  profileJson,
                  sheetFileName,
                  notes: notes ?? "",
                  signal: abortSignal,
                  expectedProfileRecordVersion,
                });
                if (submitResult?.loginEmailUpdated && auth.currentUser) {
                  try {
                    await auth.currentUser.getIdToken(true);
                    await reload(auth.currentUser);
                    await auth.currentUser.getIdToken(true);
                  } catch {
                    /* Email may already be updated server-side; user can sign out/in if UI is stale */
                  }
                }
                const row = await refreshMembershipLifecycle();
                const r = row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row) : {};
                let officialContactEmail = "";
                try {
                  const parsed = JSON.parse(profileJson);
                  const c = parsed && typeof parsed === "object" && "contact" in parsed ? parsed.contact : null;
                  if (c && typeof c === "object" && "emailAddress" in c) {
                    officialContactEmail = String(/** @type {{ emailAddress?: string }} */ (c).emailAddress ?? "").trim();
                  }
                } catch {
                  /* ignore */
                }
                let loginEmail =
                  (typeof submitResult?.newLoginEmail === "string" && submitResult.newLoginEmail.trim()) ||
                  auth.currentUser?.email ||
                  user.email ||
                  "";
                /**
                 * Worker full-profile route may not have server-side Firebase Admin email migration. If this member
                 * currently uses a generated placeholder login, try to move Firebase login email to official contact.
                 */
                if (
                  auth.currentUser &&
                  !submitResult?.loginEmailUpdated &&
                  isValidEmailAddress(officialContactEmail) &&
                  officialContactEmail.toLowerCase() !== String(loginEmail || "").trim().toLowerCase() &&
                  isPlaceholderRegistryLoginEmail(loginEmail)
                ) {
                  try {
                    await updateEmail(auth.currentUser, officialContactEmail);
                    await auth.currentUser.getIdToken(true);
                    await reload(auth.currentUser);
                    await auth.currentUser.getIdToken(true);
                    loginEmail = auth.currentUser.email || officialContactEmail;
                    void refreshMembershipLifecycle();
                  } catch {
                    /* keep old login email; member can still change login email later in portal settings */
                  }
                }
                setMemberSubmissionAck({
                  memberIdNo: typeof r.memberIdNo === "string" ? r.memberIdNo.trim() : "",
                  memberIdIsProvisional: r.memberIdIsProvisional === true,
                  loginEmail,
                  officialContactEmail: officialContactEmail || loginEmail,
                  displayName: memberDisplayName || "Member",
                  alternatePublicHandle:
                    typeof r.alternatePublicHandle === "string" ? r.alternatePublicHandle.trim() : "",
                  callsign: typeof r.callsign === "string" ? r.callsign.trim() : "",
                });
                setAppState("member_submission_success");
              }}
            />
            {showLegacyInvitePanel && user ? (
              <ReferralEngine
                memberName={memberDisplayName || "Member"}
                referralCode={referralCodePending}
                successfulJoinCount={pioneerReferralStats.successfulJoinCount}
                pioneerPoints={pioneerReferralStats.pioneerPoints}
                invitesThisMonth={pioneerReferralStats.invitesThisMonth}
              />
            ) : null}
          </div>
        </div>
      </>
    );
  }

  if (appState === "member_submission_success") {
    const ack = memberSubmissionAck;
    return (
      <>
        {identityRibbon}
        {portalHomeBar}
        <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        {ack ? (
          <MemberSubmissionAckScreen
            displayName={ack.displayName}
            loginEmail={ack.loginEmail}
            officialContactEmail={ack.officialContactEmail}
            callsign={ack.callsign}
            memberIdNo={ack.memberIdNo}
            memberIdIsProvisional={ack.memberIdIsProvisional}
            alternatePublicHandle={ack.alternatePublicHandle}
            onContinueToPortal={() => {
              setMemberSubmissionAck(null);
              setAppState("member_portal");
            }}
          />
        ) : (
          <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100/80 p-8">
            <Loader2 className="h-12 w-12 animate-spin text-[#004aad]" aria-hidden />
            <p className="text-sm font-semibold text-slate-600">Loading confirmation…</p>
            <button
              type="button"
              className="text-sm font-bold text-[#004aad] underline"
              onClick={() => setAppState("member_portal")}
            >
              Skip to member portal
            </button>
          </div>
        )}
      </>
    );
  }

  if (appState === "member_portal") {
    const memberDisplayName = displayNameFirstLast(formData, activeRecord?.fullName, user?.displayName);
    const referralCode = user?.uid
      ? `PIONEER-${String(user.uid).replace(/-/g, "").slice(-8).toUpperCase()}`
      : "PIONEER-PENDING";
    const rrPortal = membershipLifecycle?.referralRewards;
    const pioneerReferralStatsPortal = {
      successfulJoinCount: typeof rrPortal?.successfulJoinCount === "number" ? rrPortal.successfulJoinCount : 0,
      invitesThisMonth: typeof rrPortal?.invitesThisMonth === "number" ? rrPortal.invitesThisMonth : 0,
      pioneerPoints:
        typeof rrPortal?.pioneerPoints === "number"
          ? rrPortal.pioneerPoints
          : (typeof rrPortal?.successfulJoinCount === "number"
              ? rrPortal.successfulJoinCount * PIONEER_POINTS_PER_JOIN
              : 0),
    };
    const pioneerPoints = pioneerReferralStatsPortal.pioneerPoints;
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="flex min-h-screen flex-col items-center gap-10 p-4 pb-20 pt-8 sm:p-8">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
          <div className="w-full max-w-5xl space-y-8">
            {memberPortalIdentityInline}
            <div className="text-center">
              <B2CLogo size="lg" align="center" className="mb-4" />
              <h1 className="text-4xl font-black uppercase tracking-tighter text-[#004aad] sm:text-5xl">Member portal</h1>
              <p className="mt-3 text-lg font-semibold text-slate-600">
                Pioneer growth, your profile, and the Coop store — separate from PMES. Certificate and payments still require a passing PMES score.
              </p>
            </div>

            <div className="flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={() => {
                  registrationNavRef.current = "portal";
                  setAppState("registration");
                }}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl border-2 border-[#004aad]/25 bg-white px-5 py-3 text-sm font-black uppercase tracking-wide text-[#004aad] shadow-sm transition hover:border-[#004aad]/50 hover:bg-[#004aad]/5"
              >
                <IdCard className="h-5 w-5 shrink-0" aria-hidden />
                Edit profile
              </button>
              <button
                type="button"
                onClick={() => openCoopStore()}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl border-2 border-[#004aad]/40 bg-[#004aad]/10 px-5 py-3 text-sm font-black uppercase tracking-wide text-[#004aad] shadow-sm transition hover:border-[#004aad]/60 hover:bg-[#004aad]/15"
              >
                <ShoppingBag className="h-5 w-5 shrink-0" aria-hidden />
                Coop store
              </button>
              {pmesExamPassed ? (
                <>
                  <button
                    type="button"
                    onClick={() => setAppState("certificate")}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl border-2 border-slate-200 bg-white px-5 py-3 text-sm font-black uppercase tracking-wide text-slate-800 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-50/80"
                  >
                    <FileText className="h-5 w-5 shrink-0 text-emerald-700" aria-hidden />
                    My certificate
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLoiData((prev) => ({
                        ...prev,
                        address: String(prev.address || "").trim() || String(formData.residenceAddress || "").trim() || "",
                      }));
                      setAppState("loi_form");
                    }}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl border-2 border-slate-200 bg-white px-5 py-3 text-sm font-black uppercase tracking-wide text-slate-800 shadow-sm transition hover:border-[#004aad]/40"
                  >
                    <Briefcase className="h-5 w-5 shrink-0 text-[#004aad]" aria-hidden />
                    Letter of Intent
                  </button>
                  <button
                    type="button"
                    onClick={() => setAppState("payment_portal")}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl border-2 border-slate-200 bg-white px-5 py-3 text-sm font-black uppercase tracking-wide text-slate-800 shadow-sm transition hover:border-amber-300 hover:bg-amber-50/80"
                  >
                    <Coins className="h-5 w-5 shrink-0 text-amber-700" aria-hidden />
                    Payments
                  </button>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setRetrievalData((d) => ({ ...d, email: user?.email || d.email }));
                  setAppState("login_retrieval");
                }}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl border-2 border-slate-200 bg-slate-50 px-5 py-3 text-sm font-bold text-slate-700 shadow-sm transition hover:border-slate-300"
              >
                Retrieve certificate
              </button>
            </div>

            {user ? (
              <ReferralEngine
                memberName={memberDisplayName || "Member"}
                referralCode={referralCode}
                successfulJoinCount={pioneerReferralStatsPortal.successfulJoinCount}
                pioneerPoints={pioneerPoints}
                invitesThisMonth={pioneerReferralStatsPortal.invitesThisMonth}
              />
            ) : null}

            {user && membershipLifecycle?.participantId ? (
              <>
                <MemberPassbookCard
                  email={formData.email || user?.email || ""}
                  getFirebaseIdToken={async () => {
                    if (!auth?.currentUser) throw new Error("Sign in required");
                    return auth.currentUser.getIdToken();
                  }}
                />
                <MemberPatronageCard
                  email={formData.email || user?.email || ""}
                  getFirebaseIdToken={async () => {
                    if (!auth?.currentUser) throw new Error("Sign in required");
                    return auth.currentUser.getIdToken();
                  }}
                />
              </>
            ) : null}

            {user ? (
              <div className="-mx-4 sm:-mx-8">
                <MemberSpotlight membersOnly memberCount={PUBLIC_MEMBER_COUNT} />
              </div>
            ) : null}
          </div>
        </div>
      </>
    );
  }

  if (appState === "admin_login")
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="flex min-h-screen items-center justify-center bg-[#004aad]/5 p-4 sm:p-8 lg:p-12">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <form onSubmit={handleAdminLoginSubmit} className="card-senior w-full max-w-4xl space-y-8 p-6 sm:p-10">
          <div className="grid gap-8 lg:grid-cols-5 lg:items-center">
            <div className="text-center lg:col-span-3 lg:text-left">
              <B2CLogo size="lg" align="center" className="mb-4 lg:mx-0" />
              <Briefcase className="mx-auto h-14 w-14 text-[#004aad] lg:mx-0" aria-hidden />
              <p className="text-xs font-black uppercase tracking-widest text-[#004aad]/80">Staff access</p>
              <h1 className="mt-2 text-3xl font-black uppercase tracking-tighter text-[#004aad] sm:text-4xl lg:text-5xl">Admin sign in</h1>
              <p className="mt-3 text-base font-medium leading-relaxed text-slate-600 lg:max-w-xl">
                Superuser and admin accounts live in the API database. Create the bootstrap superuser once with{" "}
                <code className="rounded bg-slate-100 px-1 text-sm">npm run create-superuser</code> in{" "}
                <code className="rounded bg-slate-100 px-1 text-sm">backend/</code>. Admins are created by the superuser from
                the dashboard.
              </p>
            </div>
            <div className="space-y-4 lg:col-span-2">
              {error ? <div className="rounded-2xl bg-amber-50 p-4 text-center font-bold text-amber-900">{error}</div> : null}
              <div className="relative">
                <Mail className="absolute left-4 top-3.5 h-5 w-5 text-slate-400" aria-hidden />
                <input
                  type="email"
                  autoComplete="username"
                  className="input-field pl-12"
                  placeholder="Admin email"
                  value={adminCreds.email}
                  onChange={(e) => setAdminCreds((c) => ({ ...c, email: e.target.value }))}
                  required
                />
                <p className="mt-2 text-xs font-medium leading-snug text-slate-500">
                  Staff sign-in uses the email on your cooperative admin account (StaffUser), not your member callsign.
                  The browser requires a normal email shape (include @). From Home, Admin portal can open without this
                  form when you are already signed in to Google and that email has a staff profile.
                </p>
              </div>
              <div className="relative">
                <Lock className="absolute left-4 top-3.5 h-5 w-5 text-slate-400" aria-hidden />
                <input
                  type="password"
                  autoComplete="current-password"
                  className="input-field pl-12"
                  placeholder="Password"
                  value={adminCreds.password}
                  onChange={(e) => setAdminCreds((c) => ({ ...c, password: e.target.value }))}
                  required
                  minLength={6}
                />
              </div>
              <button type="submit" disabled={loading} className="btn-primary flex w-full items-center justify-center gap-2 py-5 text-lg sm:text-xl">
                {loading ? <Loader2 className="animate-spin" /> : null}
                Open master list
              </button>
              <button type="button" onClick={() => setAppState("landing")} className="w-full font-bold text-slate-500 hover:text-[#004aad]">
                Back to home
              </button>
            </div>
          </div>
        </form>
      </div>
      </>
    );

  if (appState === "admin_dashboard")
    return (
      <>
        {identityRibbon}{portalHomeBar}
        <div className="min-h-screen bg-slate-50 p-4 sm:p-8 lg:p-12">
          <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
        <div className="mx-auto max-w-7xl overflow-hidden rounded-3xl bg-white shadow-xl lg:rounded-[2.5rem]">
          <div className="flex flex-col gap-5 bg-[#004aad] p-5 text-white sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-8 md:p-10">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 md:gap-5">
              <B2CLogo size="nav" className="shrink-0 self-start drop-shadow-sm" />
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-white/80 sm:text-xs">Admin</p>
                <h1 className="text-2xl font-black uppercase tracking-tight sm:text-3xl">PMES master list</h1>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
              {(() => {
                const accountingUrl = (import.meta.env.VITE_ACCOUNTING_APP_URL || "").trim();
                if (!accountingUrl || !canOpenAccounting(staffRole)) return null;
                return (
                  <a
                    href={accountingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-xl bg-white/15 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-white ring-1 ring-white/30 hover:bg-white/25"
                  >
                    Treasury
                  </a>
                );
              })()}
              {staffAccessToken ? (
                <button
                  type="button"
                  onClick={() => setAppState("landing")}
                  className="rounded-xl bg-white/15 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-white ring-1 ring-white/30 hover:bg-white/25"
                >
                  Member site
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setMasterList([]);
                  setRegistryRows([]);
                  setRegistryTotal(0);
                  setRegistryPage(1);
                  setRegistrySearchInput("");
                  setRegistryAppliedSearch("");
                  setRegistryIncludeAll(false);
                  setRegistryDetail(null);
                  setRegistryDetailTab("summary");
                  setAdminCreds({ email: "", password: "" });
                  setStaffRole(null);
                  setStaffDbRole(null);
                  setStaffAccessToken(null);
                  setStaffSessionEmail(null);
                  setManagedStaffAdmins([]);
                  setNewStaffAdmin({ email: "", password: "" });
                  setStaffAdminError(null);
                  setStaffPasswordForm({ currentPassword: "", newPassword: "" });
                  setStaffPasswordError(null);
                  setStaffPasswordSuccess(null);
                  setStaffPasswordPanelOpen(false);
                  setAdminAccountsPanelOpen(false);
                  setDeletingMasterListId(null);
                  setDeletingPipelineParticipantId(null);
                  clearStaffSession();
                  setAppState("landing");
                }}
                className="shrink-0 rounded-xl bg-white/20 px-6 py-3 text-sm font-bold uppercase tracking-widest hover:bg-white/30"
              >
                Logout
              </button>
            </div>
          </div>
          {staffForBanner ? (
            <div
              className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-200 bg-slate-50 px-6 py-1.5 text-slate-800 sm:gap-x-3 sm:px-10"
              role="status"
              aria-live="polite"
            >
              <Briefcase className="h-3.5 w-3.5 shrink-0 text-[#004aad] sm:h-4 sm:w-4" aria-hidden />
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 sm:text-[10px]">
                Staff signed in
              </span>
              <span className="font-black text-slate-900 sm:text-sm">
                {staffForBanner.role === "superuser" ? "Superuser" : "Admin"}
              </span>
              <span className="text-slate-300" aria-hidden>
                ·
              </span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-600">{staffForBanner.email}</span>
            </div>
          ) : null}
          {staffInboxSummary && useApiMembership ? (
            <div className="border-b border-amber-200 bg-amber-50/95 px-6 py-4 lg:px-10">
              <div className="flex gap-3">
                <Briefcase className="mt-0.5 h-5 w-5 shrink-0 text-amber-800" aria-hidden />
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-widest text-amber-900/80">Cooperative inbox</p>
                  <ul className="mt-2 list-inside list-disc space-y-1 text-sm font-semibold text-amber-950">
                    {staffInboxSummary.lines.map((line, idx) => (
                      <li key={`${idx}-${line.slice(0, 48)}`} className="leading-snug">
                        {line}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs font-medium text-amber-900/80">
                    Open the <strong>Membership pipeline</strong> section (expand below) to pick a member and record the action.
                  </p>
                </div>
              </div>
            </div>
          ) : null}
          <div className="border-b border-slate-200 bg-slate-50 px-6 py-5 lg:px-10">
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => openCoopStore()}
                className="rounded-xl border-2 border-[#004aad]/35 bg-[#004aad]/10 px-5 py-3 text-sm font-black uppercase tracking-wide text-[#004aad] shadow-sm hover:border-[#004aad]/55 hover:bg-[#004aad]/15"
              >
                <span className="inline-flex items-center gap-2">
                  <ShoppingBag className="h-5 w-5 shrink-0" aria-hidden />
                  Coop store (dev)
                </span>
              </button>
              <button
                type="button"
                onClick={() => setStaffPasswordPanelOpen((o) => !o)}
                aria-expanded={staffPasswordPanelOpen}
                className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-black uppercase tracking-wide text-slate-800 shadow-sm hover:bg-slate-50"
              >
                {staffPasswordPanelOpen ? "Hide staff password" : "Staff password"}
              </button>
              {staffRole === "superuser" ? (
                <button
                  type="button"
                  onClick={() => setAdminAccountsPanelOpen((o) => !o)}
                  aria-expanded={adminAccountsPanelOpen}
                  className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-black uppercase tracking-wide text-slate-800 shadow-sm hover:bg-slate-50"
                >
                  {adminAccountsPanelOpen ? "Hide admin accounts" : "Admin accounts"}
                </button>
              ) : null}
            </div>
            {staffPasswordPanelOpen ? (
              <div className="mt-6 border-t border-slate-200 pt-6">
                <h2 className="text-lg font-black uppercase tracking-tight text-slate-900">Staff password</h2>
                <p className="mt-1 text-sm font-medium text-slate-600">
                  Change your own admin/superuser password from here.
                </p>
                {staffPasswordError ? (
                  <div className="mt-4 rounded-2xl bg-red-50 p-4 text-center text-sm font-bold text-red-800">
                    {staffPasswordError}
                  </div>
                ) : null}
                {staffPasswordSuccess ? (
                  <div className="mt-4 rounded-2xl bg-emerald-50 p-4 text-center text-sm font-bold text-emerald-800">
                    {staffPasswordSuccess}
                  </div>
                ) : null}
                <form onSubmit={handleChangeStaffPasswordSubmit} className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:gap-6">
                  <div className="min-w-0 flex-1">
                    <label className="mb-1 block text-xs font-black uppercase tracking-wider text-slate-500" htmlFor="staff-current-password">
                      Current password
                    </label>
                    <input
                      id="staff-current-password"
                      type="password"
                      autoComplete="current-password"
                      className="input-field w-full"
                      placeholder="Current password"
                      value={staffPasswordForm.currentPassword}
                      onChange={(e) => {
                        setStaffPasswordError(null);
                        setStaffPasswordSuccess(null);
                        setStaffPasswordForm((s) => ({ ...s, currentPassword: e.target.value }));
                      }}
                      minLength={8}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <label className="mb-1 block text-xs font-black uppercase tracking-wider text-slate-500" htmlFor="staff-new-password">
                      New password
                    </label>
                    <input
                      id="staff-new-password"
                      type="password"
                      autoComplete="new-password"
                      className="input-field w-full"
                      placeholder="Min. 8 characters"
                      value={staffPasswordForm.newPassword}
                      onChange={(e) => {
                        setStaffPasswordError(null);
                        setStaffPasswordSuccess(null);
                        setStaffPasswordForm((s) => ({ ...s, newPassword: e.target.value }));
                      }}
                      minLength={8}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading || !staffAccessToken}
                    className="btn-primary inline-flex shrink-0 items-center justify-center gap-2 px-8 py-4 font-black lg:self-stretch"
                  >
                    Update password
                  </button>
                </form>
              </div>
            ) : null}
            {staffRole === "superuser" && adminAccountsPanelOpen ? (
              <div className="mt-6 border-t border-slate-200 pt-6">
                <h2 className="text-lg font-black uppercase tracking-tight text-slate-900">Admin accounts</h2>
                <p className="mt-1 text-sm font-medium text-slate-600">
                  Only you (superuser) can add staff admins. They can open this master list but cannot create other accounts.
                </p>
                {staffAdminError ? (
                  <div className="mt-4 rounded-2xl bg-red-50 p-4 text-center text-sm font-bold text-red-800">{staffAdminError}</div>
                ) : null}
                <form onSubmit={handleCreateStaffAdminSubmit} className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:gap-6">
                  <div className="min-w-0 flex-1">
                    <label className="mb-1 block text-xs font-black uppercase tracking-wider text-slate-500" htmlFor="new-admin-email">
                      New admin email
                    </label>
                    <input
                      id="new-admin-email"
                      type="email"
                      autoComplete="off"
                      className="input-field w-full"
                      placeholder="colleague@example.com"
                      value={newStaffAdmin.email}
                      onChange={(e) => setNewStaffAdmin((s) => ({ ...s, email: e.target.value }))}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <label className="mb-1 block text-xs font-black uppercase tracking-wider text-slate-500" htmlFor="new-admin-password">
                      Temporary password
                    </label>
                    <input
                      id="new-admin-password"
                      type="password"
                      autoComplete="new-password"
                      className="input-field w-full"
                      placeholder="Min. 8 characters"
                      value={newStaffAdmin.password}
                      onChange={(e) => setNewStaffAdmin((s) => ({ ...s, password: e.target.value }))}
                      minLength={8}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="btn-primary inline-flex shrink-0 items-center justify-center gap-2 px-8 py-4 font-black lg:self-stretch"
                  >
                    <UserPlus className="h-5 w-5 shrink-0" aria-hidden />
                    Create admin
                  </button>
                </form>
                {managedStaffAdmins.length > 0 ? (
                  <ul className="mt-8 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
                    {managedStaffAdmins.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                        <span className="font-bold text-slate-900">{a.email}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold uppercase text-slate-400">{a.role}</span>
                          <button
                            type="button"
                            onClick={() => void handlePromoteAdminToSuperuser(a.email)}
                            disabled={loading}
                            className="rounded-lg border border-blue-200 px-3 py-1 text-xs font-bold uppercase tracking-wider text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Make superuser
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-6 text-sm font-medium text-slate-500">No admin accounts yet — add one above.</p>
                )}
              </div>
            ) : null}
          </div>
          <div className="border-t border-slate-200 bg-white px-6 py-3 lg:px-10">
            <button
              type="button"
              onClick={() => setAdminDashPmesRecordsOpen((o) => !o)}
              aria-expanded={adminDashPmesRecordsOpen}
              className="flex w-full items-center justify-between gap-3 rounded-xl py-2 text-left text-slate-900 hover:bg-slate-50"
            >
              <div className="min-w-0">
                <span className="text-base font-black uppercase tracking-tight sm:text-lg">PMES exam records</span>
                <span className="ml-2 text-sm font-medium text-slate-500">({masterList.length} loaded)</span>
              </div>
              <ChevronDown
                className={`h-5 w-5 shrink-0 text-slate-500 transition-transform ${adminDashPmesRecordsOpen ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
            {adminDashPmesRecordsOpen ? (
              <div className="mt-3 overflow-x-auto border-t border-slate-100 pt-4">
            <table className="w-full min-w-[56rem] text-left text-sm">
              <thead className="bg-slate-100 text-xs font-bold uppercase tracking-wider text-slate-600">
                <tr>
                  <th className="p-4 lg:p-5">Participant</th>
                  <th className="p-4 lg:p-5">Email / Phone</th>
                  <th className="p-4 lg:p-5">Date &amp; time</th>
                  <th className="p-4 lg:p-5">Score</th>
                  <th className="p-4 lg:p-5">Status</th>
                  <th className="p-4 lg:p-5 text-center">Certificate</th>
                  {staffRole === "superuser" ? (
                    <th className="p-4 lg:p-5 text-center">Delete</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {masterList.length === 0 ? (
                  <tr>
                    <td colSpan={staffRole === "superuser" ? 7 : 6} className="p-12 text-center text-lg font-semibold text-slate-500">
                      No records loaded. Sign in again from Admin portal or check the API.
                    </td>
                  </tr>
                ) : (
                  masterList.map((item) => {
                    const raw = item.timestamp;
                    const d = raw?.toDate ? raw.toDate() : raw ? new Date(raw) : null;
                    const tsLabel = d && !Number.isNaN(d.getTime()) ? d.toLocaleString("en-PH") : "—";
                    return (
                      <tr key={item.id} className="border-t border-slate-100 hover:bg-slate-50/90">
                        <td className="p-4 align-top lg:p-5">
                          <p className="font-black text-slate-900">{item.fullName}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <p className="text-xs text-slate-500">DOB: {item.dob || "—"}</p>
                            {item.legacyPioneerImport ? (
                              <span className="inline-flex rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-900">
                                Founder import
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="p-4 align-top text-slate-600 lg:p-5">
                          <p className="break-all">{item.email}</p>
                          <p className="text-slate-500">{item.phone || "—"}</p>
                        </td>
                        <td className="p-4 align-top text-slate-700 lg:p-5">
                          <span className="whitespace-nowrap text-xs sm:text-sm">{tsLabel}</span>
                        </td>
                        <td className="p-4 align-top font-black tabular-nums text-slate-900 lg:p-5">
                          {item.score ?? "—"}/10
                        </td>
                        <td className="p-4 align-top lg:p-5">
                          {item.passed ? (
                            <span className="inline-flex rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold uppercase text-emerald-800">
                              Passed
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full bg-amber-100 px-3 py-1 text-xs font-bold uppercase text-amber-900">
                              Not passed
                            </span>
                          )}
                        </td>
                        <td className="p-4 align-top text-center lg:p-5">
                          {item.passed ? (
                            <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveRecord(item);
                                  setAppState("certificate");
                                }}
                                className="inline-flex items-center gap-2 rounded-xl bg-[#004aad]/10 px-3 py-2 text-xs font-bold uppercase text-[#004aad] hover:bg-[#004aad]/20"
                              >
                                <FileText className="h-4 w-4 shrink-0" aria-hidden />
                                View
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setActiveRecord(item);
                                  setAppState("certificate");
                                  setTimeout(() => window.print(), 600);
                                }}
                                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold uppercase text-slate-700 hover:bg-slate-50"
                              >
                                <Printer className="h-4 w-4 shrink-0" aria-hidden />
                                Print
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                        {staffRole === "superuser" ? (
                          <td className="p-4 align-top text-center lg:p-5">
                            <button
                              type="button"
                              disabled={deletingMasterListId === item.id}
                              onClick={() => handleDeleteMasterListRow(item)}
                              className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold uppercase text-red-800 hover:bg-red-100 disabled:opacity-50"
                              title="Remove this PMES row (superuser only)"
                            >
                              {deletingMasterListId === item.id ? (
                                <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                              ) : (
                                <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
                              )}
                              Remove
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
              </div>
            ) : null}
          </div>
          <div className="border-t border-slate-200 bg-slate-50 px-6 py-3 lg:px-10">
            <button
              type="button"
              onClick={() => setAdminDashMemberRegistryOpen((o) => !o)}
              aria-expanded={adminDashMemberRegistryOpen}
              className="flex w-full items-center justify-between gap-3 rounded-xl py-2 text-left hover:bg-slate-100/80"
            >
              <div className="min-w-0">
                <h2 className="text-lg font-black uppercase tracking-tight text-slate-900">Member registry</h2>
                <p className="mt-0.5 text-xs font-medium text-slate-600 sm:text-sm">
                  {registryTotal} in index · expand to search, print, or add a legacy member
                </p>
              </div>
              <ChevronDown
                className={`h-5 w-5 shrink-0 text-slate-600 transition-transform ${adminDashMemberRegistryOpen ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
            {adminDashMemberRegistryOpen ? (
              <div className="mt-4 border-t border-slate-200 pt-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600">
                  Full membership profiles stored in the database (searchable mailing address, civil status, member ID). Use
                  Print / Save as PDF from the print dialog.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {staffRole === "superuser" ? (
                  <button
                    type="button"
                    onClick={() => setAddLegacyOpen(true)}
                    className="inline-flex items-center gap-2 rounded-xl bg-[#004aad] px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-white shadow-sm hover:bg-[#003d99]"
                  >
                    <UserPlus className="h-4 w-4 shrink-0" aria-hidden />
                    Add legacy member
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => printMemberRegistryTable(registryRows, "B2C member registry")}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-800 shadow-sm hover:bg-slate-50"
                >
                  <Printer className="h-4 w-4 shrink-0" aria-hidden />
                  Print / PDF
                </button>
              </div>
            </div>
            {addLegacyOpen ? (
              <div
                className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-900/50 p-4 sm:items-center"
                role="dialog"
                aria-modal="true"
                aria-labelledby="add-legacy-title"
              >
                <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
                  <h3 id="add-legacy-title" className="text-lg font-black uppercase tracking-tight text-slate-900">
                    Add legacy pioneer
                  </h3>
                  <p className="mt-2 text-sm font-medium text-slate-600">
                    Creates the same database row as the bulk import: member can use <strong>Pioneer roster — link your account</strong> with{" "}
                    <strong>name + TIN</strong>. Leave email blank to synthesize one (or set a real email if known).
                  </p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-xs font-black uppercase text-slate-500" htmlFor="add-leg-fn">
                        First name *
                      </label>
                      <input
                        id="add-leg-fn"
                        className="input-field w-full"
                        value={addLegacyForm.firstName}
                        onChange={(e) => setAddLegacyForm((s) => ({ ...s, firstName: e.target.value }))}
                        autoComplete="off"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-xs font-black uppercase text-slate-500" htmlFor="add-leg-mn">
                        Middle name
                      </label>
                      <input
                        id="add-leg-mn"
                        className="input-field w-full"
                        value={addLegacyForm.middleName}
                        onChange={(e) => setAddLegacyForm((s) => ({ ...s, middleName: e.target.value }))}
                        autoComplete="off"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-xs font-black uppercase text-slate-500" htmlFor="add-leg-ln">
                        Last name *
                      </label>
                      <input
                        id="add-leg-ln"
                        className="input-field w-full"
                        value={addLegacyForm.lastName}
                        onChange={(e) => setAddLegacyForm((s) => ({ ...s, lastName: e.target.value }))}
                        autoComplete="off"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-black uppercase text-slate-500" htmlFor="add-leg-tin">
                        TIN (9 digits)
                      </label>
                      <input
                        id="add-leg-tin"
                        className="input-field w-full font-mono"
                        placeholder="000000000 if unknown"
                        value={addLegacyForm.tinNo}
                        onChange={(e) => setAddLegacyForm((s) => ({ ...s, tinNo: e.target.value }))}
                        autoComplete="off"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-black uppercase text-slate-500" htmlFor="add-leg-dob">
                        Date of birth
                      </label>
                      <input
                        id="add-leg-dob"
                        type="text"
                        className="input-field w-full"
                        placeholder="YYYY-MM-DD"
                        value={addLegacyForm.dob}
                        onChange={(e) => setAddLegacyForm((s) => ({ ...s, dob: e.target.value }))}
                        autoComplete="bday"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-black uppercase text-slate-500" htmlFor="add-leg-phone">
                        Phone
                      </label>
                      <input
                        id="add-leg-phone"
                        className="input-field w-full"
                        placeholder="+639…"
                        value={addLegacyForm.phone}
                        onChange={(e) => setAddLegacyForm((s) => ({ ...s, phone: e.target.value }))}
                        autoComplete="tel"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-black uppercase text-slate-500" htmlFor="add-leg-email">
                        Email (optional)
                      </label>
                      <input
                        id="add-leg-email"
                        type="email"
                        className="input-field w-full"
                        value={addLegacyForm.email}
                        onChange={(e) => setAddLegacyForm((s) => ({ ...s, email: e.target.value }))}
                        autoComplete="off"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-black uppercase text-slate-500" htmlFor="add-leg-civil">
                        Civil status
                      </label>
                      <input
                        id="add-leg-civil"
                        className="input-field w-full"
                        value={addLegacyForm.civilStatus}
                        onChange={(e) => setAddLegacyForm((s) => ({ ...s, civilStatus: e.target.value }))}
                        autoComplete="off"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-black uppercase text-slate-500" htmlFor="add-leg-sg">
                        Sex / gender
                      </label>
                      <input
                        id="add-leg-sg"
                        className="input-field w-full"
                        value={addLegacyForm.sexGender}
                        onChange={(e) => setAddLegacyForm((s) => ({ ...s, sexGender: e.target.value }))}
                        autoComplete="off"
                      />
                    </div>
                  </div>
                  <div className="mt-6 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-bold uppercase text-slate-700 hover:bg-slate-50"
                      onClick={() => {
                        setAddLegacyOpen(false);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={addLegacyLoading || !staffAccessToken}
                      className="inline-flex items-center gap-2 rounded-xl bg-[#004aad] px-5 py-2.5 text-sm font-black uppercase text-white hover:bg-[#003d99] disabled:opacity-50"
                      onClick={async () => {
                        if (!staffAccessToken) return;
                        const fn = addLegacyForm.firstName.trim();
                        const ln = addLegacyForm.lastName.trim();
                        if (!fn || !ln) {
                          setAdminToast({ type: "error", message: "First name and last name are required." });
                          return;
                        }
                        setAddLegacyLoading(true);
                        try {
                          const row = {
                            firstName: fn,
                            lastName: ln,
                            ...(addLegacyForm.middleName.trim() ? { middleName: addLegacyForm.middleName.trim() } : {}),
                            ...(addLegacyForm.tinNo.trim() ? { tinNo: addLegacyForm.tinNo.trim() } : {}),
                            ...(addLegacyForm.dob.trim() ? { dob: addLegacyForm.dob.trim() } : {}),
                            ...(addLegacyForm.phone.trim() ? { phone: addLegacyForm.phone.trim() } : {}),
                            ...(addLegacyForm.email.trim() ? { email: addLegacyForm.email.trim() } : {}),
                            ...(addLegacyForm.civilStatus.trim() ? { civilStatus: addLegacyForm.civilStatus.trim() } : {}),
                            ...(addLegacyForm.sexGender.trim() ? { sexGender: addLegacyForm.sexGender.trim() } : {}),
                          };
                          const result = await PmesService.addLegacyPioneer(staffAccessToken, row);
                          const em = result && typeof result === "object" && "email" in result ? String(result.email) : "";
                          setAdminToast({
                            type: "success",
                            message: em
                              ? `Legacy member created. Sign-in / roster email: ${em}`
                              : "Legacy member created.",
                          });
                          setAddLegacyOpen(false);
                          setAddLegacyForm({
                            firstName: "",
                            lastName: "",
                            middleName: "",
                            tinNo: "",
                            phone: "",
                            dob: "",
                            email: "",
                            civilStatus: "",
                            sexGender: "",
                          });
                          setRegistryRefreshNonce((n) => n + 1);
                          try {
                            const next = await PmesService.fetchMembershipPipeline(staffAccessToken);
                            setMembershipPipeline(Array.isArray(next) ? next : []);
                          } catch {
                            /* ignore */
                          }
                        } catch (e) {
                          const msg = e instanceof Error ? e.message : String(e);
                          setAdminToast({ type: "error", message: msg });
                        } finally {
                          setAddLegacyLoading(false);
                        }
                      }}
                    >
                      {addLegacyLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                      Save member
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
            <form
              className="mt-6 flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                setRegistryPage(1);
                setRegistryAppliedSearch(registrySearchInput.trim());
              }}
            >
              <div className="min-w-0 flex-1 lg:max-w-md">
                <label className="mb-1 block text-xs font-black uppercase tracking-wider text-slate-500" htmlFor="registry-search">
                  Search
                </label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-slate-400" aria-hidden />
                  <input
                    id="registry-search"
                    className="input-field w-full pl-11"
                    placeholder="Name, email, phone, address, member ID…"
                    value={registrySearchInput}
                    onChange={(e) => setRegistrySearchInput(e.target.value)}
                  />
                </div>
              </div>
              <button type="submit" className="btn-primary inline-flex items-center justify-center gap-2 px-6 py-3 font-black">
                <Search className="h-4 w-4 shrink-0" aria-hidden />
                Search
              </button>
              <label className="flex cursor-pointer items-center gap-2 text-sm font-bold text-slate-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300"
                  checked={registryIncludeAll}
                  onChange={(e) => {
                    setRegistryIncludeAll(e.target.checked);
                    setRegistryPage(1);
                  }}
                />
                Include participants without a full profile
              </label>
            </form>
            <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="max-h-[min(70vh,28rem)] overflow-auto">
                <table className="w-full min-w-[64rem] text-left text-sm">
                  <thead className="sticky top-0 z-10 bg-slate-100 text-xs font-bold uppercase tracking-wider text-slate-600 shadow-[0_1px_0_0_rgb(226_232_240)]">
                    <tr>
                      <th className="p-4">Member</th>
                      <th className="p-4">Contact</th>
                      <th className="p-4">Civil status</th>
                      <th className="p-4">Member ID</th>
                      <th className="p-4">Position</th>
                    </tr>
                  </thead>
                  <tbody>
                  {registryLoading ? (
                    <tr>
                      <td colSpan={5} className="p-8 text-center font-medium text-slate-500">
                        <Loader2 className="mx-auto h-8 w-8 animate-spin text-[#004aad]" aria-hidden />
                      </td>
                    </tr>
                  ) : registryRows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-8 text-center font-medium text-slate-500">
                        No registry rows yet. Completed full profiles appear here (or enable “include all” to browse
                        participants).
                      </td>
                    </tr>
                  ) : (
                    registryRows.map((row) => {
                      const r = /** @type {Record<string, unknown>} */ (row);
                      const pid = String(r.participantId ?? "");
                      return (
                        <tr
                          key={pid}
                          className="cursor-pointer border-t border-slate-100 hover:bg-slate-50/90"
                          tabIndex={0}
                          role="button"
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.currentTarget.click();
                            }
                          }}
                          onClick={async () => {
                            if (!staffAccessToken) return;
                            try {
                              const detail = await PmesService.fetchParticipantAdminDetail(staffAccessToken, pid);
                              const d = /** @type {Record<string, unknown>} */ (detail);
                              setSuperuserMemberIdDraft(
                                String(
                                  /** @type {Record<string, unknown> | undefined} */ (d.lifecycle)?.memberIdNo ??
                                    /** @type {Record<string, unknown> | undefined} */ (d.registry)?.memberIdNo ??
                                    "",
                                ),
                              );
                              setRegistryDetail(detail);
                              setRegistryDetailTab("summary");
                            } catch {
                              setRegistryDetail(null);
                              setRegistryDetailTab("summary");
                            }
                          }}
                        >
                          <td className="p-4 align-top">
                            <p className="font-bold text-slate-900">{String(r.fullName ?? "—")}</p>
                            <p className="text-xs text-slate-500">DOB: {String(r.dob ?? "—")}</p>
                          </td>
                          <td className="p-4 align-top">
                            <p className="break-all text-slate-800">{String(r.email ?? "")}</p>
                            <p className="text-slate-600">{String(r.phone ?? "—")}</p>
                          </td>
                          <td className="p-4 align-top">{String(r.civilStatus ?? "—")}</td>
                          <td className="p-4 align-top font-mono text-xs">{String(r.memberIdNo ?? "—")}</td>
                          <td className="p-4 align-top text-sm font-medium text-slate-800">
                            {r.staffPosition != null && String(r.staffPosition).trim() ? String(r.staffPosition) : "—"}
                          </td>
                        </tr>
                      );
                    })
                  )}
                  </tbody>
                </table>
              </div>
            </div>
            {registryTotal > 0 ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm font-bold text-slate-600">
                <span className="min-w-0">
                  {(() => {
                    const start = (registryPage - 1) * REGISTRY_PAGE_SIZE + 1;
                    const end = Math.min(registryPage * REGISTRY_PAGE_SIZE, registryTotal);
                    return (
                      <>
                        Showing <span className="tabular-nums">{start}</span>–<span className="tabular-nums">{end}</span> of{" "}
                        <span className="tabular-nums">{registryTotal}</span>
                        {registryTotal > REGISTRY_PAGE_SIZE ? (
                          <span className="font-semibold text-slate-500"> — page {registryPage}</span>
                        ) : null}
                      </>
                    );
                  })()}
                </span>
                {registryTotal > REGISTRY_PAGE_SIZE ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={registryPage <= 1}
                      onClick={() => setRegistryPage((p) => Math.max(1, p - 1))}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-black uppercase tracking-wide disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      disabled={registryPage * REGISTRY_PAGE_SIZE >= registryTotal}
                      onClick={() => setRegistryPage((p) => p + 1)}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-black uppercase tracking-wide disabled:opacity-40"
                    >
                      Next
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
              </div>
            ) : null}
          </div>
          {registryDetail ? (
            <div
              className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/50 p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="registry-detail-title"
              onClick={(e) => {
                if (e.target === e.currentTarget) {
                  setRegistryDetail(null);
                  setRegistryDetailTab("summary");
                  setSuperuserMemberIdDraft("");
                }
              }}
            >
              <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
                <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-[#004aad] px-5 py-4 text-white">
                  <h2 id="registry-detail-title" className="text-lg font-black uppercase tracking-tight">
                    Member profile
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      setRegistryDetail(null);
                      setRegistryDetailTab("summary");
                      setSuperuserMemberIdDraft("");
                    }}
                    className="rounded-lg bg-white/20 px-3 py-1.5 text-sm font-bold hover:bg-white/30"
                  >
                    Close
                  </button>
                </div>
                <div
                  className="flex shrink-0 flex-wrap gap-1 border-b border-slate-200 bg-slate-100 px-2 py-2"
                  role="tablist"
                  aria-label="Member profile sections"
                >
                  {(
                    [
                      ["summary", "Summary"],
                      ["edit", "Edit profile"],
                      ["account", "Account & ID"],
                      ["json", "JSON"],
                    ]
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={registryDetailTab === id}
                      onClick={() => setRegistryDetailTab(/** @type {"summary" | "edit" | "account" | "json"} */ (id))}
                      className={`rounded-lg px-3 py-2 text-xs font-black uppercase tracking-wide transition-colors ${
                        registryDetailTab === id
                          ? "bg-[#004aad] text-white shadow-sm"
                          : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-5 text-sm text-slate-800">
                  {registryDetailTab === "summary" ? (
                    /** @type {Record<string, unknown>} */ (registryDetail).registry ? (
                    <>
                      {(() => {
                        const reg = /** @type {Record<string, unknown>} */ (registryDetail).registry;
                        const life = /** @type {Record<string, unknown> | undefined} */ (registryDetail).lifecycle;
                        const createdRaw = reg.createdAt;
                        let memberSince = "—";
                        if (createdRaw != null && String(createdRaw).trim()) {
                          const d = new Date(String(createdRaw));
                          memberSince = Number.isNaN(d.getTime())
                            ? "—"
                            : d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
                        }
                        const stage = life && life.stage != null ? String(life.stage) : "—";
                        const posLabel =
                          reg.staffPosition != null && String(reg.staffPosition).trim()
                            ? String(reg.staffPosition)
                            : "—";
                        const emailForStaff = String(reg.email ?? "").trim();
                        const staffRoleRaw = reg.staffRole != null ? String(reg.staffRole) : "";
                        const hasStaff = staffRoleRaw.length > 0;
                        const isSuperStaff = staffRoleRaw === "SUPERUSER";
                        const importSnap =
                          registryDetail && typeof registryDetail === "object"
                            ? /** @type {Record<string, unknown>} */ (registryDetail).registryImportSnapshot
                            : undefined;
                        const importedRosterRow =
                          Boolean(reg.legacyPioneerImport) || importSnap != null;
                        const noFirebaseLink =
                          reg.firebaseUid == null || String(reg.firebaseUid ?? "").trim() === "";
                        const legacyUnclaimed = importedRosterRow && noFirebaseLink;
                        const canAssignPosition =
                          (hasStaff && !isSuperStaff) ||
                          (legacyUnclaimed && !isSuperStaff) ||
                          (staffRole === "superuser" && !isSuperStaff && Boolean(emailForStaff));
                        return (
                          <div className="mb-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <p className="text-sm font-semibold text-slate-900">
                              <span className="font-black uppercase tracking-wide text-slate-500">Member since </span>
                              {memberSince}
                            </p>
                            <p className="mt-2 text-sm font-semibold text-slate-900">
                              <span className="font-black uppercase tracking-wide text-slate-500">Application stage </span>
                              {stage}
                            </p>
                            {staffRole === "superuser" ? (
                              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/90 p-3">
                                <p className="text-xs font-black uppercase text-amber-900">Staff position</p>
                                <p className="mt-1 text-xs text-amber-950/90">
                                  Chairperson, Vice Chairperson, and General manager use admin authorization when signing in. For
                                  unclaimed legacy roster rows, saving creates a staff record for this email automatically.
                                </p>
                                <div className="mt-3 flex flex-wrap items-end gap-2">
                                  <label className="text-xs font-bold text-slate-800">
                                    Role
                                    <select
                                      className="mt-1 block w-full min-w-[12rem] rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm"
                                      value={registryStaffRoleSelect}
                                      onChange={(e) => setRegistryStaffRoleSelect(e.target.value)}
                                      disabled={registryStaffPositionSaving || !canAssignPosition || isSuperStaff}
                                    >
                                      <option value="ADMIN">Admin</option>
                                      <option value="CHAIRMAN">Chairperson</option>
                                      <option value="VICE_CHAIRMAN">Vice Chairperson</option>
                                      <option value="GENERAL_MANAGER">General manager</option>
                                      <option value="TREASURER">Treasurer</option>
                                      <option value="SECRETARY">Secretary</option>
                                      <option value="BOARD_DIRECTOR">Board director</option>
                                    </select>
                                  </label>
                                  <button
                                    type="button"
                                    disabled={
                                      registryStaffPositionSaving ||
                                      !staffAccessToken ||
                                      !canAssignPosition ||
                                      !emailForStaff ||
                                      isSuperStaff
                                    }
                                    className="rounded-lg bg-[#004aad] px-4 py-2 text-xs font-black uppercase text-white hover:bg-[#003d99] disabled:opacity-50"
                                    onClick={async () => {
                                      if (!staffAccessToken || !emailForStaff) return;
                                      setRegistryStaffPositionSaving(true);
                                      try {
                                        await PmesService.patchMemberStaffPosition(
                                          staffAccessToken,
                                          emailForStaff,
                                          registryStaffRoleSelect,
                                        );
                                        const pid = String(reg.participantId ?? "");
                                        const detail = await PmesService.fetchParticipantAdminDetail(
                                          staffAccessToken,
                                          pid,
                                        );
                                        setRegistryDetail(detail);
                                        setRegistryRefreshNonce((n) => n + 1);
                                        setAdminToast({ type: "success", message: "Staff position updated." });
                                      } catch (e) {
                                        const msg = e instanceof Error ? e.message : String(e);
                                        setAdminToast({ type: "error", message: msg });
                                      } finally {
                                        setRegistryStaffPositionSaving(false);
                                      }
                                    }}
                                  >
                                    {registryStaffPositionSaving ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                    ) : null}
                                    Save position
                                  </button>
                                </div>
                                {!hasStaff && !legacyUnclaimed && staffRole !== "superuser" ? (
                                  <p className="mt-2 text-xs font-medium text-amber-900">
                                    No staff login on this email — add one in Admin accounts, then assign a role here.
                                  </p>
                                ) : null}
                                {!hasStaff && !legacyUnclaimed && staffRole === "superuser" ? (
                                  <p className="mt-2 text-xs font-medium text-amber-900">
                                    No staff row yet. Choose a role and save — a staff login is created for this email
                                    (random password until you set one in Admin accounts). Same Google email can use Admin
                                    portal without the staff password.
                                  </p>
                                ) : null}
                                {legacyUnclaimed && !hasStaff ? (
                                  <p className="mt-2 text-xs font-medium text-amber-900">
                                    Legacy member not yet claimed — choose a position and save to create the staff record.
                                  </p>
                                ) : null}
                                {isSuperStaff ? (
                                  <p className="mt-2 text-xs font-medium text-amber-900">
                                    Superuser staff accounts cannot be changed from this screen.
                                  </p>
                                ) : null}
                              </div>
                            ) : (
                              <p className="mt-2 text-sm">
                                <span className="font-black uppercase tracking-wide text-slate-500">Position </span>
                                {posLabel}
                              </p>
                            )}
                          </div>
                        );
                      })()}
                      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {Object.entries(/** @type {Record<string, unknown>} */ (registryDetail).registry)
                          .filter(([k]) => k !== "staffRole")
                          .map(([k, v]) => (
                            <div key={k}>
                              <dt className="text-xs font-black uppercase text-slate-500">{k}</dt>
                              <dd className="font-medium break-words">{v === null || v === undefined ? "—" : String(v)}</dd>
                            </div>
                          ))}
                      </dl>
                    </>
                  ) : (
                    <p className="text-sm font-medium text-slate-500">No registry data for this participant.</p>
                  )
                  ) : null}
                  {registryDetailTab === "edit" &&
                    (registryProfileDraft && staffAccessToken ? (
                    <div className="rounded-2xl border border-slate-200 bg-slate-50/90 p-4">
                      <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">Edit member record</h3>
                      <p className="mt-1 text-xs font-medium text-slate-600">
                        Saves to the database. If this member has a linked Firebase account, changing email also updates Firebase
                        Auth (requires server Firebase service account).
                      </p>
                      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="text-xs font-bold text-slate-700">
                          <span className="mb-1 block uppercase tracking-wide">Full name</span>
                          <input
                            type="text"
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            value={registryProfileDraft.fullName}
                            onChange={(e) => setRegistryProfileDraft((d) => (d ? { ...d, fullName: e.target.value } : d))}
                            autoComplete="off"
                          />
                        </label>
                        <label className="text-xs font-bold text-slate-700">
                          <span className="mb-1 block uppercase tracking-wide">Email (sign-in)</span>
                          <input
                            type="email"
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            value={registryProfileDraft.email}
                            onChange={(e) => setRegistryProfileDraft((d) => (d ? { ...d, email: e.target.value } : d))}
                            autoComplete="off"
                          />
                        </label>
                        <label className="text-xs font-bold text-slate-700">
                          <span className="mb-1 block uppercase tracking-wide">Phone</span>
                          <input
                            type="text"
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            value={registryProfileDraft.phone}
                            onChange={(e) => setRegistryProfileDraft((d) => (d ? { ...d, phone: e.target.value } : d))}
                            autoComplete="off"
                          />
                        </label>
                        <label className="text-xs font-bold text-slate-700">
                          <span className="mb-1 block uppercase tracking-wide">Date of birth</span>
                          <input
                            type="text"
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            value={registryProfileDraft.dob}
                            onChange={(e) => setRegistryProfileDraft((d) => (d ? { ...d, dob: e.target.value } : d))}
                            autoComplete="off"
                          />
                        </label>
                        <label className="text-xs font-bold text-slate-700">
                          <span className="mb-1 block uppercase tracking-wide">Gender</span>
                          <input
                            type="text"
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            value={registryProfileDraft.gender}
                            onChange={(e) => setRegistryProfileDraft((d) => (d ? { ...d, gender: e.target.value } : d))}
                            autoComplete="off"
                          />
                        </label>
                        <label className="text-xs font-bold text-slate-700">
                          <span className="mb-1 block uppercase tracking-wide">TIN (digits)</span>
                          <input
                            type="text"
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-mono"
                            value={registryProfileDraft.tinNo}
                            onChange={(e) => setRegistryProfileDraft((d) => (d ? { ...d, tinNo: e.target.value } : d))}
                            autoComplete="off"
                          />
                        </label>
                        <label className="sm:col-span-2 text-xs font-bold text-slate-700">
                          <span className="mb-1 block uppercase tracking-wide">Mailing address</span>
                          <textarea
                            className="min-h-[4rem] w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            value={registryProfileDraft.mailingAddress}
                            onChange={(e) => setRegistryProfileDraft((d) => (d ? { ...d, mailingAddress: e.target.value } : d))}
                            rows={2}
                            spellCheck={false}
                          />
                        </label>
                        <label className="text-xs font-bold text-slate-700">
                          <span className="mb-1 block uppercase tracking-wide">Civil status</span>
                          <input
                            type="text"
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                            value={registryProfileDraft.civilStatus}
                            onChange={(e) => setRegistryProfileDraft((d) => (d ? { ...d, civilStatus: e.target.value } : d))}
                            autoComplete="off"
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        disabled={registryProfileSaving || !staffAccessToken}
                        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[#004aad] px-5 py-2.5 text-sm font-black uppercase text-white hover:bg-[#003d99] disabled:opacity-50"
                        onClick={async () => {
                          if (!staffAccessToken || !registryProfileDraft) return;
                          const reg = /** @type {Record<string, unknown>} */ (registryDetail).registry;
                          const pid = reg && reg.participantId != null ? String(reg.participantId) : "";
                          if (!pid) return;
                          setRegistryProfileSaving(true);
                          try {
                            const detail = await PmesService.patchAdminParticipantProfile(
                              staffAccessToken,
                              pid,
                              registryProfileDraft,
                            );
                            setRegistryDetail(detail);
                            setAdminToast({ type: "success", message: "Member record updated." });
                          } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);
                            setAdminToast({ type: "error", message: msg });
                          } finally {
                            setRegistryProfileSaving(false);
                          }
                        }}
                      >
                        {registryProfileSaving ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden /> : null}
                        Save changes
                      </button>
                    </div>
                  ) : (
                    <p className="text-sm font-medium text-slate-500">Loading editable fields…</p>
                  ))}
                  {registryDetailTab === "account" ? (
                    <div className="space-y-6">
                  {staffAccessToken && registryProfileDraft ? (
                    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/90 p-4">
                      <h3 className="text-xs font-black uppercase tracking-wider text-indigo-950">Reset member password</h3>
                      <p className="mt-1 text-xs font-medium text-indigo-950/90">
                        Sets a new Firebase password immediately. Share it with the member through a secure channel.
                      </p>
                      {String(
                        /** @type {Record<string, unknown> | undefined} */ (/** @type {Record<string, unknown>} */ (registryDetail).registry)?.firebaseUid ??
                          "",
                      ).trim() ? (
                        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                          <label className="min-w-0 flex-1 text-xs font-bold text-slate-700">
                            <span className="mb-1 block uppercase tracking-wide">New password</span>
                            <input
                              type="password"
                              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                              value={memberResetPwd.newPassword}
                              onChange={(e) => setMemberResetPwd((p) => ({ ...p, newPassword: e.target.value }))}
                              autoComplete="new-password"
                            />
                          </label>
                          <label className="min-w-0 flex-1 text-xs font-bold text-slate-700">
                            <span className="mb-1 block uppercase tracking-wide">Confirm</span>
                            <input
                              type="password"
                              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                              value={memberResetPwd.confirm}
                              onChange={(e) => setMemberResetPwd((p) => ({ ...p, confirm: e.target.value }))}
                              autoComplete="new-password"
                            />
                          </label>
                          <button
                            type="button"
                            disabled={memberResetPwdSaving || !staffAccessToken}
                            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-indigo-700 px-4 py-2.5 text-xs font-black uppercase text-white hover:bg-indigo-800 disabled:opacity-50"
                            onClick={async () => {
                              if (!staffAccessToken) return;
                              const reg = /** @type {Record<string, unknown>} */ (registryDetail).registry;
                              const pid = reg && reg.participantId != null ? String(reg.participantId) : "";
                              if (!pid) return;
                              const a = String(memberResetPwd.newPassword ?? "").trim();
                              const b = String(memberResetPwd.confirm ?? "").trim();
                              if (a.length < 6) {
                                setAdminToast({ type: "error", message: "Password must be at least 6 characters." });
                                return;
                              }
                              if (a !== b) {
                                setAdminToast({ type: "error", message: "Password and confirmation do not match." });
                                return;
                              }
                              setMemberResetPwdSaving(true);
                              try {
                                await PmesService.resetMemberFirebasePassword(staffAccessToken, pid, a);
                                setMemberResetPwd({ newPassword: "", confirm: "" });
                                setAdminToast({ type: "success", message: "Member password updated in Firebase." });
                              } catch (e) {
                                const msg = e instanceof Error ? e.message : String(e);
                                setAdminToast({ type: "error", message: msg });
                              } finally {
                                setMemberResetPwdSaving(false);
                              }
                            }}
                          >
                            {memberResetPwdSaving ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden /> : null}
                            Set password
                          </button>
                        </div>
                      ) : (
                        <p className="mt-3 text-sm font-semibold text-indigo-900">
                          No Firebase account is linked to this record yet. The member must sign in (or sync) once; then you can
                          set a password here.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm font-medium text-slate-500">
                      Reset password appears here after member fields load (same as Edit profile).
                    </p>
                  )}
                  {staffRole === "superuser" && /** @type {Record<string, unknown>} */ (registryDetail).registry ? (
                    <div className="rounded-2xl border border-amber-200 bg-amber-50/90 p-4">
                      <h3 className="text-xs font-black uppercase tracking-wider text-amber-950">Superuser: member ID</h3>
                      <p className="mt-1 text-xs font-medium text-amber-950/90">
                        Correct an auto-generated ID (e.g. wrong birth-year segment). Value must stay unique across all members.
                      </p>
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                        <label className="min-w-0 flex-1 text-xs font-bold text-slate-700">
                          <span className="mb-1 block uppercase tracking-wide">B2C member ID</span>
                          <input
                            type="text"
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-slate-900"
                            value={superuserMemberIdDraft}
                            onChange={(e) => setSuperuserMemberIdDraft(e.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={superuserMemberIdSaving}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={superuserMemberIdSaving || !staffAccessToken}
                          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-amber-700 px-4 py-2.5 text-xs font-black uppercase text-white hover:bg-amber-800 disabled:opacity-50"
                          onClick={async () => {
                            if (!staffAccessToken) return;
                            const reg = /** @type {Record<string, unknown>} */ (registryDetail).registry;
                            const pid = reg && reg.participantId != null ? String(reg.participantId) : "";
                            if (!pid) return;
                            setSuperuserMemberIdSaving(true);
                            try {
                              await PmesService.superuserSetMemberId(
                                staffAccessToken,
                                pid,
                                superuserMemberIdDraft,
                              );
                              const detail = await PmesService.fetchParticipantAdminDetail(staffAccessToken, pid);
                              const d = /** @type {Record<string, unknown>} */ (detail);
                              setSuperuserMemberIdDraft(
                                String(
                                  /** @type {Record<string, unknown> | undefined} */ (d.lifecycle)?.memberIdNo ??
                                    /** @type {Record<string, unknown> | undefined} */ (d.registry)?.memberIdNo ??
                                    "",
                                ),
                              );
                              setRegistryDetail(detail);
                              setAdminToast({ type: "success", message: "Member ID updated." });
                            } catch (e) {
                              const msg = e instanceof Error ? e.message : String(e);
                              setAdminToast({ type: "error", message: msg });
                            } finally {
                              setSuperuserMemberIdSaving(false);
                            }
                          }}
                        >
                          {superuserMemberIdSaving ? (
                            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                          ) : null}
                          Save ID
                        </button>
                      </div>
                    </div>
                  ) : null}
                    </div>
                  ) : null}
                  {registryDetailTab === "json" ? (
                    <>
                      <h3 className="text-xs font-black uppercase tracking-wider text-slate-500">Full membership JSON</h3>
                      <pre className="mt-2 max-h-[min(70vh,36rem)] overflow-auto rounded-xl bg-slate-50 p-3 text-xs leading-relaxed">
                        {JSON.stringify(/** @type {Record<string, unknown>} */ (registryDetail).memberProfileSnapshot ?? {}, null, 2)}
                      </pre>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
          <div className="border-t border-slate-200 bg-slate-50 px-6 py-3 lg:px-10">
            <button
              type="button"
              onClick={() => setAdminDashLegacyImportOpen((o) => !o)}
              aria-expanded={adminDashLegacyImportOpen}
              className="flex w-full items-center justify-between gap-3 rounded-xl py-2 text-left hover:bg-slate-100/80"
            >
              <div className="min-w-0">
                <h2 className="text-lg font-black uppercase tracking-tight text-slate-900">Legacy pioneer import</h2>
                <p className="mt-0.5 text-xs font-medium text-slate-600 sm:text-sm">
                  Bulk JSON roster import · expand to edit draft and save to the database
                </p>
              </div>
              <ChevronDown
                className={`h-5 w-5 shrink-0 text-slate-600 transition-transform ${adminDashLegacyImportOpen ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
            {adminDashLegacyImportOpen ? (
              <div className="mt-4 border-t border-slate-200 pt-6">
            <p className="text-sm font-medium text-slate-600">
              Preload roster members so they can use <strong>Pioneer roster — link your account</strong> on the home menu. Paste a
              JSON array: full B2C registry shape (<code className="rounded bg-slate-200 px-1">lastName</code>,{" "}
              <code className="rounded bg-slate-200 px-1">firstName</code>, <code className="rounded bg-slate-200 px-1">middleName</code>,{" "}
              <code className="rounded bg-slate-200 px-1">civilStatus</code>, address fields, <code className="rounded bg-slate-200 px-1">tinNo</code>, share amounts,{" "}
              <code className="rounded bg-slate-200 px-1">religion</code>, optional <code className="rounded bg-slate-200 px-1">sheet</code>).{" "}
              <code className="rounded bg-slate-200 px-1">email</code> / <code className="rounded bg-slate-200 px-1">phone</code> /{" "}
              <code className="rounded bg-slate-200 px-1">dob</code> optional — missing email is synthesized (often from TIN); missing DOB defaults to{" "}
              <code className="rounded bg-slate-200 px-1">1900-01-01</code>; missing TIN is stored as{" "}
              <code className="rounded bg-slate-200 px-1">000000000</code> on the TIN field (cooperative member ID is assigned separately when the member loads the portal). Members reclaim with <strong>name + TIN</strong> on the public screen; the API returns their
              sign-in email. Rows are created at <strong>AWAITING_FULL_PROFILE</strong>. Export Sheets as TSV and run{" "}
              <code className="rounded bg-slate-200 px-1">node scripts/legacy-import-tsv-to-json.mjs</code> to build JSON.
            </p>
            <p className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50/90 px-4 py-3 text-sm font-semibold text-emerald-950">
              <strong className="font-black">Saving to the database:</strong> the box below is only your draft. Nothing is written to the server until you click{" "}
              <span className="whitespace-nowrap font-black">Import &amp; save to database</span>. That sends one request to the API; new members are inserted into Postgres immediately (no separate Save
              button).
            </p>
            <textarea
              className="mt-4 w-full rounded-2xl border border-slate-200 bg-white p-4 font-mono text-xs leading-relaxed text-slate-800 shadow-inner"
              rows={10}
              value={legacyImportJson}
              onChange={(e) => setLegacyImportJson(e.target.value)}
              spellCheck={false}
              aria-label="Legacy import JSON array"
            />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={legacyImportLoading || !staffAccessToken}
                onClick={async () => {
                  setLegacyImportMsg(null);
                  setLegacyImportMsgKind(null);
                  setLegacyImportLoading(true);
                  try {
                    const rows = JSON.parse(legacyImportJson);
                    if (!Array.isArray(rows)) throw new Error("JSON must be an array.");
                    const result = await PmesService.importLegacyPioneers(staffAccessToken, rows);
                    const created = Array.isArray(result?.created) ? result.created.length : 0;
                    const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0;
                    const total = typeof result?.totalInput === "number" ? result.totalInput : rows.length;
                    setLegacyImportMsg(JSON.stringify(result, null, 2));
                    setLegacyImportMsgKind("success");
                    setAdminToast({
                      type: "success",
                      message: `Saved to database: ${created} new member(s) created (${total} row(s) submitted, ${skipped} skipped).`,
                    });
                    const next = await PmesService.fetchMembershipPipeline(staffAccessToken);
                    setMembershipPipeline(Array.isArray(next) ? next : []);
                    try {
                      const records = await PmesService.fetchAdminRecords(staffAccessToken);
                      setMasterList(records);
                    } catch {
                      /* keep existing master list */
                    }
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    setLegacyImportMsg(msg);
                    setLegacyImportMsgKind("error");
                    setAdminToast({ type: "error", message: msg });
                  } finally {
                    setLegacyImportLoading(false);
                  }
                }}
                className="inline-flex items-center gap-2 rounded-xl bg-[#004aad] px-5 py-2.5 text-sm font-black uppercase text-white hover:bg-[#003d99] disabled:opacity-50"
              >
                {legacyImportLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Import &amp; save to database
              </button>
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Writes to API / Postgres</span>
            </div>
            {legacyImportMsg ? (
              <pre
                className={`mt-4 max-h-48 overflow-auto rounded-xl p-4 text-xs ${
                  legacyImportMsgKind === "error"
                    ? "bg-red-950/95 text-red-50"
                    : "bg-slate-900/90 text-emerald-100"
                }`}
              >
                {legacyImportMsg}
              </pre>
            ) : null}
              </div>
            ) : null}
          </div>
          <OnlineApplicationsAdmin
            staffAccessToken={staffAccessToken}
            staffRole={staffRole}
            apiBase={(import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "")}
            onRefreshPipeline={() => void refreshMembershipPipelineRows()}
          />
          <div className="border-t border-slate-200 bg-slate-50 px-6 py-3 lg:px-10">
            <button
              type="button"
              onClick={() => setAdminDashPipelineOpen((o) => !o)}
              aria-expanded={adminDashPipelineOpen}
              className="flex w-full items-center justify-between gap-3 rounded-xl py-2 text-left hover:bg-slate-100/80"
            >
              <div className="min-w-0">
                <h2 className="text-lg font-black uppercase tracking-tight text-slate-900">Membership pipeline</h2>
                <p className="mt-0.5 text-xs font-medium text-slate-600 sm:text-sm">
                  {membershipPipeline.length} participant{membershipPipeline.length === 1 ? "" : "s"} · expand for fees, BOD votes, and actions
                </p>
              </div>
              <ChevronDown
                className={`h-5 w-5 shrink-0 text-slate-600 transition-transform ${adminDashPipelineOpen ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
            {adminDashPipelineOpen ? (
              <div className="mt-4 border-t border-slate-200 pt-6">
            <p className="text-sm font-medium text-slate-600">
              Treasurer must confirm fees first; only then can directors vote (3 of 5 to recommend). The Secretary issues the
              Board Resolution no. and final approval. Superuser can override or remove rows.
            </p>
            <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
              <table className="w-full min-w-[64rem] text-left text-sm">
                <thead className="bg-slate-100 text-xs font-bold uppercase tracking-wider text-slate-600">
                  <tr>
                    <th className="p-4">Participant</th>
                    <th className="p-4">Stage</th>
                    <th className="p-4">LOI</th>
                    <th className="p-4">Fees</th>
                    <th className="p-4">BOD yes</th>
                    <th className="p-4">Resolution</th>
                    <th className="p-4">Board OK</th>
                    <th className="p-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {membershipPipeline.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-8 text-center font-medium text-slate-500">
                        No participants yet, or pipeline failed to load.
                      </td>
                    </tr>
                  ) : (
                    membershipPipeline.map((row) => {
                      const pid = String(row.participantId);
                      const bodNeed = typeof row.bodMajorityRequired === "number" ? row.bodMajorityRequired : 3;
                      const bodVotes = typeof row.bodApproveVoteCount === "number" ? row.bodApproveVoteCount : 0;
                      const canTreasury =
                        canOpenAccounting(staffRole);
                      const canBod = canCastBodVote(staffRole, staffDbRole);
                      const canSecretary = staffRole === "secretary" || staffRole === "superuser";
                      const { needFees, needBodVote, needSecretary } = flagsFromPipelineRow(row);
                      return (
                      <tr key={pid} className="border-t border-slate-100">
                        <td className="p-4 align-top">
                          <button
                            type="button"
                            className="text-left font-bold text-[#004aad] underline decoration-[#004aad]/35 underline-offset-2 hover:text-[#003580]"
                            onClick={() => setPipelineDetailRow(/** @type {Record<string, unknown>} */ (row))}
                          >
                            {String(row.fullName ?? "—")}
                          </button>
                          <p className="break-all text-xs text-slate-500">{String(row.email ?? "")}</p>
                          {row.phone ? (
                            <p className="mt-1 text-xs text-slate-500">{String(row.phone)}</p>
                          ) : null}
                        </td>
                        <td className="p-4 align-top text-xs font-bold uppercase text-[#004aad]">{String(row.stage ?? "—")}</td>
                        <td className="p-4 align-top">{row.loiSubmitted ? "Yes" : "—"}</td>
                        <td className="p-4 align-top">{row.initialFeesPaid ? "Yes" : "—"}</td>
                        <td className="p-4 align-top font-mono text-xs">
                          {bodVotes}/{bodNeed} yes
                        </td>
                        <td className="p-4 align-top font-mono text-xs">{row.boardResolutionNo ? String(row.boardResolutionNo) : "—"}</td>
                        <td className="p-4 align-top">{row.boardApproved ? "Yes" : "—"}</td>
                        <td className="p-4 align-top">
                          <div className="flex flex-wrap gap-2">
                            {needFees && canTreasury ? (
                              <button
                                type="button"
                                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold uppercase text-white hover:bg-amber-700"
                                onClick={async () => {
                                  if (!staffAccessToken) return;
                                  try {
                                    const res = await PmesService.updateParticipantMembership(
                                      staffAccessToken,
                                      pid,
                                      { initialFeesPaid: true },
                                    );
                                    const toast = adminToastForAccountingFees(res);
                                    if (toast) setAdminToast(toast);
                                    await afterPipelineMutation();
                                  } catch (e) {
                                    setAdminToast({
                                      type: "error",
                                      message: e instanceof Error ? e.message : "Could not mark fees received",
                                    });
                                  }
                                }}
                              >
                                Mark fees received
                              </button>
                            ) : null}
                            {row.initialFeesPaid && canTreasury ? (
                              <TreasurerMembershipPaymentActions
                                participantId={pid}
                                initialFeesPaid={Boolean(row.initialFeesPaid)}
                                canTreasury={canTreasury}
                                staffAccessToken={staffAccessToken}
                                onComplete={afterPipelineMutation}
                                onToast={setAdminToast}
                                compact
                              />
                            ) : null}
                            {needBodVote && canBod ? (
                              <>
                                <button
                                  type="button"
                                  className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold uppercase text-white hover:bg-emerald-800"
                                  onClick={async () => {
                                    if (!staffAccessToken) return;
                                    await PmesService.recordBodVote(staffAccessToken, pid, true);
                                    await afterPipelineMutation();
                                  }}
                                >
                                  BOD yes
                                </button>
                                <button
                                  type="button"
                                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold uppercase text-slate-800 hover:bg-slate-50"
                                  onClick={async () => {
                                    if (!staffAccessToken) return;
                                    await PmesService.recordBodVote(staffAccessToken, pid, false);
                                    await afterPipelineMutation();
                                  }}
                                >
                                  BOD no
                                </button>
                              </>
                            ) : null}
                            {needSecretary ? (
                              <span className="text-[10px] font-black uppercase text-slate-500">
                                PMES {row.pmEsPassed ? "passed" : "not completed"}
                              </span>
                            ) : null}
                            {needSecretary && canSecretary ? (
                              <button
                                type="button"
                                className="rounded-lg bg-[#004aad] px-3 py-1.5 text-xs font-bold uppercase text-white hover:bg-[#003d99]"
                                onClick={async () => {
                                  if (!staffAccessToken) return;
                                  await PmesService.recordSecretaryBoardConfirm(staffAccessToken, pid);
                                  await afterPipelineMutation();
                                }}
                              >
                                Issue resolution
                              </button>
                            ) : null}
                            {staffRole === "superuser" && row.initialFeesPaid && !row.boardApproved ? (
                              <button
                                type="button"
                                className="rounded-lg border border-dashed border-slate-400 px-3 py-1.5 text-xs font-bold uppercase text-slate-700 hover:bg-slate-100"
                                onClick={async () => {
                                  if (!staffAccessToken) return;
                                  await PmesService.updateParticipantMembership(staffAccessToken, pid, {
                                    boardApproved: true,
                                  });
                                  await afterPipelineMutation();
                                }}
                              >
                                Board OK (override)
                              </button>
                            ) : null}
                            {staffRole === "superuser" ? (
                              <button
                                type="button"
                                disabled={deletingPipelineParticipantId === String(row.participantId)}
                                onClick={() => handleDeletePipelineParticipant(row)}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-bold uppercase text-red-800 hover:bg-red-100 disabled:opacity-50"
                                title="Remove this participant from the database (superuser only)"
                              >
                                {deletingPipelineParticipantId === String(row.participantId) ? (
                                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                                )}
                                Remove account
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {pipelineDetailRow ? (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-900/50 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pipeline-card-title"
        >
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            onClick={() => setPipelineDetailRow(null)}
            aria-label="Close dialog"
          />
          <div className="relative max-h-[min(90vh,40rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <button
              type="button"
              className="absolute right-3 top-3 rounded-lg p-2 text-slate-500 hover:bg-slate-100"
              onClick={() => setPipelineDetailRow(null)}
              aria-label="Close"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
            {(() => {
              const row = pipelineDetailRow;
              const pid = String(row.participantId);
              const bodNeed = typeof row.bodMajorityRequired === "number" ? row.bodMajorityRequired : 3;
              const bodVotes = typeof row.bodApproveVoteCount === "number" ? row.bodApproveVoteCount : 0;
              const canTreasury = canOpenAccounting(staffRole);
              const canBod = canCastBodVote(staffRole, staffDbRole);
              const canSecretary = staffRole === "secretary" || staffRole === "superuser";
              const { needFees, needBodVote, needSecretary } = flagsFromPipelineRow(row);
              return (
                <>
                  <h2 id="pipeline-card-title" className="pr-10 text-lg font-black uppercase tracking-tight text-slate-900">
                    {String(row.fullName ?? "Member")}
                  </h2>
                  <p className="mt-1 break-all text-sm text-slate-600">{String(row.email ?? "")}</p>
                  {row.phone ? <p className="mt-1 text-sm text-slate-500">{String(row.phone)}</p> : null}
                  <dl className="mt-4 grid grid-cols-2 gap-2 text-xs sm:text-sm">
                    <dt className="font-bold text-slate-500">Stage</dt>
                    <dd className="font-bold uppercase text-[#004aad]">{String(row.stage ?? "—")}</dd>
                    <dt className="font-bold text-slate-500">LOI</dt>
                    <dd>{row.loiSubmitted ? "Yes" : "—"}</dd>
                    <dt className="font-bold text-slate-500">Fees paid</dt>
                    <dd>{row.initialFeesPaid ? "Yes" : "No"}</dd>
                    <dt className="font-bold text-slate-500">BOD yes votes</dt>
                    <dd className="font-mono">
                      {bodVotes}/{bodNeed}
                    </dd>
                    <dt className="font-bold text-slate-500">Resolution</dt>
                    <dd className="font-mono">{row.boardResolutionNo ? String(row.boardResolutionNo) : "—"}</dd>
                    <dt className="font-bold text-slate-500">Board approved</dt>
                    <dd>{row.boardApproved ? "Yes" : "No"}</dd>
                  </dl>
                  <div className="mt-6 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                    {needFees && canTreasury ? (
                      <button
                        type="button"
                        className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-bold uppercase text-white hover:bg-amber-700"
                        onClick={async () => {
                          if (!staffAccessToken) return;
                          try {
                            const res = await PmesService.updateParticipantMembership(staffAccessToken, pid, {
                              initialFeesPaid: true,
                            });
                            const toast = adminToastForAccountingFees(res);
                            if (toast) setAdminToast(toast);
                            await afterPipelineMutation();
                          } catch (e) {
                            setAdminToast({
                              type: "error",
                              message: e instanceof Error ? e.message : "Could not mark fees received",
                            });
                          }
                        }}
                      >
                        Mark fees received
                      </button>
                    ) : null}
                    {row.initialFeesPaid && canTreasury ? (
                      <TreasurerMembershipPaymentActions
                        participantId={pid}
                        initialFeesPaid={Boolean(row.initialFeesPaid)}
                        canTreasury={canTreasury}
                        staffAccessToken={staffAccessToken}
                        onComplete={async () => {
                          await afterPipelineMutation();
                          setPipelineDetailRow(null);
                        }}
                        onToast={setAdminToast}
                      />
                    ) : null}
                    {needBodVote && canBod ? (
                      <>
                        <button
                          type="button"
                          className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold uppercase text-white hover:bg-emerald-800"
                          onClick={async () => {
                            if (!staffAccessToken) return;
                            await PmesService.recordBodVote(staffAccessToken, pid, true);
                            await afterPipelineMutation();
                          }}
                        >
                          Approve (BOD yes)
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-bold uppercase text-slate-800 hover:bg-slate-50"
                          onClick={async () => {
                            if (!staffAccessToken) return;
                            await PmesService.recordBodVote(staffAccessToken, pid, false);
                            await afterPipelineMutation();
                          }}
                        >
                          BOD no
                        </button>
                      </>
                    ) : null}
                    {needSecretary ? (
                      <span className="text-[10px] font-black uppercase text-slate-500">
                        PMES {row.pmEsPassed ? "passed" : "not completed"}
                      </span>
                    ) : null}
                    {needSecretary && canSecretary ? (
                      <button
                        type="button"
                        className="rounded-lg bg-[#004aad] px-4 py-2 text-xs font-bold uppercase text-white hover:bg-[#003d99]"
                        onClick={async () => {
                          if (!staffAccessToken) return;
                          await PmesService.recordSecretaryBoardConfirm(staffAccessToken, pid);
                          await afterPipelineMutation();
                        }}
                      >
                        Issue resolution
                      </button>
                    ) : null}
                    {staffRole === "superuser" && row.initialFeesPaid && !row.boardApproved ? (
                      <button
                        type="button"
                        className="rounded-lg border border-dashed border-slate-400 px-4 py-2 text-xs font-bold uppercase text-slate-700 hover:bg-slate-100"
                        onClick={async () => {
                          if (!staffAccessToken) return;
                          await PmesService.updateParticipantMembership(staffAccessToken, pid, {
                            boardApproved: true,
                          });
                          await afterPipelineMutation();
                        }}
                      >
                        Board OK (override)
                      </button>
                    ) : null}
                    {staffRole === "superuser" ? (
                      <button
                        type="button"
                        disabled={deletingPipelineParticipantId === String(row.participantId)}
                        onClick={() => handleDeletePipelineParticipant(row)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-xs font-bold uppercase text-red-800 hover:bg-red-100 disabled:opacity-50"
                      >
                        {deletingPipelineParticipantId === String(row.participantId) ? (
                          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        )}
                        Remove account
                      </button>
                    ) : null}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      ) : null}
      {adminToast ? (
        <div
          className={`fixed bottom-6 right-6 z-[60] flex max-w-md items-start gap-3 rounded-2xl border-2 px-4 py-3 shadow-xl sm:max-w-lg ${
            adminToast.type === "success"
              ? "border-emerald-300 bg-emerald-50 text-emerald-950"
              : "border-red-300 bg-red-50 text-red-950"
          }`}
          role="status"
          aria-live="polite"
        >
          {adminToast.type === "success" ? (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
          ) : (
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-black uppercase tracking-wide opacity-80">
              {adminToast.type === "success" ? "Saved" : "Error"}
            </p>
            <p className="mt-1 text-sm font-semibold leading-snug">{adminToast.message}</p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg px-2 py-1 text-xs font-bold uppercase text-slate-600 hover:bg-black/5"
            onClick={() => setAdminToast(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      </>
    );

  return null;
}
