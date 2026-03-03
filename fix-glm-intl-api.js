#!/usr/bin/env node

/**
 * GLM International API 修复脚本
 *
 * 这个脚本会：
 * 1. 连接到正在运行的Chrome浏览器
 * 2. 捕获chat.z.ai的真实API请求
 * 3. 分析请求格式和参数
 * 4. 生成正确的OpenClaw配置
 * 5. 输出可用的curl命令
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 检查Chrome是否在运行
async function checkChrome() {
  try {
    const response = await fetch('http://127.0.0.1:9222/json/list');
    const tabs = await response.json();
    const glmTab = tabs.find(tab => tab.url && tab.url.includes('chat.z.ai'));
    return glmTab;
  } catch (error) {
    console.error('无法连接到Chrome调试端口（9222）。请确保Chrome正在调试模式下运行。');
    console.error('运行命令: ./start-chrome-debug.sh');
    return null;
  }
}

// 连接到Chrome并捕获API请求
async function captureAPIRequests() {
  console.log('🔍 正在连接到Chrome浏览器...');

  const glmTab = await checkChrome();
  if (!glmTab) {
    process.exit(1);
  }

  console.log(`✅ 找到chat.z.ai标签页: ${glmTab.title}`);
  console.log(`🔗 WebSocket URL: ${glmTab.webSocketDebuggerUrl}`);

  // 连接到浏览器
  const browser = await chromium.connect(glmTab.webSocketDebuggerUrl);
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().includes('chat.z.ai')) || context.pages()[0];

  console.log(`🌐 当前页面: ${page.url()}`);
  console.log('\n📡 正在设置请求拦截...');
  console.log('💬 请在浏览器中发送一条消息以捕获API请求');
  console.log('⏳ 等待请求（60秒超时）...\n');
  console.log('提示：请确保在 chat.z.ai 网页的聊天输入框中发送消息，不是在命令行中。');

  const capturedRequests = [];

  // 使用 page.route 拦截所有请求（更可靠）
  await page.route('**/*', async (route, request) => {
    const url = request.url();
    if (url.includes('chat.z.ai')) {
      const method = request.method();

      if (method === 'POST') {
        console.log('🎯 捕获到POST请求!');
        console.log(`📤 URL: ${url}`);
        console.log(`📝 方法: ${method}`);

        const headers = request.headers();
        const importantHeaders = {};
        for (const [key, value] of Object.entries(headers)) {
          if (key.startsWith('x-') || key.startsWith('X-') ||
              key.toLowerCase().includes('auth') ||
              key === 'Content-Type' || key === 'Accept' ||
              key === 'User-Agent' || key === 'Origin' ||
              key === 'Authorization') {
            importantHeaders[key] = value;
          }
        }
        console.log('📋 请求头:', JSON.stringify(importantHeaders, null, 2));

        const postData = request.postData();
        if (postData) {
          console.log('📦 请求体（前1000字符）:', postData.substring(0, 1000));
          try {
            const parsed = JSON.parse(postData);
            console.log('📊 解析后的JSON:', JSON.stringify(parsed, null, 2));
          } catch {
            console.log('⚠️  请求体不是有效的JSON');
          }
        }

        capturedRequests.push({
          url,
          method,
          headers: importantHeaders,
          postData,
          timestamp: new Date().toISOString(),
        });

        console.log('---\n');
      } else if (method === 'GET' && (url.includes('/api/') || url.includes('/chat/') || url.includes('/stream'))) {
        console.log(`🔍 发现GET请求: ${url}`);
        console.log(`📝 方法: ${method}`);
      }
    }

    // 继续请求
    await route.continue();
  });

  // 也监听WebSocket连接
  page.on('websocket', (ws) => {
    const url = ws.url();
    if (url.includes('chat.z.ai')) {
      console.log(`🌐 发现WebSocket连接: ${url}`);
      console.log('💡 GLM国际版可能使用WebSocket进行实时通信');
    }
  });

  // 监听响应
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('chat.z.ai') &&
        response.request().method() === 'POST') {
        // Capture ALL POST responses from chat.z.ai for debugging

      console.log('📥 收到API响应');
      console.log('🔢 状态码:', response.status(), response.statusText());

      try {
        const body = await response.text();
        console.log('📄 响应体（前500字符）:', body.substring(0, 500));

        // 检查是否为SSE格式
        if (body.includes('data:') || response.headers()['content-type']?.includes('text/event-stream')) {
          console.log('⚡ 响应格式: Server-Sent Events (SSE)');

          // 解析SSE事件
          const lines = body.split('\n').filter(line => line.trim());
          let eventCount = 0;
          for (const line of lines) {
            if (line.startsWith('data:')) {
              const data = line.slice(5).trim();
              if (data === '[DONE]') {
                console.log('✅ 收到 [DONE] 事件');
              } else {
                eventCount++;
                try {
                  const parsed = JSON.parse(data);
                  console.log(`📦 SSE事件 ${eventCount}:`, JSON.stringify(parsed).substring(0, 200));
                } catch {
                  console.log(`📦 SSE事件 ${eventCount}:`, data.substring(0, 200));
                }
              }
            }
          }
        }
      } catch (error) {
        console.log('⚠️  无法读取响应体:', error.message);
      }

      console.log('---\n');
    }
  });

  // 等待60秒或直到捕获到请求
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log('⏰ 超时：60秒内未捕获到请求');
      resolve();
    }, 60000);

    // 如果捕获到请求，提前结束
    const checkInterval = setInterval(() => {
      if (capturedRequests.length > 0) {
        clearTimeout(timeout);
        clearInterval(checkInterval);
        console.log('✅ 成功捕获到API请求');
        resolve();
      }
    }, 1000);
  });

  await browser.close();

  return capturedRequests;
}

