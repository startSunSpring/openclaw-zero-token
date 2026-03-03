import crypto from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { getHeadersWithAuth } from "../browser/cdp.helpers.js";
import { getChromeWebSocketUrl, launchOpenClawChrome } from "../browser/chrome.js";
import { resolveBrowserConfig, resolveProfile } from "../browser/config.js";
import { loadConfig } from "../config/io.js";

export interface GlmIntlWebClientOptions {
  cookie: string;
  userAgent: string;
  headless?: boolean;
}

/** Model ID -> ChatGLM assistant_id mapping (国际版可能需要不同的映射) */
const ASSISTANT_ID_MAP: Record<string, string> = {
  "glm-4-plus": "65940acff94777010aa6b796",
  "glm-4": "65940acff94777010aa6b796",
  "glm-4-think": "676411c38945bbc58a905d31",
  "glm-4-zero": "676411c38945bbc58a905d31",
};
const DEFAULT_ASSISTANT_ID = "65940acff94777010aa6b796";

const SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb";

const X_EXP_GROUPS =
  "na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a," +
  "na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a," +
  "desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4," +
  "app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add," +
  "mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A," +
  "homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A," +
  "memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user," +
  "app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5," +
  "ai_wallet:exp:ai_wallet_enable";

/** Generate X-Sign, X-Nonce, X-Timestamp headers required by chat.z.ai */
function generateSign(): { timestamp: string; nonce: string; sign: string } {
  const e = Date.now();
  const A = e.toString();
  const t = A.length;
  const o = A.split("").map((c) => Number(c));
  const i = o.reduce((acc, v) => acc + v, 0) - o[t - 2];
  const a = i % 10;
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sign = crypto.createHash("md5").update(`${timestamp}-${nonce}-${SIGN_SECRET}`).digest("hex");
  return { timestamp, nonce, sign };
}

export class GlmIntlWebClientBrowser {
  private options: GlmIntlWebClientOptions;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initialized = false;
  private accessToken: string | null = null;
  private deviceId = crypto.randomUUID().replace(/-/g, "");

  constructor(options: GlmIntlWebClientOptions) {
    this.options = options;
  }

  private parseCookies(): Array<{ name: string; value: string; domain: string; path: string }> {
    return this.options.cookie
      .split(";")
      .filter((c) => c.trim().includes("="))
      .map((cookie) => {
        const [name, ...valueParts] = cookie.trim().split("=");
        return {
          name: name?.trim() ?? "",
          value: valueParts.join("=").trim(),
          domain: ".z.ai",
          path: "/",
        };
      })
      .filter((c) => c.name.length > 0);
  }

  private getRefreshToken(): string | null {
    const cookies = this.parseCookies();
    // Try multiple possible refresh token cookie names for international version
    const refreshCookieNames = [
      "chatglm_refresh_token",
      "refresh_token",
      "auth_refresh_token",
      "glm_refresh_token",
      "zai_refresh_token"
    ];

    for (const name of refreshCookieNames) {
      const cookie = cookies.find((c) => c.name === name);
      if (cookie?.value) {
        console.log(`[GLM Intl Web Browser] Found refresh token cookie: ${name}`);
        return cookie.value;
      }
    }

    return null;
  }

