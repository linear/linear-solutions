@echo off
setlocal enabledelayedexpansion

echo Setting up Linear Release Manager with Ngrok...
echo ==================================================

REM Check if Docker is installed
docker --version >nul 2>&1
if errorlevel 1 (
    echo Docker is not installed. Please install Docker first.
    echo    Visit: https://docs.docker.com/get-docker/
    pause
    exit /b 1
)

REM Check if Docker Compose is installed
docker-compose --version >nul 2>&1
if errorlevel 1 (
    echo Docker Compose is not installed. Please install Docker Compose first.
    echo    Visit: https://docs.docker.com/compose/install/
    pause
    exit /b 1
)

echo Docker and Docker Compose are installed

REM Check if Docker is running
docker info >nul 2>&1
if errorlevel 1 (
    echo Docker is not running. Please start Docker and try again.
    pause
    exit /b 1
)

echo Docker is running

REM Create environment file if it doesn't exist
echo Debug: Checking for .env file...
echo Debug: Current directory: %CD%
echo Debug: Testing file existence methods...
if exist .env (
    echo .env file found with 'if exist .env'
    goto :env_found
) else (
    echo .env file not found with 'if exist .env'
)
if exist ".env" (
    echo .env file found with quotes
    goto :env_found
) else (
    echo .env file not found with quotes
)
echo Debug: Trying alternative detection...
dir .env >nul 2>&1
if errorlevel 1 (
    echo .env file not found with 'dir' method
    goto :create_env
) else (
    echo .env file found with 'dir' method!
    goto :env_found
)

:create_env
    echo.
    echo Creating .env file from template...
    copy env.example .env
    
    echo.
    echo IMPORTANT: Please edit .env file with your API keys and ngrok configuration:
    echo.
    echo Required API Keys:
    echo    - GITHUB_TOKEN: Your GitHub personal access token
    echo    - LINEAR_API_KEY: Your Linear API key
    echo.
    echo Ngrok Configuration:
    echo    - NGROK_AUTH_TOKEN: Your ngrok auth token (get from https://dashboard.ngrok.com)
    echo    - NGROK_DOMAIN: Your custom ngrok domain (optional, leave empty for random)
    echo    - WEBHOOK_SECRET: A secret string for webhook authentication
    echo.
    echo After editing .env, run this script again to start the application.
    echo.
    echo Quick setup tips:
    echo    - GitHub token: https://github.com/settings/tokens
    echo    - Linear API key: https://linear.app/settings/api
    echo    - Ngrok auth token: https://dashboard.ngrok.com/get-started/your-authtoken
    pause
    exit /b 0

:env_found
echo Environment file found, proceeding with setup...

REM Load environment variables from .env file
echo Loading environment variables...
for /f "tokens=1,2 delims==" %%a in (.env) do (
    if not "%%a"=="" if not "%%a:~0,1%"=="#" (
        set "%%a=%%b"
        echo Loaded: %%a
    )
)

REM Set default values if not defined
if not defined WEBHOOK_SECRET (
    echo Generating random webhook secret...
    set WEBHOOK_SECRET=webhook_secret_%random%%random%
)

if not defined NGROK_DOMAIN (
    echo No custom ngrok domain specified, will use random URL
    set NGROK_DOMAIN=
)

REM Generate ngrok.yml configuration
echo Generating ngrok configuration...
echo Debug: NGROK_AUTH_TOKEN=%NGROK_AUTH_TOKEN%
echo Debug: WEBHOOK_SECRET=%WEBHOOK_SECRET%
echo Debug: NGROK_DOMAIN=%NGROK_DOMAIN%

(
echo version: "2"
echo authtoken: "%NGROK_AUTH_TOKEN%"
echo tunnels:
echo   github-webhook:
echo     addr: 3000
echo     proto: http
if defined NGROK_DOMAIN (
echo     domain: "%NGROK_DOMAIN%"
)
echo     inspect: true
) > ngrok.yml

echo Ngrok configuration generated

REM Create logs directory
echo Creating logs directory...
if not exist logs mkdir logs

REM Build and start the application
echo.
echo Building and starting Linear Release Manager with Ngrok...
echo This may take a few minutes on first run...

REM Build the image first
echo Building Docker image...
docker-compose build

REM Start the services
echo Starting services...
docker-compose up -d

REM Wait for services to start
echo Waiting for services to start...
timeout /t 15 /nobreak >nul

REM Check service status
echo Checking service status...
docker-compose ps | findstr "Up" >nul
if errorlevel 1 (
    echo Some services failed to start
    echo Checking logs...
    docker-compose logs --tail=20
    pause
    exit /b 1
) else (
    echo Services are running
)

REM Wait a bit more for ngrok to establish connection
echo.
echo Ngrok Status:
echo ==================
timeout /t 5 /nobreak >nul

echo Ngrok web interface available at http://localhost:4040

REM Show webhook URL
if defined NGROK_DOMAIN (
    set webhook_url=https://%NGROK_DOMAIN%/github-webhook
) else (
    set webhook_url=https://your-ngrok-url.ngrok.io/github-webhook (check ngrok dashboard)
)

echo.
echo Setup complete!
echo ==================
echo.
echo Your webhook URL: %webhook_url%
echo Ngrok dashboard: http://localhost:4040
echo Health check: http://localhost:3000/health
echo.
echo Webhook authentication:
echo    Username: webhook
echo    Password: %WEBHOOK_SECRET%
echo.
echo Useful commands:
echo    Check logs: docker-compose logs -f
echo    Restart: docker-compose restart
echo    Stop: docker-compose down
echo    Update: git pull ^&^& docker-compose up -d --build
echo.
echo Next steps:
echo    1. Add the webhook URL to your GitHub repository settings
echo    2. Set the webhook secret to: %WEBHOOK_SECRET%
echo    3. Test with a release to verify everything works
echo.
echo Happy releasing!
pause
