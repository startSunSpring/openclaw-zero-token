#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '.openclaw-state');
const AUTH_PROFILES_FILE = path.join(STATE_DIR, 'agents/main/agent/auth-profiles.json');

// Load authentication data
function loadAuthData() {
  if (!fs.existsSync(AUTH_PROFILES_FILE)) {
    console.error(`Auth profiles file not found: ${AUTH_PROFILES_FILE}`);
    process.exit(1);
  }

  const authProfiles = JSON.parse(fs.readFileSync(AUTH_PROFILES_FILE, 'utf8'));
  const glmProfile = authProfiles.profiles['glm-intl-web:default'];

  if (!glmProfile || !glmProfile.key) {
    console.error('GLM International authentication profile not found');
    process.exit(1);
  }

  const authData = JSON.parse(glmProfile.key);
  console.log('Loaded authentication data:');
  console.log(`- Cookie length: ${authData.cookie?.length || 0} chars`);
  console.log(`- UserAgent: ${authData.userAgent || 'Not specified'}`);
  console.log(`- Raw cookie preview: ${authData.cookie?.substring(0, 100)}...`);

  return authData;
}

// Parse cookies from cookie string
function parseCookies(cookieString) {
  const cookies = {};
  cookieString.split(';').forEach(cookie => {
    const [name, ...valueParts] = cookie.trim().split('=');
    if (name) {
      cookies[name] = valueParts.join('=').trim();
    }
  });
  return cookies;
}

// Extract access token from cookies
function extractAccessToken(cookies) {
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
    if (cookies[name]) {
      console.log(`Found access token cookie: ${name}`);
      return cookies[name];
    }
  }

  console.log('No access token found in cookies');
  return null;
}

