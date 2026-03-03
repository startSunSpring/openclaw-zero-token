#!/usr/bin/env node

import WebSocket from 'ws';

async function main() {
  // Get Chrome DevTools Protocol endpoints
  const response = await fetch('http://127.0.0.1:9222/json/list');
  const tabs = await response.json();

  // Find chat.z.ai tab
  const glmTab = tabs.find(tab => tab.url && tab.url.includes('chat.z.ai'));
  if (!glmTab) {
    console.error('No chat.z.ai tab found. Please open chat.z.ai in Chrome.');
    process.exit(1);
  }

  console.log(`Found chat.z.ai tab: ${glmTab.title}`);
  console.log(`WebSocket URL: ${glmTab.webSocketDebuggerUrl}`);

  // Connect to WebSocket
  const ws = new WebSocket(glmTab.webSocketDebuggerUrl);

  ws.on('open', () => {
    console.log('Connected to Chrome DevTools Protocol');

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
          urlPattern: '*.z.ai/*',
          requestStage: 'Request'
        }]
      }
    }));

    console.log('Network and Fetch domains enabled.');
    console.log('Please send a message in the chat interface to capture API requests...');
  });

  ws.on('message', (data) => {
    const message = JSON.parse(data);

    // Log network requests
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request;
      if (request.url.includes('chat.z.ai') &&
          (request.url.includes('/api/') ||
           request.url.includes('/chat/') ||
           request.url.includes('/assistant/') ||
           request.url.includes('/backend-api/'))) {

        console.log('\n' + '='.repeat(80));
        console.log('API REQUEST CAPTURED:');
        console.log(`URL: ${request.url}`);
        console.log(`Method: ${request.method}`);
        console.log('Headers:', JSON.stringify(request.headers, null, 2));

        if (request.postData) {
          console.log('Request body:', request.postData.substring(0, 500) + (request.postData.length > 500 ? '...' : ''));
        }
      }
    }

    // Log responses
    if (message.method === 'Network.responseReceived') {
      const response = message.params.response;
      if (response.url.includes('chat.z.ai') &&
          (response.url.includes('/api/') ||
           response.url.includes('/chat/') ||
           response.url.includes('/assistant/') ||
           response.url.includes('/backend-api/'))) {

        console.log('\n' + '='.repeat(80));
        console.log('API RESPONSE:');
        console.log(`URL: ${response.url}`);
        console.log(`Status: ${response.status} ${response.statusText}`);
        console.log('Headers:', JSON.stringify(response.headers, null, 2));
      }
    }

    // Handle Fetch.requestPaused to get request details
    if (message.method === 'Fetch.requestPaused') {
      const params = message.params;
      if (params.request.url.includes('chat.z.ai') &&
          (params.request.url.includes('/api/') ||
           params.request.url.includes('/chat/') ||
           params.request.url.includes('/assistant/') ||
           params.request.url.includes('/backend-api/'))) {

        console.log('\n' + '='.repeat(80));
        console.log('FETCH REQUEST PAUSED:');
        console.log(`URL: ${params.request.url}`);
        console.log(`Method: ${params.request.method}`);
        console.log('Headers:', JSON.stringify(params.request.headers, null, 2));

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
    console.error('WebSocket error:', error);
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });

  // Keep script running
  process.on('SIGINT', () => {
    console.log('\n\nStopping capture...');
    ws.close();
    process.exit(0);
  });
}

// Check if required modules are available
try {
  // Check for ws module
  import('ws').then(() => {
    main().catch(console.error);
  }).catch(() => {
    console.error('ws module not found. Installing...');
    console.log('Please run: npm install ws');
    process.exit(1);
  });
} catch (e) {
  console.error('Error:', e);
}