  private getAccessTokenFromCookie(): string | null {
    const cookies = this.parseCookies();
    // Try multiple possible access token cookie names for international version
    const accessTokenCookieNames = [
      "chatglm_token",
      "access_token",
      "auth_token",
      "glm_token",
      "zai_token",
      "token"
    ];

    for (const name of accessTokenCookieNames) {
      const cookie = cookies.find((c) => c.name === name);
      if (cookie?.value) {
        console.log(`[GLM Intl Web Browser] Found access token cookie: ${name}`);
        return cookie.value;
      }
    }

    return null;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const rootConfig = loadConfig();
    const browserConfig = resolveBrowserConfig(rootConfig.browser, rootConfig);
    const profile = resolveProfile(browserConfig, browserConfig.defaultProfile);
    if (!profile) {
      throw new Error(`Could not resolve browser profile '${browserConfig.defaultProfile}'`);
    }

    let wsUrl: string | null = null;

    if (browserConfig.attachOnly) {
      console.log(`[GLM Intl Web Browser] Connecting to existing Chrome at ${profile.cdpUrl}`);
      for (let i = 0; i < 10; i++) {
        wsUrl = await getChromeWebSocketUrl(profile.cdpUrl, 2000);
        if (wsUrl) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!wsUrl) {
        throw new Error(
          `Failed to connect to Chrome at ${profile.cdpUrl}. ` +
            `Make sure Chrome is running in debug mode (./start-chrome-debug.sh)`,
        );
      }
    } else {
      const running = await launchOpenClawChrome(browserConfig, profile);
      const cdpUrl = `http://127.0.0.1:${running.cdpPort}`;
      for (let i = 0; i < 10; i++) {
        wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
        if (wsUrl) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!wsUrl) {
        throw new Error(`Failed to resolve Chrome WebSocket URL from ${cdpUrl}`);
      }
    }

    const connectedBrowser = await chromium.connectOverCDP(wsUrl, {
      headers: getHeadersWithAuth(wsUrl),
    });
    this.browser = connectedBrowser;
    this.context = connectedBrowser.contexts()[0];

    const pages = this.context.pages();
    const glmPage = pages.find((p) => p.url().includes("chat.z.ai"));
    if (glmPage) {
      console.log(`[GLM Intl Web Browser] Found existing GLM International page`);
      this.page = glmPage;
    } else {
      this.page = await this.context.newPage();
      await this.page.goto("https://chat.z.ai/", { waitUntil: "domcontentloaded", timeout: 120000 }); // 2 minutes timeout
    }

    const cookies = this.parseCookies();
    if (cookies.length > 0) {
      try {
        await this.context.addCookies(cookies);
      } catch (e) {
        console.warn("[GLM Intl Web Browser] Failed to add some cookies:", e);
      }
    }

    await this.refreshAccessToken();

    this.initialized = true;
  }

