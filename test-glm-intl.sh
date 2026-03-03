#!/bin/bash

# GLM国际版自动测试脚本

echo "🔧 GLM国际版自动测试"
echo "======================"

# 获取Web UI token（从日志中提取）
TOKEN="62b791625fa441be036acd3c206b7e14e2bb13c803355823"
API_URL="http://127.0.0.1:3001/v1/chat/completions"

echo "📡 API地址: $API_URL"
echo "🔑 Token: $TOKEN"
echo "🤖 模型: glm-intl-web/glm-4-plus"

# 检查服务是否运行
echo -n "🔄 检查服务状态..."
if curl -s http://127.0.0.1:3001/health > /dev/null 2>&1; then
    echo "✅ 服务运行中"
else
    echo "❌ 服务未运行"
    echo "请先运行: ./server.sh start"
    exit 1
fi

# 发送测试请求
echo "📤 发送测试请求..."
RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "model": "glm-intl-web/glm-4-plus",
    "messages": [
      {
        "role": "user",
        "content": "Hello, please respond with a short greeting."
      }
    ],
    "stream": false,
    "max_tokens": 100
  }')

echo "📥 收到响应:"
echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"

# 检查响应中的错误
if echo "$RESPONSE" | grep -q "error"; then
    echo "❌ 测试失败"
    echo ""
    echo "🔍 调试建议:"
    echo "1. 检查网关日志: tail -f /tmp/openclaw-gateway.log"
    echo "2. 查看GLM相关错误: grep -i \"glm\|chat.z.ai\" /tmp/openclaw-gateway.log"
    echo "3. 确保Chrome在调试模式运行: ./start-chrome-debug.sh"
    echo "4. 确保已登录chat.z.ai并获取cookie"
else
    echo "✅ 测试成功！"
    CONTENT=$(echo "$RESPONSE" | jq -r '.choices[0].message.content' 2>/dev/null)
    if [ -n "$CONTENT" ] && [ "$CONTENT" != "null" ]; then
        echo "💬 AI回复: $CONTENT"
    fi
fi

echo ""
echo "📋 下一步:"
echo "1. 如果测试失败，请检查上述日志"
echo "2. 运行修复脚本: node fix-glm-intl-api.js"
echo "3. 在浏览器开发者工具中手动检查API请求"