// 生成OpenClaw配置
function generateConfig(capturedRequests) {
  if (capturedRequests.length === 0) {
    console.log('❌ 未捕获到任何API请求，无法生成配置');
    return null;
  }

  const request = capturedRequests[0];
  const url = new URL(request.url);

  console.log('\n' + '='.repeat(80));
  console.log('🛠️  OPENCLAW 配置生成');
  console.log('='.repeat(80));

  // 提取关键信息
  const baseUrl = `${url.protocol}//${url.host}`;
  const apiPath = url.pathname;
  const queryParams = Object.fromEntries(url.searchParams.entries());

  console.log('📋 基础URL:', baseUrl);
  console.log('🔗 API路径:', apiPath);
  console.log('📌 查询参数:', JSON.stringify(queryParams, null, 2));

  // 解析请求体
  let requestBody = {};
  if (request.postData) {
    try {
      requestBody = JSON.parse(request.postData);
    } catch {
      console.log('⚠️  无法解析请求体JSON');
    }
  }

  // 生成OpenClaw配置
  const config = {
    api: 'glm-intl-web',
    baseUrl: 'https://chat.z.ai',
    endpoints: {
      chatCompletions: '/api/v2/chat/completions'
    },
    headers: {
      // 从捕获的请求中提取必要头部
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Origin': 'https://chat.z.ai',
      'User-Agent': request.headers['user-agent'] || 'Mozilla/5.0',
    },
    // 如果需要认证头
    authHeaders: {
      'Authorization': request.headers['authorization'] ? 'Bearer {{token}}' : undefined,
      'X-FE-Version': request.headers['x-fe-version'] || 'prod-fe-1.0.250',
      'X-Signature': '{{signature}}' // 需要动态生成
    },
    requestFormat: requestBody,
    queryParams: queryParams
  };

  console.log('\n📝 生成的配置:');
  console.log(JSON.stringify(config, null, 2));

  // 生成curl命令
  console.log('\n' + '='.repeat(80));
  console.log('🔧 CURL 命令模板');
  console.log('='.repeat(80));

  let curlCmd = `curl -X POST '${request.url}' \\\n`;

  // 添加头部
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === 'host') continue;
    if (key.toLowerCase() === 'content-length') continue;
    curlCmd += `  -H '${key}: ${value.replace(/'/g, "'\\\\''")}' \\\n`;
  }

  // 添加请求体
  if (request.postData) {
    curlCmd += `  --data-raw '${request.postData.replace(/'/g, "'\\\\''")}'`;
  } else {
    curlCmd += `  --data-raw '{"model": "glm-4-plus", "messages": [{"role": "user", "content": "Hello"}]}'`;
  }

  console.log(curlCmd);

  // 修复glm-intl-web-client-browser.ts的建议
  console.log('\n' + '='.repeat(80));
  console.log('💡 修复建议');
  console.log('='.repeat(80));

  console.log(`
1. 更新 src/providers/glm-intl-web-client-browser.ts:
   - 使用端点: ${apiPath}
   - 添加必要的请求头: ${Object.keys(config.authHeaders).filter(k => config.authHeaders[k]).join(', ')}

2. 可能需要实现签名生成函数
   - X-Signature 头需要动态生成
   - 算法可能需要从页面JavaScript中提取

3. 或者，保持现有实现但使用相对路径
   - 在 page.evaluate() 中使用相对路径 "${apiPath}"
   - 让浏览器自动添加必要的头部和参数
`);

  return config;
}

// 主函数
async function main() {
  console.log('🚀 GLM International API 修复工具');
  console.log('====================================\n');

  try {
    const requests = await captureAPIRequests();
    const config = generateConfig(requests);

    if (config) {
      console.log('\n✅ 修复完成！');
      console.log('\n📋 下一步:');
      console.log('1. 根据上面的建议更新代码');
      console.log('2. 运行 pnpm build 重新构建');
      console.log('3. 运行 ./server.sh restart 重启服务');
      console.log('4. 在Web UI中测试GLM国际版');
    } else {
      console.log('\n❌ 无法生成配置，请手动检查网络请求。');
    }
  } catch (error) {
    console.error('❌ 错误:', error.message);
    console.error(error.stack);
  }
}

main().catch(console.error);