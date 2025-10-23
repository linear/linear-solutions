#!/bin/bash

# Linear Release Manager Basic Setup Script
# This script sets up the application without ngrok (local access only)

set -e

echo "🚀 Setting up Linear Release Manager..."
echo "======================================"

# Check prerequisites
echo "🔍 Checking prerequisites..."

if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    echo "   Visit: https://docs.docker.com/get-docker/"
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    echo "   Visit: https://docs.docker.com/compose/install/"
    exit 1
fi

echo "✅ Docker and Docker Compose are installed"

# Check if Docker is running
if ! docker info &> /dev/null; then
    echo "❌ Docker is not running. Please start Docker and try again."
    exit 1
fi

echo "✅ Docker is running"

# Create environment file if it doesn't exist
if [ ! -f .env ]; then
    echo ""
    echo "📝 Creating .env file from template..."
    cp env.example .env
    
    echo ""
    echo "⚠️  IMPORTANT: Please edit .env file with your API keys:"
    echo ""
    echo "🔑 Required API Keys:"
    echo "   - GITHUB_TOKEN: Your GitHub personal access token"
    echo "   - LINEAR_API_KEY: Your Linear API key"
    echo ""
    echo "📖 After editing .env, run this script again to start the application."
    echo ""
    echo "💡 Quick setup tips:"
    echo "   - GitHub token: https://github.com/settings/tokens"
    echo "   - Linear API key: https://linear.app/settings/api"
    exit 0
fi

# Load environment variables
echo "📋 Loading environment configuration..."
source .env

# Validate required variables
echo "🔍 Validating configuration..."

required_vars=("GITHUB_TOKEN" "LINEAR_API_KEY")
missing_vars=()

for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ] || [ "${!var}" = "your_${var,,}_here" ]; then
        missing_vars+=("$var")
    fi
done

if [ ${#missing_vars[@]} -ne 0 ]; then
    echo "❌ Missing or invalid configuration for:"
    for var in "${missing_vars[@]}"; do
        echo "   - $var"
    done
    echo ""
    echo "Please edit your .env file and fill in all required values."
    exit 1
fi

echo "✅ All required configuration is present"

# Create logs directory
echo "📁 Creating logs directory..."
mkdir -p logs

# Build and start the application
echo ""
echo "🐳 Building and starting Linear Release Manager..."
echo "This may take a few minutes on first run..."

# Build the image first
echo "🔨 Building Docker image..."
docker-compose build linear-release-manager

# Start the service
echo "🚀 Starting service..."
docker-compose up -d linear-release-manager

# Wait for service to start
echo "⏳ Waiting for service to start..."
sleep 10

# Check service status
echo "📊 Checking service status..."
if docker-compose ps | grep -q "Up"; then
    echo "✅ Service is running"
else
    echo "❌ Service failed to start"
    echo "📋 Checking logs..."
    docker-compose logs --tail=20
    exit 1
fi

echo ""
echo "🎉 Setup complete!"
echo "=================="
echo ""
echo "🌐 Your webhook URL: http://localhost:3000/github-webhook"
echo "🏥 Health check: http://localhost:3000/health"
echo ""
echo "📋 Useful commands:"
echo "   Check logs: docker-compose logs -f linear-release-manager"
echo "   Restart: docker-compose restart linear-release-manager"
echo "   Stop: docker-compose down"
echo "   Update: git pull && docker-compose up -d --build"
echo ""
echo "⚠️  Next steps:"
echo "   1. Add the webhook URL to your GitHub repository settings"
echo "   2. Test with a release to verify everything works"
echo ""
echo "💡 Note: This setup is for local development only."
echo "   For production use, consider running setup-with-ngrok.sh instead."
echo ""
echo "🎯 Happy releasing! 🚀"
