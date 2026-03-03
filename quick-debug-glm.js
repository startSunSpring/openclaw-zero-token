#!/usr/bin/env node

import { chromium } from 'playwright-core';

async function main() {
  console.log('GLM国际版快速调试工具');
  console.log('=====================\n');

  try {
    // 连接到已运行的Chrome
    console.log('连接到Chrome调试端口...');
    const response = await fetch('http://127.0.0.1:9222/json/list');
    const tabs = await response.json();

    console.log(`找到 ${tabs.length} 个标签页:`);
    const glmTab = tabs.find(tab => tab.url && tab.url.includes('chat.z.ai'));

    if (!glmTab) {
      console.log('❌ 未找到chat.z.ai标签页');
      console.log('请确保Chrome已打开并访问 https://chat.z.ai');
      process.exit(1);
    }

    console.log(`✅ 找到GLM国际版标签页: ${glmTab.title}`);
    console.log(`🔗 连接URL: ${glmTab.webSocketDebuggerUrl}`);

    // 连接浏览器
    console.log('连接到浏览器...');
    const browser = await chromium.connect(glmTab.webSocketDebuggerUrl);
    const context = browser.contexts()[0];
    const page = context.pages().find(p => p.url().includes('chat.z.ai')) || context.pages()[0];

    console.log(`🌐 当前页面: ${page.url()}`);
    console.log(`📄 页面标题: ${await page.title()}`);

    // 等待页面加载
    await page.waitForLoadState('networkidle');

    // 检查页面状态
    console.log('\n🔍 检查页面状态...');
    const pageState = await page.evaluate(() => {
      return {
        title: document.title,
        url: window.location.href,
        hasChatInput: !!document.querySelector('textarea, input[type="text"], [contenteditable="true"]'),
        bodyText: document.body.innerText.substring(0, 200) + '...'
      };
    });

    console.log('页面状态:', JSON.stringify(pageState, null, 2));

    // 监听网络请求
    console.log('\n📡 开始监听网络请求...');
    console.log('请在聊天界面发送一条消息\n');

    const requests = [];
    const responses = [];

    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('chat.z.ai') && request.method() === 'POST') {
        console.log(`🎯 POST请求: ${url}`);

        const headers = request.headers();
        const relevantHeaders = {};
        for (const [key, value] of Object.entries(headers)) {
          if (key.startsWith('x-') || key.startsWith('X-') ||
              key.toLowerCase().includes('auth') ||
              key === 'Content-Type' || key === 'Accept' ||
              key === 'Authorization') {
            relevantHeaders[key] = value;
          }
        }

        const requestData = {
          url,
          method: request.method(),
          headers: relevantHeaders,
          timestamp: new Date().toISOString()
        };

        requests.push(requestData);

        console.log('请求头:', JSON.stringify(relevantHeaders, null, 2));
      }
    });

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('chat.z.ai') && response.request().method() === 'POST') {
        console.log(`📥 响应: ${url} - ${response.status()} ${response.statusText()}`);

        try {
          const body = await response.text();
          console.log(`响应体 (前500字符): ${body.substring(0, 500)}`);

          if (body.includes('data:') || response.headers()['content-type']?.includes('text/event-stream')) {
            console.log('⚡ 响应格式: Server-Sent Events (SSE)');
          }
        } catch (err) {
          console.log('无法读取响应体:', err.message);
        }

        responses.push({
          url,
          status: response.status(),
          timestamp: new Date().toISOString()
        });
      }
    });

    // 检查当前是否有聊天历史
    console.log('\n💬 检查聊天历史...');
    const hasMessages = await page.evaluate(() => {
      const elements = document.querySelectorAll('[class*="message"], [class*="Message"], [class*="chat"]');
      return elements.length > 0;
    });
    console.log(`有聊天记录: ${hasMessages ? '是' : '否'}`);

    // 尝试自动发送消息（如果页面允许）
    console.log('\n🤖 尝试查找聊天输入框...');
    const inputSelector = await page.evaluate(() => {
      const selectors = [
        'textarea',
        'input[type="text"]',
        '[contenteditable="true"]',
        '[class*="input"]',
        '[class*="textarea"]',
        '[class*="chat-input"]'
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
          return selector;
        }
      }
      return null;
    });

    if (inputSelector) {
      console.log(`✅ 找到输入框: ${inputSelector}`);
      console.log('💡 请在页面中输入消息并按发送键');
    } else {
      console.log('❌ 未找到输入框，请手动检查页面');
    }

    // 等待用户手动操作
    console.log('\n⏳ 等待60秒，请在浏览器中发送消息...');
    console.log('按 Ctrl+C 停止\n');

    await new Promise((resolve) => {
      setTimeout(() => {
        console.log('\n⏰ 60秒超时');
        resolve();
      }, 60000);

      process.on('SIGINT', () => {
        console.log('\n👋 用户中断');
        resolve();
      });
    });

    // 汇总结果
    console.log('\n' + '='.repeat(80));
    console.log('调试结果汇总');
    console.log('='.repeat(80));
    console.log(`捕获的请求数: ${requests.length}`);
    console.log(`捕获的响应数: ${responses.length}`);

    if (requests.length > 0) {
      console.log('\n📋 捕获的请求详情:');
      for (const req of requests) {
        console.log(`\n${req.timestamp} - ${req.method} ${req.url}`);
        console.log('请求头:', JSON.stringify(req.headers, null, 2));
      }
    } else {
      console.log('\n❌ 未捕获到任何API请求');
      console.log('可能原因:');
      console.log('1. GLM国际版使用WebSocket而非HTTP');
      console.log('2. 请求被页面应用层拦截');
      console.log('3. 需要在特定条件下触发API调用');
    }

    await browser.close();
    console.log('\n✅ 调试完成');

  } catch (error) {
    console.error('❌ 错误:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main().catch(console.error);