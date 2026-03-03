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

// Extract token from cookies
function extractToken(cookies) {
  // Look for token cookie
  if (cookies.token) {
    console.log(`Found token cookie: token`);
    return cookies.token;
  }

  // Try other possible names
  const tokenNames = ['token', 'chatglm_token', 'access_token', 'auth_token'];
  for (const name of tokenNames) {
    if (cookies[name]) {
      console.log(`Found token cookie: ${name}`);
      return cookies[name];
    }
  }

  console.log('No token found in cookies');
  return null;
}

// Generate signature (need to figure out how X-Signature is generated)
function generateSignature(timestamp, token, userId) {
  // This is a placeholder - need to figure out actual signature algorithm
  // From the captured request, X-Signature looks like a SHA256 hash
  const secret = 'unknown_secret'; // Need to find the actual secret
  const data = `${timestamp}${token}${userId}${secret}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function testAPI() {
  console.log('GLM International API V2 Tester');
  console.log('===============================\n');

  // Load authentication data
  const authData = loadAuthData();
  const cookies = parseCookies(authData.cookie);
  const token = extractToken(cookies);

  if (!token) {
    console.error('No token found in cookies');
    process.exit(1);
  }

  // Extract user ID from token (JWT payload)
  let userId = 'unknown';
  try {
    const payloadBase64 = token.split('.')[1];
    if (payloadBase64) {
      const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
      userId = payload.id || payload.userId || 'unknown';
      console.log(`Extracted user ID from token: ${userId}`);
    }
  } catch (err) {
    console.log('Could not parse token payload, using default user ID');
  }

  // Test endpoint from captured request
  const timestamp = Date.now();
  const requestId = crypto.randomUUID();

  // Build query parameters (based on captured request)
  const queryParams = new URLSearchParams({
    timestamp: timestamp.toString(),
    requestId,
    user_id: userId,
    version: '0.0.1',
    platform: 'web',
    token,
    user_agent: encodeURIComponent(authData.userAgent || 'Mozilla/5.0'),
    language: 'zh-CN',
    languages: 'zh-CN,zh',
    timezone: 'Asia/Shanghai',
    cookie_enabled: 'true',
    screen_width: '1536',
    screen_height: '864',
    screen_resolution: '1536x864',
    viewport_height: '704',
    viewport_width: '1544',
    viewport_size: '1544x704',
    color_depth: '24',
    pixel_ratio: '1.25',
    current_url: encodeURIComponent('https://chat.z.ai/'),
    pathname: encodeURIComponent('/'),
    search: '',
    hash: '',
    host: 'chat.z.ai',
    hostname: 'chat.z.ai',
    protocol: 'https:',
    referrer: '',
    title: encodeURIComponent('Z.ai - Free AI Chatbot & Agent powered by GLM-5 & GLM-4.7'),
    timezone_offset: '-480',
    local_time: new Date(timestamp).toISOString(),
    utc_time: new Date(timestamp).toUTCString(),
    is_mobile: 'false',
    is_touch: 'false',
    max_touch_points: '0',
    browser_name: 'Chrome',
    os_name: 'Linux',
    signature_timestamp: timestamp.toString(),
  });

  const endpoint = `https://chat.z.ai/api/v2/chat/completions?${queryParams.toString()}`;

  // Request body (need to figure out correct format)
  // Based on common chat completion APIs
  const requestBody = {
    model: 'glm-4-plus',
    messages: [
      {
        role: 'user',
        content: 'Hello, please respond with a short greeting.'
      }
    ],
    stream: true,
    temperature: 0.7,
    max_tokens: 1000,
  };

  // Headers from captured request
  const headers = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Authorization': `Bearer ${token}`,
    'Origin': 'https://chat.z.ai',
    'Referer': 'https://chat.z.ai/',
    'User-Agent': authData.userAgent || 'Mozilla/5.0',
    'X-FE-Version': 'prod-fe-1.0.250',
    'X-Signature': generateSignature(timestamp, token, userId),
    'sec-ch-ua': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
  };

  // Add cookies
  if (authData.cookie) {
    headers['Cookie'] = authData.cookie;
  }

  console.log(`\n=== Testing endpoint: https://chat.z.ai/api/v2/chat/completions ===`);
  console.log(`Query params length: ${queryParams.toString().length} chars`);
  console.log(`Headers:`, JSON.stringify(headers, null, 2).substring(0, 500) + '...');
  console.log(`Body:`, JSON.stringify(requestBody, null, 2));

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    console.log(`\nResponse status: ${response.status} ${response.statusText}`);
    console.log(`Response headers:`, JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));

    if (response.ok) {
      const text = await response.text();
      console.log(`Response preview (first 500 chars): ${text.substring(0, 500)}...`);

      if (text.includes('[DONE]')) {
        console.log(`✅ SUCCESS! API endpoint works!`);

        // Parse SSE events
        const lines = text.split('\n').filter(line => line.trim());
        console.log(`\nParsed ${lines.length} SSE events:`);
        for (const line of lines) {
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              console.log('  [DONE]');
            } else {
              try {
                const parsed = JSON.parse(data);
                console.log(`  ${JSON.stringify(parsed).substring(0, 100)}...`);
              } catch {
                console.log(`  ${data.substring(0, 100)}...`);
              }
            }
          }
        }
      } else {
        console.log(`Response (not SSE): ${text.substring(0, 1000)}...`);
      }
    } else {
      const errorText = await response.text();
      console.log(`Error response: ${errorText.substring(0, 500)}...`);
    }
  } catch (error) {
    console.log(`Request failed: ${error.message}`);
  }
}

testAPI().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});