  private async refreshAccessToken(): Promise<void> {
    const cookieToken = this.getAccessTokenFromCookie();
    if (cookieToken) {
      this.accessToken = cookieToken;
      console.log("[GLM Intl Web Browser] Using chatglm_token from cookies");
      return;
    }

    // Also try to get token from browser cookies
    if (this.context) {
      try {
        const browserCookies = await this.context.cookies(["https://chat.z.ai"]);
        const browserToken = browserCookies.find((c) => c.name === "chatglm_token");
        if (browserToken?.value) {
          this.accessToken = browserToken.value;
          console.log("[GLM Intl Web Browser] Using chatglm_token from browser cookies");
          return;
        }
      } catch {
        // ignore
      }
    }

    const refreshToken = this.getRefreshToken();
    if (!refreshToken || !this.page) {
      console.warn("[GLM Intl Web Browser] No chatglm_token found, will rely on browser cookies for auth");
      return;
    }

    console.log("[GLM Intl Web Browser] Refreshing access token via API...");
    const sign = generateSign();
    const requestId = crypto.randomUUID().replace(/-/g, "");
    const result = await this.page.evaluate(
      async ({ refreshToken, deviceId, requestId, sign }) => {
        try {
          const res = await fetch("https://chat.z.ai/chatglm/user-api/user/refresh", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${refreshToken}`,
              "App-Name": "chatglm",
              "X-App-Platform": "pc",
              "X-App-Version": "0.0.1",
              "X-Device-Id": deviceId,
              "X-Request-Id": requestId,
              "X-Sign": sign.sign,
              "X-Nonce": sign.nonce,
              "X-Timestamp": sign.timestamp,
            },
            credentials: "include",
            body: JSON.stringify({}),
          });

          if (!res.ok) {
            return { ok: false, status: res.status, error: await res.text() };
          }

          const data = await res.json();
          const accessToken = data?.result?.access_token ?? data?.result?.accessToken ?? data?.accessToken;
          if (!accessToken) {
            return { ok: false, status: 200, error: `No accessToken in response: ${JSON.stringify(data).substring(0, 300)}` };
          }
          return { ok: true, accessToken };
        } catch (err) {
          return { ok: false, status: 500, error: String(err) };
        }
      },
      { refreshToken, deviceId: this.deviceId, requestId, sign },
    );

    if (result.ok && result.accessToken) {
      this.accessToken = result.accessToken;
      console.log("[GLM Intl Web Browser] Access token refreshed successfully");
    } else {
      console.warn(`[GLM Intl Web Browser] Failed to refresh access token: ${result.error}`);
    }
  }

  async chatCompletions(params: {
    conversationId?: string;
    message: string;
    model: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    if (!this.page) {
      throw new Error("GlmIntlWebClientBrowser not initialized");
    }

    if (!this.accessToken) {
      await this.refreshAccessToken();
    }

    const { conversationId, message, model } = params;
    const assistantId = ASSISTANT_ID_MAP[model] ?? DEFAULT_ASSISTANT_ID;

    console.log(`[GLM Intl Web Browser] Sending request... model=${model} assistantId=${assistantId}`);
    console.log(`[GLM Intl Web Browser Debug] Full request details:`);
    console.log(`  - Model: ${model}`);
    console.log(`  - Assistant ID: ${assistantId}`);
    console.log(`  - Conversation ID: ${conversationId || 'new'}`);
    console.log(`  - Message length: ${message.length}`);
    console.log(`  - Access token present: ${!!this.accessToken}`);

    const fetchTimeoutMs = 120_000;
    const sign = generateSign();
    const requestId = crypto.randomUUID().replace(/-/g, "");

    // Try OpenAI-compatible format for international version
    // Keep original format as fallback for chatglm.cn endpoints
    let body;
    const useOpenAIFormat = false; // Try original format first

    if (useOpenAIFormat) {
      console.log(`[GLM Intl Web Browser] Using OpenAI-compatible request format`);
      body = {
        model: model,
        messages: [
          {
            role: "user",
            content: message,
          },
        ],
        stream: true,
      };

      // Add conversation_id if available (some GLM APIs might need it)
      if (conversationId) {
        body.conversation_id = conversationId;
      }
    } else {
      // Original chatglm.cn format
      body = {
        assistant_id: assistantId,
        conversation_id: conversationId || "",
        project_id: "",
        chat_type: "user_chat",
        meta_data: {
          cogview: { rm_label_watermark: false },
          is_test: false,
          input_question_type: "xxxx",
          channel: "",
          draft_id: "",
          chat_mode: "zero",
          is_networking: false,
          quote_log_id: "",
          platform: "pc",
        },
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: message }],
          },
        ],
      };
    }

    const evalPromise = this.page.evaluate(
      async ({ accessToken, bodyStr, deviceId, requestId, timeoutMs, sign, xExpGroups }) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          console.log('[GLM Intl Web Browser - Page Context] Starting API request');
          console.log('[GLM Intl Web Browser - Page Context] Access token present:', !!accessToken);
          console.log('[GLM Intl Web Browser - Page Context] Request body length:', bodyStr.length);
          console.log('[GLM Intl Web Browser - Page Context] Request body preview:', bodyStr.substring(0, 500));

          const controller = new AbortController();
          timer = setTimeout(() => controller.abort(), timeoutMs);

          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "App-Name": "chatglm",
            "Origin": "https://chat.z.ai",
            "X-App-Platform": "pc",
            "X-App-Version": "1.0.0",
            "X-App-fr": "default",
            "X-Device-Brand": "",
            "X-Device-Id": deviceId,
            "X-Device-Model": "",
            "X-Exp-Groups": xExpGroups,
            "X-FE-Version": "prod-fe-1.0.250",
            "X-Lang": "zh",
            "X-Nonce": sign.nonce,
            "X-Request-Id": requestId,
            "X-Sign": sign.sign,
            "X-Timestamp": sign.timestamp,
          };
          if (accessToken) {
            headers["Authorization"] = `Bearer ${accessToken}`;
          }

          console.log('[GLM Intl Web Browser - Page Context] Request headers:', JSON.stringify(headers, null, 2));

          // Try different API endpoints for international version
          // Try relative paths first - they might be intercepted by the app's request handlers
          const apiEndpoints = [
            "/api/v2/chat/completions",
            "/api/v1/chat/completions",
            "/v1/chat/completions",
            "/api/chat/completions",
            "/chat/completions",
            // New endpoints for international version
            "/api/chat/stream",
            "/chat/stream",
            "/api/conversation",
            "/api/chat",
            "/api/v1/chat",
            "/api/v2/chat",
            "/v1/chat",
            "/v2/chat",
            // Full URLs as fallback
            "https://chat.z.ai/api/v2/chat/completions",
            "https://chat.z.ai/api/v1/chat/completions",
            "https://chat.z.ai/v1/chat/completions",
            "https://chat.z.ai/api/chat/completions",
            "https://chat.z.ai/chat/completions",
            // Original chatglm.cn style endpoints
            "https://chat.z.ai/chatglm/backend-api/assistant/stream",
            "https://chat.z.ai/backend-api/assistant/stream",
            "https://chat.z.ai/api/assistant/stream",
            "https://chat.z.ai/chatglm/assistant/stream",
            // Alternative paths
            "https://chat.z.ai/api/chat/stream",
            "https://chat.z.ai/chat/stream",
            // New full URL endpoints
            "https://chat.z.ai/api/conversation",
            "https://chat.z.ai/api/chat",
            "https://chat.z.ai/api/v1/chat",
            "https://chat.z.ai/api/v2/chat",
            "https://chat.z.ai/v1/chat",
            "https://chat.z.ai/v2/chat",
            // Try WebSocket-like endpoints (though fetch may not work)
            "https://chat.z.ai/ws/chat",
            "https://chat.z.ai/ws",
          ];

          let res: Response | null = null;
          let lastError = "";

          for (const endpoint of apiEndpoints) {
            try {
              console.log(`[GLM Intl Web Browser Debug] Trying endpoint: ${endpoint}`);
              res = await fetch(
                endpoint,
                {
                  method: "POST",
                  headers,
                  credentials: "include",
                  body: bodyStr,
                  signal: controller.signal,
                },
              );

              if (res.ok) {
                console.log(`[GLM Intl Web Browser Debug] Success with endpoint: ${endpoint}`);
                break;
              }

              // 读取错误响应体
              let errorBody = '';
              try {
                errorBody = await res.text();
                console.log(`[GLM Intl Web Browser Debug] Endpoint ${endpoint} error response: ${errorBody.substring(0, 1000)}`);
              } catch (err) {
                console.log(`[GLM Intl Web Browser Debug] Could not read error response body: ${err}`);
              }

              if (res.status !== 404 && res.status !== 405) {
                // If it's not a 404/405, we might have the right endpoint but wrong params
                console.log(`[GLM Intl Web Browser Debug] Endpoint ${endpoint} returned status: ${res.status}`);
                // 返回详细的错误信息
                return {
                  ok: false,
                  status: res.status,
                  error: `Endpoint ${endpoint} failed with status ${res.status}: ${errorBody.substring(0, 500)}`,
                  endpoint: endpoint,
                  errorBody: errorBody.substring(0, 2000)
                };
              }

              lastError = `Endpoint ${endpoint}: ${res.status} - ${errorBody.substring(0, 200)}`;
              console.log(`[GLM Intl Web Browser Debug] Endpoint ${endpoint} failed with status: ${res.status}, error: ${errorBody.substring(0, 200)}`);
            } catch (err) {
              console.log(`[GLM Intl Web Browser Debug] Endpoint ${endpoint} error: ${err}`);
              lastError = `Endpoint ${endpoint}: ${err}`;
            }
          }

          if (!res) {
            console.log(`[GLM Intl Web Browser Debug] All endpoints failed. Last error: ${lastError}`);
            console.log(`[GLM Intl Web Browser Debug] Tried endpoints: ${apiEndpoints.join(', ')}`);
            return {
              ok: false,
              status: 500,
              error: `All API endpoints failed. Last error: ${lastError}`,
              endpointsTried: apiEndpoints,
              lastError: lastError
            };
          }

          clearTimeout(timer);

          if (!res.ok) {
            const errorText = await res.text();
            console.log(`[GLM Intl Web Browser Debug] API response status: ${res.status}, error: ${errorText.substring(0, 1000)}`);
            return { ok: false, status: res.status, error: errorText.substring(0, 2000) };
          }

          const reader = res.body?.getReader();
          if (!reader) {
            return { ok: false, status: 500, error: "No response body" };
          }

          const decoder = new TextDecoder();
          let fullText = "";
          let chunkCount = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            fullText += chunk;
            chunkCount++;
          }

          return { ok: true, data: fullText, chunkCount };
        } catch (err) {
          if (timer) clearTimeout(timer);
          const msg = String(err);
          if (msg.includes("aborted") || msg.includes("signal")) {
            return { ok: false, status: 408, error: `ChatGLM API request timed out after ${timeoutMs}ms` };
          }
          return { ok: false, status: 500, error: msg };
        }
      },
      {
        accessToken: this.accessToken,
        bodyStr: JSON.stringify(body),
        deviceId: this.deviceId,
        requestId,
        timeoutMs: fetchTimeoutMs,
        sign,
        xExpGroups: X_EXP_GROUPS,
      },
    );

    const externalTimeoutMs = fetchTimeoutMs + 10_000;
    const responseData = await Promise.race([
      evalPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`[GLM Intl Web Browser] page.evaluate timed out after ${externalTimeoutMs / 1000}s`)),
          externalTimeoutMs,
        ),
      ),
    ]);

    if (!responseData || !responseData.ok) {
      if (responseData?.status === 401) {
        console.log("[GLM Intl Web Browser] Access token expired, refreshing...");
        await this.refreshAccessToken();
        throw new Error("Authentication expired. Token has been refreshed, please retry.");
      }

      // Provide detailed debugging information for 405 errors
      let errorMsg = `ChatGLM API error: ${responseData?.status || "unknown"} - ${responseData?.error || "Request failed"}`;

      if (responseData?.status === 405) {
        errorMsg += `

GLM International (chat.z.ai) API Configuration Help:
------------------------------------------------------------------------
The GLM International version appears to use a different API structure than the Chinese version (chatglm.cn).

To fix this issue, please follow these steps:

1. Open https://chat.z.ai in Chrome browser and log in
2. Press F12 to open Developer Tools
3. Go to the "Network" tab
4. Clear existing network logs (click 🚫 icon)
5. Send a message in the chat interface
6. Look for API requests in the Network tab (filter by "stream" or "assistant")
7. Find the correct API endpoint URL (should be a POST request)
8. Find the correct request headers (especially X-Sign, X-Nonce, X-Timestamp)
9. Find the correct request body format

Common API endpoint patterns for chat.z.ai:
- https://chat.z.ai/api/v1/chat/completions (OpenAI compatible)
- https://chat.z.ai/chat/api/stream
- https://chat.z.ai/backend-api/conversation

Please provide the correct API endpoint and headers so we can update the implementation.

Debug information:
- Model: ${model}
- Assistant ID: ${assistantId}
- Access token: ${this.accessToken ? 'Present' : 'Missing'}
- Tried ${apiEndpoints.length} different API endpoints
------------------------------------------------------------------------
`;
      }

      // Log detailed error information for debugging
      console.log(`[GLM Intl Web Browser] Detailed error:`, JSON.stringify(responseData, null, 2));

      throw new Error(errorMsg);
    }

    console.log(`[GLM Intl Web Browser] Response: ${responseData.chunkCount} chunks, ${responseData.data?.length || 0} bytes`);
    if (responseData.data && responseData.data.length > 0) {
      console.log(`[GLM Intl Web Browser] Response preview (first 500 chars): ${responseData.data.substring(0, 500)}`);
    }

    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(responseData.data));
        controller.close();
      },
    });
  }

  async close(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.initialized = false;
    this.accessToken = null;
  }
}