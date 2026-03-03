#!/usr/bin/env node

import { chromium } from 'playwright-core';
import { getHeadersWithAuth } from './src/browser/cdp.helpers.js';
import { getChromeWebSocketUrl } from './src/browser/chrome.js';
import { loadConfig } from './src/config/io.js';
import { resolveBrowserConfig, resolveProfile } from './src/browser/config.js';

async function main() {
  console.log('GLM International Request Debugger');
  console.log('===================================\n');

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
  const page = context.pages().find(p => p.url().includes('chat.z.ai')) || context.pages()[0];

  console.log(`Page URL: ${page.url()}`);

  // Set up request interception to get POST data
  await page.route('**/*', async (route, request) => {
    const url = request.url();
    if (url.includes('chat.z.ai') && url.includes('/api/') && request.method() === 'POST') {
      console.log('\n' + '='.repeat(80));
      console.log('INTERCEPTED POST REQUEST:');
      console.log(`URL: ${url}`);
      console.log(`Method: ${request.method()}`);
      console.log('Headers:', JSON.stringify(request.headers(), null, 2));

      const postData = request.postData();
      if (postData) {
        console.log('Post data:', postData.substring(0, 1000) + (postData.length > 1000 ? '...' : ''));

        try {
          const parsed = JSON.parse(postData);
          console.log('Parsed JSON:', JSON.stringify(parsed, null, 2).substring(0, 1000) + (JSON.stringify(parsed).length > 1000 ? '...' : ''));
        } catch {
          // Not JSON
        }
      }
    }

    // Continue the request
    await route.continue();
  });

  console.log('\nRequest interception enabled.');
  console.log('Please send a message in the chat interface to capture API requests...');
  console.log('Press Ctrl+C to stop.\n');

  // Keep script running
  await new Promise((resolve) => {
    process.on('SIGINT', () => {
      console.log('\n\nStopping debugger...');
      resolve();
    });
  });

  await browser.close();
  console.log('Debugging completed.');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});