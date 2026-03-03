#!/usr/bin/env node

import WebSocket from 'ws';
import fetch from 'node-fetch';

async function main() {
  console.log('🕵️  Direct GLM International API Capture');
  console.log('==========================================\n');

  // Step 1: Get Chrome DevTools tabs
  console.log('📋 Getting Chrome DevTools tabs...');
  let tabs;
  try {
    const response = await fetch('http://127.0.0.1:9222/json/list');
    tabs = await response.json();
  } catch (error) {
    console.error('❌ Failed to connect to Chrome debug port (9222)');
    console.error('Make sure Chrome is running with: ./start-chrome-debug.sh');
    process.exit(1);
  }

  // Find chat.z.ai tab
  const glmTab = tabs.find(tab => tab.url && tab.url.includes('chat.z.ai'));
  if (!glmTab) {
    console.error('❌ No chat.z.ai tab found');
    console.error('Please open https://chat.z.ai in Chrome');
    process.exit(1);
  }

  console.log(`✅ Found chat.z.ai tab: ${glmTab.title}`);
  console.log(`🔗 WebSocket URL: ${glmTab.webSocketDebuggerUrl}\n`);

  // Step 2: Connect to WebSocket
  console.log('🔌 Connecting to Chrome DevTools Protocol...');
  const ws = new WebSocket(glmTab.webSocketDebuggerUrl);

  const capturedRequests = [];

  ws.on('open', () => {
    console.log('✅ Connected to Chrome DevTools\n');
    console.log('🎯 Please send a message in the chat.z.ai browser tab...');
    console.log('⏳ Waiting for API requests (30 seconds)...\n');

    // Enable Network domain
    ws.send(JSON.stringify({
      id: 1,
      method: 'Network.enable',
      params: {}
    }));

    // Enable Fetch domain to intercept requests
    ws.send(JSON.stringify({
      id: 2,
      method: 'Fetch.enable',
      params: {
        patterns: [{
          urlPattern: '*chat.z.ai/*',
          requestStage: 'Request'
        }]
      }
    }));
  });

  ws.on('message', (data) => {
    const message = JSON.parse(data);

    // Handle Network.requestWillBeSent
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request;
      if (request.url.includes('chat.z.ai') &&
          (request.url.includes('/api/') ||
           request.url.includes('/chat/') ||
           request.url.includes('/assistant/') ||
           request.url.includes('/completions') ||
           request.url.includes('/stream'))) {

        console.log('🚨 API REQUEST CAPTURED 🚨');
        console.log('=' .repeat(60));
        console.log(`📤 URL: ${request.url}`);
        console.log(`📝 Method: ${request.method}`);
        console.log(`⏰ Timestamp: ${new Date().toISOString()}`);
        console.log('\n📋 HEADERS:');

        // Filter and display important headers
        const importantHeaders = {};
        for (const [key, value] of Object.entries(request.headers || {})) {
          if (key.startsWith('x-') || key.startsWith('X-') ||
              key.toLowerCase().includes('auth') ||
              key.toLowerCase().includes('cookie') ||
              key === 'Content-Type' || key === 'Accept' ||
              key === 'User-Agent' || key === 'Origin' ||
              key === 'Referer') {
            importantHeaders[key] = value;
          }
        }
        console.log(JSON.stringify(importantHeaders, null, 2));

        if (request.postData) {
          console.log('\n📦 REQUEST BODY:');
          console.log(request.postData.substring(0, 1000));
          if (request.postData.length > 1000) {
            console.log(`... (${request.postData.length} total chars)`);
          }

          // Try to parse JSON
          try {
            const parsed = JSON.parse(request.postData);
            console.log('\n📊 PARSED JSON:');
            console.log(JSON.stringify(parsed, null, 2));
          } catch {
            console.log('\n⚠️ Request body is not valid JSON');
          }
        }

        console.log('=' .repeat(60));
        console.log('\n');

        capturedRequests.push({
          url: request.url,
          method: request.method,
          headers: request.headers,
          postData: request.postData,
          timestamp: new Date().toISOString()
        });
      }
    }

    // Handle Fetch.requestPaused
    if (message.method === 'Fetch.requestPaused') {
      const params = message.params;
      if (params.request.url.includes('chat.z.ai') &&
          (params.request.url.includes('/api/') ||
           params.request.url.includes('/chat/') ||
           params.request.url.includes('/assistant/') ||
           params.request.url.includes('/completions') ||
           params.request.url.includes('/stream'))) {

        console.log('🛑 FETCH REQUEST PAUSED');
        console.log(`📤 URL: ${params.request.url}`);

        // Continue the request
        ws.send(JSON.stringify({
          id: 1000 + message.id,
          method: 'Fetch.continueRequest',
          params: {
            requestId: params.requestId
          }
        }));
      }
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });

  ws.on('close', () => {
    console.log('🔌 WebSocket connection closed');
  });

  // Run for 30 seconds
  setTimeout(() => {
    console.log('\n⏰ Timeout reached (30 seconds)');
    console.log(`📊 Captured ${capturedRequests.length} API requests`);

    if (capturedRequests.length > 0) {
      console.log('\n📋 SUMMARY:');
      console.log('=' .repeat(60));
      capturedRequests.forEach((req, i) => {
        console.log(`\nRequest ${i + 1}:`);
        console.log(`  URL: ${req.url}`);
        console.log(`  Method: ${req.method}`);

        // Show important headers
        const importantHeaders = {};
        for (const [key, value] of Object.entries(req.headers || {})) {
          if (key.startsWith('x-') || key.startsWith('X-') ||
              key.toLowerCase().includes('auth') ||
              key === 'Content-Type' || key === 'Accept') {
            importantHeaders[key] = value;
          }
        }
        console.log(`  Headers: ${JSON.stringify(importantHeaders)}`);
      });

      console.log('\n💡 Next steps:');
      console.log('1. Update glm-intl-web-client-browser.ts with the correct endpoint');
      console.log('2. Update headers in the request');
      console.log('3. Update request body format if needed');
      console.log('4. Run pnpm build && ./server.sh restart');
    } else {
      console.log('\n⚠️ No API requests captured');
      console.log('Make sure you send a message in the chat.z.ai tab');
    }

    ws.close();
    process.exit(0);
  }, 30000);

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Stopping capture...');
    ws.close();
    process.exit(0);
  });
}

// Check if ws module is available
try {
  await main();
} catch (error) {
  console.error('❌ Error:', error.message);
  console.log('\n📦 Installing required module:');
  console.log('npm install ws node-fetch');
  process.exit(1);
}