// Generate X-Sign, X-Nonce, X-Timestamp headers (from glm-intl-web-client-browser.ts)
function generateSign() {
  const SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb";
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

// X-Exp-Groups constant (from glm-intl-web-client-browser.ts)
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

// Assistant ID mapping
const ASSISTANT_ID_MAP = {
  "glm-4-plus": "65940acff94777010aa6b796",
  "glm-4": "65940acff94777010aa6b796",
  "glm-4-think": "676411c38945bbc58a905d31",
  "glm-4-zero": "676411c38945bbc58a905d31",
};

// Different API endpoint formats to test
const API_ENDPOINTS = [
  // chatglm.cn style endpoints
  "https://chat.z.ai/chatglm/backend-api/assistant/stream",
  "https://chat.z.ai/backend-api/assistant/stream",
  "https://chat.z.ai/api/assistant/stream",
  "https://chat.z.ai/chatglm/assistant/stream",
  // OpenAI compatible endpoints
  "https://chat.z.ai/v1/chat/completions",
  "https://chat.z.ai/api/v1/chat/completions",
  "https://chat.z.ai/chat/completions",
  // Alternative paths
  "https://chat.z.ai/api/chat/stream",
  "https://chat.z.ai/chat/stream",
  // Additional possibilities
  "https://chat.z.ai/backend-api/conversation",
  "https://chat.z.ai/api/conversation",
  "https://chat.z.ai/chat/api/conversation",
];

// Different request body formats to test
function createRequestBodyFormat1(model, message, assistantId, conversationId) {
  // Original chatglm.cn format
  return {
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

function createRequestBodyFormat2(model, message, assistantId, conversationId) {
  // OpenAI compatible format
  return {
    model: model,
    messages: [
      {
        role: "user",
        content: message,
      },
    ],
    stream: true,
  };
}

function createRequestBodyFormat3(model, message, assistantId, conversationId) {
  // Simplified format
  return {
    model: model,
    prompt: message,
    stream: true,
  };
}

function createRequestBodyFormat4(model, message, assistantId, conversationId) {
  // Alternative format with conversation_id
  return {
    model: model,
    conversation_id: conversationId || "",
    messages: [
      {
        role: "user",
        content: message,
      },
    ],
    stream: true,
  };
}

// Test a single API endpoint
async function testEndpoint(endpoint, authData, accessToken, model, message, bodyFormat, formatName) {
  const deviceId = crypto.randomUUID().replace(/-/g, "");
  const requestId = crypto.randomUUID().replace(/-/g, "");
  const sign = generateSign();
  const assistantId = ASSISTANT_ID_MAP[model] || ASSISTANT_ID_MAP["glm-4-plus"];

  // Create request body based on format
  let body;
  switch(bodyFormat) {
    case 1:
      body = createRequestBodyFormat1(model, message, assistantId, "");
      break;
    case 2:
      body = createRequestBodyFormat2(model, message, assistantId, "");
      break;
    case 3:
      body = createRequestBodyFormat3(model, message, assistantId, "");
      break;
    case 4:
      body = createRequestBodyFormat4(model, message, assistantId, "");
      break;
    default:
      body = createRequestBodyFormat1(model, message, assistantId, "");
  }

  const headers = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "App-Name": "chatglm",
    "Origin": "https://chat.z.ai",
    "X-App-Platform": "pc",
    "X-App-Version": "0.0.1",
    "X-App-fr": "default",
    "X-Device-Brand": "",
    "X-Device-Id": deviceId,
    "X-Device-Model": "",
    "X-Exp-Groups": X_EXP_GROUPS,
    "X-Lang": "zh",
    "X-Nonce": sign.nonce,
    "X-Request-Id": requestId,
    "X-Sign": sign.sign,
    "X-Timestamp": sign.timestamp,
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  // Add cookies to headers if needed
  if (authData.cookie) {
    headers["Cookie"] = authData.cookie;
  }

  console.log(`\n=== Testing endpoint: ${endpoint} ===`);
  console.log(`Body format: ${formatName}`);
  console.log(`Headers:`, JSON.stringify(headers, null, 2).substring(0, 500) + '...');
  console.log(`Body:`, JSON.stringify(body, null, 2).substring(0, 500) + '...');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    console.log(`Response status: ${response.status} ${response.statusText}`);

    if (response.ok) {
      const text = await response.text();
      console.log(`Response preview (first 500 chars): ${text.substring(0, 500)}...`);
      console.log(`✅ SUCCESS! Endpoint works with format ${formatName}`);
      return { success: true, endpoint, format: formatName, status: response.status, data: text };
    } else {
      const errorText = await response.text();
      console.log(`Error response: ${errorText.substring(0, 500)}...`);
      return { success: false, endpoint, format: formatName, status: response.status, error: errorText };
    }
  } catch (error) {
    console.log(`Request failed: ${error.message}`);
    return { success: false, endpoint, format: formatName, error: error.message };
  }
}

// Main test function
async function main() {
  console.log('GLM International API Tester');
  console.log('============================\n');

  // Load authentication data
  const authData = loadAuthData();
  const cookies = parseCookies(authData.cookie);
  const accessToken = extractAccessToken(cookies);

  // Test parameters
  const model = 'glm-4-plus';
  const testMessage = 'Hello, please respond with a short greeting.';

  // Test different combinations
  const results = [];
  const bodyFormats = [
    { id: 1, name: 'Original chatglm.cn format' },
    { id: 2, name: 'OpenAI compatible format' },
    { id: 3, name: 'Simplified format' },
    { id: 4, name: 'Alternative with conversation_id' },
  ];

  // Limit to first few endpoints for initial testing
  const testEndpoints = API_ENDPOINTS.slice(0, 6);

  for (const endpoint of testEndpoints) {
    for (const format of bodyFormats) {
      const result = await testEndpoint(
        endpoint,
        authData,
        accessToken,
        model,
        testMessage,
        format.id,
        format.name
      );
      results.push(result);

      // If successful, stop further tests
      if (result.success) {
        console.log(`\n🎉 Found working configuration!`);
        console.log(`Endpoint: ${result.endpoint}`);
        console.log(`Body format: ${result.format}`);

        // Generate curl command for user to test
        const curlCommand = generateCurlCommand(endpoint, authData, accessToken, model, testMessage, format.id);
        console.log(`\nCURL command to test:`);
        console.log(curlCommand);

        return;
      }

      // Wait a bit between requests
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // If we get here, no configuration worked
  console.log('\n❌ No working configuration found. All tests failed.');
  console.log('\nSummary of failed tests:');
  results.forEach((result, index) => {
    console.log(`${index + 1}. ${result.endpoint} (${result.format}): ${result.status || 'Error'} - ${result.error?.substring(0, 100) || 'Unknown error'}`);
  });

  console.log('\n📋 Next steps:');
  console.log('1. Open https://chat.z.ai in Chrome browser');
  console.log('2. Press F12 to open Developer Tools');
  console.log('3. Go to Network tab and clear logs');
  console.log('4. Send a message in the chat');
  console.log('5. Look for API requests (filter by "stream", "completions", "chat")');
  console.log('6. Share the correct API endpoint, headers, and request body format');
}

// Generate curl command for successful configuration
function generateCurlCommand(endpoint, authData, accessToken, model, message, bodyFormat) {
  const deviceId = crypto.randomUUID().replace(/-/g, "");
  const requestId = crypto.randomUUID().replace(/-/g, "");
  const sign = generateSign();
  const assistantId = ASSISTANT_ID_MAP[model] || ASSISTANT_ID_MAP["glm-4-plus"];

  let body;
  switch(bodyFormat) {
    case 1:
      body = createRequestBodyFormat1(model, message, assistantId, "");
      break;
    case 2:
      body = createRequestBodyFormat2(model, message, assistantId, "");
      break;
    case 3:
      body = createRequestBodyFormat3(model, message, assistantId, "");
      break;
    case 4:
      body = createRequestBodyFormat4(model, message, assistantId, "");
      break;
    default:
      body = createRequestBodyFormat1(model, message, assistantId, "");
  }

  let curlCmd = `curl -X POST '${endpoint}' \\\n`;
  curlCmd += `  -H 'Content-Type: application/json' \\\n`;
  curlCmd += `  -H 'Accept: text/event-stream' \\\n`;
  curlCmd += `  -H 'App-Name: chatglm' \\\n`;
  curlCmd += `  -H 'Origin: https://chat.z.ai' \\\n`;
  curlCmd += `  -H 'X-App-Platform: pc' \\\n`;
  curlCmd += `  -H 'X-App-Version: 0.0.1' \\\n`;
  curlCmd += `  -H 'X-App-fr: default' \\\n`;
  curlCmd += `  -H 'X-Device-Brand: ' \\\n`;
  curlCmd += `  -H 'X-Device-Id: ${deviceId}' \\\n`;
  curlCmd += `  -H 'X-Device-Model: ' \\\n`;
  curlCmd += `  -H 'X-Exp-Groups: ${X_EXP_GROUPS}' \\\n`;
  curlCmd += `  -H 'X-Lang: zh' \\\n`;
  curlCmd += `  -H 'X-Nonce: ${sign.nonce}' \\\n`;
  curlCmd += `  -H 'X-Request-Id: ${requestId}' \\\n`;
  curlCmd += `  -H 'X-Sign: ${sign.sign}' \\\n`;
  curlCmd += `  -H 'X-Timestamp: ${sign.timestamp}' \\\n`;

  if (accessToken) {
    curlCmd += `  -H 'Authorization: Bearer ${accessToken}' \\\n`;
  }

  if (authData.cookie) {
    curlCmd += `  -H 'Cookie: ${authData.cookie.replace(/'/g, "'\\''")}' \\\n`;
  }

  curlCmd += `  -d '${JSON.stringify(body)}'`;

  return curlCmd;
}

// Run the test
main().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});