import { hostname } from "os";
import { getOmnirushUserAgent } from "@omniroute/open-sse/config/providerHeaderProfiles.ts";
import { OMNIRUSH_CONFIG } from "../constants/oauth";

export const omnirush = {
  config: OMNIRUSH_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config: typeof OMNIRUSH_CONFIG) => {
    const response = await fetch(config.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": getOmnirushUserAgent(),
      },
      body: JSON.stringify({
        device_name: hostname(),
        platform: process.platform,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Device code request failed: ${error}`);
    }

    const data = await response.json();
    if (!data?.device_code) throw new Error("Device authorization response missing device_code");
    if (!data?.user_code) throw new Error("Device authorization response missing user_code");

    return {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri || "https://omnirush.ai/console",
      verification_uri_complete:
        data.verification_uri_complete || `https://omnirush.ai/console?code=${data.user_code}`,
      expires_in: typeof data.expires_in === "number" ? data.expires_in : 600,
      interval: typeof data.interval === "number" ? data.interval : 3,
    };
  },
  pollToken: async (config: typeof OMNIRUSH_CONFIG, deviceCode: string) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": getOmnirushUserAgent(),
      },
      body: JSON.stringify({
        device_code: deviceCode,
      }),
    });

    const text = await response.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: "invalid_response", error_description: text };
    }

    if (response.status === 428 || data?.detail === "authorization_pending") {
      return {
        ok: true,
        data: {
          error: "authorization_pending",
          error_description: "Authorization pending",
        },
      };
    }

    if (response.status === 429 || data?.detail === "slow_down") {
      return {
        ok: true,
        data: {
          error: "slow_down",
          error_description: "Slow down",
        },
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        data: {
          error: data?.detail || `HTTP_${response.status}`,
          error_description: data?.detail || text,
        },
      };
    }

    return {
      ok: true,
      data,
    };
  },
  postExchange: async (tokens: any) => {
    try {
      const res = await fetch(OMNIRUSH_CONFIG.userInfoUrl, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: "application/json",
          "User-Agent": getOmnirushUserAgent(),
        },
      });
      if (res.ok) {
        const userInfo = await res.json();
        return { userInfo };
      }
    } catch {
      // Best-effort user info recovery
    }
    return { userInfo: {} };
  },
  mapTokens: (tokens: any, extra?: any) => {
    const email = extra?.userInfo?.email || undefined;
    const name = extra?.userInfo?.name || email || "OmniRush User";
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in || 3600,
      email,
      name,
      providerSpecificData: {
        gatewayUrl: tokens.gateway_url || OMNIRUSH_CONFIG.gatewayUrl,
        userId: extra?.userInfo?.id || extra?.userInfo?.user_id,
        email,
        plan: extra?.userInfo?.plan,
      },
    };
  },
};
