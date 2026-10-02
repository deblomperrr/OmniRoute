import { runWithProxyContext } from "../../../utils/proxyFetch.ts";
import { getOmnirushUserAgent } from "../../../config/providerHeaderProfiles.ts";
import type { RefreshLogger } from "../shared.ts";

export async function refreshOmnirushToken(
  refreshToken: string,
  providerSpecificData: Record<string, unknown> | null | undefined,
  log: RefreshLogger,
  proxyConfig: unknown = null
) {
  const gatewayUrl =
    (providerSpecificData?.gatewayUrl as string) || "https://omnirush.ai/omnirush/v1";
  const origin = gatewayUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const endpoint = `${origin}/device/refresh`;

  try {
    const response = await runWithProxyContext(proxyConfig, () =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": getOmnirushUserAgent(),
        },
        body: JSON.stringify({
          refresh_token: refreshToken,
        }),
      })
    );

    if (!response.ok) {
      const errorText = await response.text();
      let errorCode = `HTTP_${response.status}`;
      try {
        const parsed = JSON.parse(errorText);
        if (parsed?.detail) errorCode = parsed.detail;
      } catch {}

      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 400 ||
        response.status === 409
      ) {
        log?.error?.(
          "TOKEN_REFRESH",
          "OmniRush refresh token invalid or expired. Re-authentication required.",
          { errorCode }
        );
        return { error: "unrecoverable_refresh_error", code: errorCode };
      }

      log?.error?.("TOKEN_REFRESH", "Failed to refresh OmniRush token", {
        status: response.status,
        error: errorText.slice(0, 200),
      });
      return null;
    }

    const tokens = await response.json();
    log?.info?.("TOKEN_REFRESH", "Successfully refreshed OmniRush token", {
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      gatewayUrl: tokens.gateway_url,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in || 3600,
      providerSpecificData: {
        ...(providerSpecificData || {}),
        gatewayUrl: tokens.gateway_url || gatewayUrl,
      },
    };
  } catch (error) {
    log?.error?.(
      "TOKEN_REFRESH",
      `Network error refreshing OmniRush token: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
