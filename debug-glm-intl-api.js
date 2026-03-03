#!/usr/bin/env node

import { chromium } from 'playwright-core';
import { getHeadersWithAuth } from './src/browser/cdp.helpers.js';
import { getChromeWebSocketUrl } from './src/browser/chrome.js';
import { loadConfig } from './src/config/io.js';
import { resolveBrowserConfig, resolveProfile } from './src/browser/config.js';

async function main() {
  console.log('GLM International API Debugger');
  console.log('===============================\n');

  // Load config to connect to existing Chrome
  const rootConfig = loadConfig();
  const browserConfig = resolveBrowserConfig(rootConfig.browser, rootConfig);
  const profile = resolveProfile(browserConfig, browserConfig.defaultProfile);
  if (!profile) {
    throw new Error(`Could not resolve browser profile '${browserConfig.defaultProfile}'`);
  }

  const cdpUrl = profile.cdpUrl;
  console.log(`Connecting to Chrome at ${cdpUrl}...`);

  let wsUrl = null;
  for (let i = 0; i < 10; i++) {
    wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
    if (wsUrl) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!wsUrl) {
    throw new Error(`Failed to connect to Chrome at ${cdpUrl}. Make sure Chrome is running in debug mode.`);
  }

  console.log('Connecting to browser via CDP...');
  const browser = await chromium.connectOverCDP(wsUrl, {
    headers: getHeadersWithAuth(wsUrl),
  });
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.newPage());

  // Navigate to chat.z.ai if not already there
  const currentUrl = page.url();
  if (!currentUrl.includes('chat.z.ai')) {
    console.log('Navigating to https://chat.z.ai...');
    await page.goto('https://chat.z.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } else {
    console.log(`Already on page: ${currentUrl}`);
  }

  // Wait for page to load
  await page.waitForLoadState('networkidle');

  // Set up network request interception
  console.log('\nSetting up network request interception...');
  console.log('Please send a message in the chat interface to capture API requests.\n');

  const apiRequests = [];

  page.on('request', (request) => {
    const url = request.url();
    // Look for API endpoints
    if (url.includes('chat.z.ai') &&
        (url.includes('/api/') ||
         url.includes('/chat/') ||
         url.includes('/assistant/') ||
         url.includes('/conversation') ||
         url.includes('/completions') ||
         url.includes('/backend-api/'))) {

      console.log(`\n[API Request Found]`);
      console.log(`URL: ${url}`);
      console.log(`Method: ${request.method()}`);

      const headers = request.headers();
      const relevantHeaders = {};
      for (const [key, value] of Object.entries(headers)) {
        if (key.startsWith('x-') || key.startsWith('X-') ||
            key.toLowerCase().includes('auth') ||
            key.toLowerCase().includes('cookie') ||
            key === 'Content-Type' || key === 'Accept') {
          relevantHeaders[key] = value;
        }
      }
      console.log('Headers:', JSON.stringify(relevantHeaders, null, 2));

      apiRequests.push({
        url,
        method: request.method(),
        headers: relevantHeaders,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Also capture responses
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('chat.z.ai') &&
        (url.includes('/api/') ||
         url.includes('/chat/') ||
         url.includes('/assistant/') ||
         url.includes('/conversation') ||
         url.includes('/completions') ||
         url.includes('/backend-api/'))) {

      console.log(`\n[API Response]`);
      console.log(`URL: ${url}`);
      console.log(`Status: ${response.status()} ${response.statusText()}`);

      try {
        // Try to get response body for non-streaming responses
        if (response.status() === 200 && !response.headers()['content-type']?.includes('text/event-stream')) {
          const body = await response.text();
          console.log(`Response body (first 500 chars): ${body.substring(0, 500)}...`);
        } else if (response.headers()['content-type']?.includes('text/event-stream')) {
          console.log('Response type: Server-Sent Events (streaming)');
        }
      } catch (err) {
        // Ignore errors reading response body
      }
    }
  });

  // Wait for user input to continue
  console.log('\nPress Ctrl+C to stop capturing and show summary...\n');

  // Keep the script running
  await new Promise((resolve) => {
    process.on('SIGINT', () => {
      console.log('\n\nCapture stopped by user.');
      resolve();
    });
  });

  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('API REQUESTS CAPTURED');
  console.log('='.repeat(80));

  if (apiRequests.length === 0) {
    console.log('No API requests captured. Please make sure you send a message in the chat.');
  } else {
    for (const req of apiRequests) {
      console.log(`\n${req.timestamp} - ${req.method} ${req.url}`);
      console.log('Headers:', JSON.stringify(req.headers, null, 2));
    }

    // Generate curl command for the first POST request
    const postRequest = apiRequests.find(req => req.method === 'POST');
    if (postRequest) {
      console.log('\n' + '='.repeat(80));
      console.log('CURL COMMAND TEMPLATE');
      console.log('='.repeat(80));

      let curlCmd = `curl -X POST '${postRequest.url}' \\\n`;
      for (const [key, value] of Object.entries(postRequest.headers)) {
        curlCmd += `  -H '${key}: ${value.replace(/'/g, "'\\\\''")}' \\\n`;
      }
      curlCmd += `  --data-raw 'PASTE_REQUEST_BODY_HERE'`;

      console.log(curlCmd);

      console.log('\nNote: To get the request body, you may need to inspect the request');
      console.log('in Chrome DevTools Network tab or add request interception.');
    }
  }

  await browser.close();
  console.log('\nDebugging completed.');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});