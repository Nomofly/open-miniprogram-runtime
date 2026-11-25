/**
 * The simulated WeChat user. WeChat DevTools signs `wx.login` and related APIs
 * with the developer's own account; the simulator uses this configurable user.
 */
export interface SimulatedUser {
  openid: string;
  unionid?: string;
  sessionKey: string;
  /** Offered above the keyboard of `<input type="nickname">`. */
  nickName: string;
  /** Offered by `<button open-type="chooseAvatar">`. */
  avatarUrl: string;
  /** Without the country code, such as `13800138000`. */
  phoneNumber: string;
  countryCode: string;
}

/** The `auth` part of omr.config.json. */
export interface AuthConfig {
  user?: Partial<SimulatedUser>;
  /** Initial `wx.getSetting` result, such as `{ "scope.userLocation": true }`. A scope set to false is denied. */
  authSetting?: Record<string, boolean>;
  /** Start with an expired session, so `wx.checkSession` fails until `wx.login` is called. */
  sessionExpired?: boolean;
  /**
   * How system dialogs (the privacy popup, `wx.authorize`, phone number and
   * avatar buttons) are answered: `ask` shows them, `allow` and `deny` answer
   * without showing them, for unattended runs.
   */
  consent?: "ask" | "allow" | "deny";
  privacy?: {
    /** Whether the user has already agreed to the privacy guide; default false, as for a new user. */
    agreed?: boolean;
    /** What `wx.getPrivacySetting` returns as `privacyContractName`. */
    contractName?: string;
  };
}

/** The gray default avatar WeChat shows for users who have not chosen one. */
export const DEFAULT_AVATAR =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 132 132"><rect width="132" height="132" fill="#e5e5e5"/><circle cx="66" cy="52" r="24" fill="#bdbdbd"/><path d="M22 120c4-26 22-40 44-40s40 14 44 40z" fill="#bdbdbd"/></svg>',
  );

/**
 * WeChat no longer returns real profiles from `wx.getUserInfo` and
 * `wx.getUserProfile`; they return this anonymous user.
 */
export const ANONYMOUS_NICKNAME = "微信用户";

export function resolveUser(user: Partial<SimulatedUser> = {}): SimulatedUser {
  return {
    openid: "omr-openid-developer",
    sessionKey: "omr-session-key-developer",
    nickName: ANONYMOUS_NICKNAME,
    avatarUrl: DEFAULT_AVATAR,
    phoneNumber: "13800138000",
    countryCode: "86",
    ...user,
  };
}

/** What a simulated `wx.login` code or phone number code stands for. */
export interface CodePayload {
  kind: "login" | "phone";
  appid: string;
  openid: string;
  unionid?: string;
  sessionKey: string;
  phoneNumber?: string;
  countryCode?: string;
  /** Milliseconds since the epoch; WeChat codes expire after five minutes. */
  issuedAt: number;
  nonce: string;
}

export const CODE_TTL_MS = 5 * 60 * 1000;
const CODE_PREFIX = "omr_";

/**
 * Encodes a code that the mock WeChat server API decodes without shared state,
 * so a developer's backend in another process can exchange it.
 */
export function encodeCode(payload: CodePayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return CODE_PREFIX + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCode(code: string): CodePayload | undefined {
  if (!code.startsWith(CODE_PREFIX)) return undefined;
  try {
    const base64 = code.slice(CODE_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as CodePayload;
    return typeof payload.openid === "string" ? payload : undefined;
  } catch {
    return undefined;
  }
}
