#!/bin/bash
# Run this on VPS to pull latest code and restart openclaw
echo "Pulling latest from GitHub..."
cd /home/openclaw/logface-agent
git pull origin main

echo "Installing dependencies..."
npm install

echo "Copying agent.json to openclaw..."
cp agent.json /home/openclaw/.openclaw/agents/logface/agent.json

echo "Restarting OpenClaw..."
openclaw restart

echo "Done! Logface agent updated."