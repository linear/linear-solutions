#!/bin/bash

# Linear Release Management Setup Script for Mac/Linux
# This script sets up the Linear Release Manager with Ngrok

set -e  # Exit on any error

echo "Setting up Linear Release Manager with Ngrok..."
echo "=================================================="

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check if Docker is installed
if ! command_exists docker; then
    echo "Docker is not installed. Please install Docker first."
    echo "   Visit: https://docs.docker.com/get-docker/"
    echo "   For Mac: brew install --cask docker"
    echo "   For Ubuntu: sudo apt-get install docker.io docker-compose"
    exit 1
fi

# Check if Docker Compose is installed
if ! command_exists docker-compose && ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose is not installed. Please install Docker Compose first."
    echo "   Visit: https://docs.docker.com/compose/install/"
    echo "   For Mac: brew install docker-compose"
    echo "   For Ubuntu: sudo apt-get install docker-compose"
    exit 1
fi

echo "Docker and Docker Compose are installed"

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running. Please start Docker and try again."
    echo "   For Mac: Open Docker Desktop application"
    echo "   For Linux: sudo systemctl start docker"
    exit 1
fi

echo "Docker is running"

# Create environment file if it doesn't exist
echo "Debug: Checking for .env file..."
echo "Debug: Current directory: $(pwd)"
echo "Debug: Testing file existence methods..."

if [ -f .env ]; then
    echo ".env file found"
    ENV_EXISTS=true
else
    echo ".env file not found"
    ENV_EXISTS=false
fi

if [ "$ENV_EXISTS" = false ]; then
    echo
    echo "Creating .env file from template..."
    
    # Check if env.example exists
    if [ -f env.example ]; then
        cp env.example .env
        echo "Copied env.example to .env"
    else
        echo "env.example not found, creating basic .env file..."
        cat > .env << EOF
# GitHub Configuration
GITHUB_TOKEN=your_github_personal_access_token_here

# Linear Configuration
LINEAR_API_KEY=your_linear_api_key_here

# Ngrok Configuration
NGROK_AUTH_TOKEN=your_ngrok_auth_token_here
NGROK_DOMAIN=your_custom_domain_here
WEBHOOK_SECRET=webhook_secret_$(openssl rand -hex 8)

# Server Configuration (optional)
PORT=3000
EOF
        echo "Created basic .env file"
    fi
    
    echo
    echo "IMPORTANT: Please edit .env file with your API keys and ngrok configuration:"
    echo
    echo "Required API Keys:"
    echo "   - GITHUB_TOKEN: Your GitHub personal access token"
    echo "   - LINEAR_API_KEY: Your Linear API key"
    echo
    echo "Ngrok Configuration:"
    echo "   - NGROK_AUTH_TOKEN: Your ngrok auth token (get from https://dashboard.ngrok.com)"
    echo "   - NGROK_DOMAIN: Your custom ngrok domain (optional, leave empty for random)"
    echo "   - WEBHOOK_SECRET: A secret string for webhook authentication"
    echo
    echo "After editing .env, run this script again to start the application."
    echo
    echo "Quick setup tips:"
    echo "   - GitHub token: https://github.com/settings/tokens"
    echo "   - Linear API key: https://linear.app/settings/api"
    echo "   - Ngrok auth token: https://dashboard.ngrok.com/get-started/your-authtoken"
    echo
    echo "Press Enter to continue..."
    read -r
    exit 0
fi

echo "Environment file found, proceeding with setup..."

# Load environment variables from .env file
echo "Loading environment variables..."
if [ -f .env ]; then
    # Source the .env file
    set -a  # automatically export all variables
    source .env
    set +a
    echo "Environment variables loaded"
else
    echo "Error: .env file not found after checking"
    exit 1
fi

# Set default values if not defined
if [ -z "$WEBHOOK_SECRET" ]; then
    echo "Generating random webhook secret..."
    export WEBHOOK_SECRET="webhook_secret_$(openssl rand -hex 8)"
fi

if [ -z "$NGROK_DOMAIN" ]; then
    echo "No custom ngrok domain specified, will use random URL"
    export NGROK_DOMAIN=""
fi

# Generate ngrok.yml configuration
echo "Generating ngrok configuration..."
echo "Debug: NGROK_AUTH_TOKEN=$NGROK_AUTH_TOKEN"
echo "Debug: WEBHOOK_SECRET=$WEBHOOK_SECRET"
echo "Debug: NGROK_DOMAIN=$NGROK_DOMAIN"

cat > ngrok.yml << EOF
version: "2"
authtoken: "$NGROK_AUTH_TOKEN"
tunnels:
  github-webhook:
    addr: 3000
    proto: http
EOF

if [ -n "$NGROK_DOMAIN" ]; then
    echo "    domain: \"$NGROK_DOMAIN\"" >> ngrok.yml
fi

cat >> ngrok.yml << EOF
    inspect: true
EOF

echo "Ngrok configuration generated"

# Create logs directory
echo "Creating logs directory..."
mkdir -p logs

# Build and start the application
echo
echo "Building and starting Linear Release Manager with Ngrok..."
echo "This may take a few minutes on first run..."

# Build the image first
echo "Building Docker image..."
docker-compose build

# Start the services
echo "Starting services..."
docker-compose up -d

# Wait for services to start
echo "Waiting for services to start..."
sleep 15

# Check service status
echo "Checking service status..."
if docker-compose ps | grep -q "Up"; then
    echo "Services are running"
else
    echo "Some services failed to start"
    echo "Checking logs..."
    docker-compose logs --tail=20
    exit 1
fi

# Wait a bit more for ngrok to establish connection
echo
echo "Ngrok Status:"
echo "=================="
sleep 5

echo "Ngrok web interface available at http://localhost:4040"

# Show webhook URL
if [ -n "$NGROK_DOMAIN" ]; then
    webhook_url="https://$NGROK_DOMAIN/github-webhook"
else
    webhook_url="https://your-ngrok-url.ngrok.io/github-webhook (check ngrok dashboard)"
fi

echo
echo "Setup complete!"
echo "=================="
echo
echo "Your webhook URL: $webhook_url"
echo "Ngrok dashboard: http://localhost:4040"
echo "Health check: http://localhost:3000/health"
echo
echo "Webhook authentication:"
echo "   Username: webhook"
echo "   Password: $WEBHOOK_SECRET"
echo
echo "Useful commands:"
echo "   Check logs: docker-compose logs -f"
echo "   Restart: docker-compose restart"
echo "   Stop: docker-compose down"
echo "   Update: git pull && docker-compose up -d --build"
echo
echo "Next steps:"
echo "   1. Add the webhook URL to your GitHub repository settings"
echo "   2. Set the webhook secret to: $WEBHOOK_SECRET"
echo "   3. Test with a release to verify everything works"
echo
echo "Happy releasing!"
echo
echo "Press Enter to continue..."
read -r
