import { CODE_TTL_MS, decodeCode } from "./auth.ts";

export interface MockApiRequest {
  method: string;
  url: URL;
  body?: string;
}

export interface MockApiResponse {
  status: number;
  json: unknown;
}

/** Paths of the WeChat server APIs the mock answers, the same as on api.weixin.qq.com. */
export const MOCK_API_PATHS = [
  "/sns/jscode2session",
  "/wxa/business/getuserphonenumber",
  "/cgi-bin/token",
  "/cgi-bin/stable_token",
];

/**
 * A stand-in for the WeChat server APIs a Mini Program backend calls during
 * login (https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/), so a
 * backend can exchange simulated codes by pointing its WeChat API base URL at
 * the simulator. Codes are single use, as on WeChat; `usedCodes` tracks them.
 */
export function mockWechatApi(
  request: MockApiRequest,
  usedCodes: Set<string>,
  now = Date.now(),
): MockApiResponse | undefined {
  const { url } = request;
  const ok = (json: unknown): MockApiResponse => ({ status: 200, json });
  /** Validates a code and marks it used, unless the request is rejected for another reason first. */
  const takeCode = (
    code: string | null | undefined,
    kind: "login" | "phone",
    appid?: string | null,
  ) => {
    if (!code) return { error: { errcode: 41008, errmsg: "missing code" } };
    const payload = decodeCode(code);
    if (!payload || payload.kind !== kind || now - payload.issuedAt > CODE_TTL_MS) {
      return { error: { errcode: 40029, errmsg: "invalid code" } };
    }
    if (appid && appid !== payload.appid) {
      return { error: { errcode: 40013, errmsg: "invalid appid" } };
    }
    // Keyed by what the code stands for, so another base64 spelling of it is still used
    const id = `${payload.kind}:${payload.issuedAt}:${payload.nonce}`;
    if (usedCodes.has(id)) return { error: { errcode: 40163, errmsg: "code been used" } };
    usedCodes.add(id);
    return { payload };
  };

  switch (url.pathname) {
    case "/sns/jscode2session": {
      const { payload, error } = takeCode(
        url.searchParams.get("js_code"),
        "login",
        url.searchParams.get("appid"),
      );
      if (error) return ok(error);
      return ok({
        session_key: payload!.sessionKey,
        openid: payload!.openid,
        ...(payload!.unionid ? { unionid: payload!.unionid } : {}),
      });
    }
    case "/wxa/business/getuserphonenumber": {
      let code: string | undefined;
      try {
        code = (JSON.parse(request.body || "{}") as { code?: string }).code;
      } catch {
        return ok({ errcode: 47001, errmsg: "data format error" });
      }
      const { payload, error } = takeCode(code, "phone");
      if (error) return ok(error);
      const pure = payload!.phoneNumber ?? "";
      const countryCode = payload!.countryCode ?? "86";
      return ok({
        errcode: 0,
        errmsg: "ok",
        phone_info: {
          // WeChat adds the country code only to numbers outside mainland China
          phoneNumber: countryCode === "86" ? pure : `+${countryCode}${pure}`,
          purePhoneNumber: pure,
          countryCode,
          watermark: { timestamp: Math.floor(now / 1000), appid: payload!.appid },
        },
      });
    }
    case "/cgi-bin/token":
    case "/cgi-bin/stable_token":
      return ok({ access_token: "omr-access-token", expires_in: 7200 });
    default:
      return undefined;
  }
}
