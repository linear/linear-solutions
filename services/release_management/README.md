# Linear Release Management

Application that automatically manages Linear issue labels when GitHub releases are created. This app processes GitHub release webhooks to find Linear issues and apply release labels.

## 🚀 How It Works

### **Core Workflow**
1. **GitHub Release Webhook**: When a new release is created in GitHub, it triggers a webhook to this application
2. **Smart Event Filtering**: Only processes major release states, automatically ignoring edits and deletions
3. **Issue Detection**: The app scans commits, pull requests, and branch names to find Linear issue keys
4. **Linear Integration**: Creates release labels and applies them to found issues

### **Smart Linear Issue Key Detection**
The app uses a sophisticated approach to find Linear issue keys:

- **Exact Team Key Matching**: First tries to match against actual Linear team keys for maximum accuracy
- **Dynamic Regex Fallback**: Falls back to intelligent regex patterns based on team key lengths
- **Case-Insensitive**: Handles variations in key casing (e.g., "ENG-123" vs "eng-123")
- **Branch Name Search**: Searches Linear for issues associated with Git branch names

### **API Optimization**
- **Single GitHub API Call**: Fetches commits once and reuses them across all operations
- **Batch Linear Operations**: Groups Linear API calls to reduce rate limiting
- **Limited Branch Processing**: Processes max 50 commits for branch info to prevent excessive API calls
- **Performance Monitoring**: Tracks and logs total API calls made during processing
- **Smart Rate Limiting**: Adds delays between batches to respect API limits

## 🛠️ Prerequisites

Before setting up this application, you'll need:

- **Node.js** (v16 or higher)
- **GitHub Repository** with releases enabled
- **Linear Account** with API access


**Windows Users**: The `setup-with-ngrok.bat` file will handle most of the setup automatically.

**Mac/Linux Users**: The `setup-with-ngrok.sh` script will handle most of the setup automatically.

## 📋 Setup Instructions

### **Quick Start (All Platforms)**

Clone this repository.

**Windows Users:**
1. **Double-click** `setup-with-ngrok.bat`
2. Follow the prompts to configure your environment
3. The script will handle dependency installation and server startup
4. Use the displayed ngrok URL for your GitHub webhook

**Mac/Linux Users:**
1. **Run** `./setup-with-ngrok.sh` in your terminal
2. Follow the prompts to configure your environment
3. The script will handle dependency installation and server startup
4. Use the displayed ngrok URL for your GitHub webhook

### **Manual Setup**

### **Step 1: Clone and Install Dependencies**

```bash
git clone <your-repo-url>
cd Linear-Release-Management
npm install
```

### **Step 2: Environment Configuration**

Copy the `env.example` file to `.env` in the root directory and update the values:

```bash
# Copy the template file
copy env.example .env
```

Then edit the `.env` file with your actual API keys and configuration.

#### **Getting Your API Keys:**

**GitHub Token:**
1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Generate a new token with `repo` scope
3. Copy the token to `GITHUB_TOKEN`

**Linear API Key:**
1. Go to Linear Settings → API
2. Create a new API key
3. Copy the key to `LINEAR_API_KEY`

### **Step 3: Build the Application**

```bash
npm run build
```

### **Step 4: Start the Server**

```bash
npm start
```

The server will start on port 3000 (or the port specified in your `.env` file).

## 🔗 Webhook Configuration

### **GitHub Webhook Setup**

1. Go to your GitHub repository
2. Navigate to Settings → Webhooks
3. Click "Add webhook"
4. Configure the webhook:
   - **Payload URL**: `https://your-domain.com/github-webhook`
   - **Content type**: `application/json`
   - **Events**: Select "Releases only"
   - **Active**: Checked

**Note**: The app only processes releases when they are created, prereleased, published, released, or unpublished. It automatically ignores release edits and deletions to prevent unnecessary processing.

### **Quick Setup with ngrok (Windows)**

Use the provided `setup-with-ngrok.bat` file for easy setup:

1. **Double-click** `setup-with-ngrok.bat` to run it
2. The script will:
   - Install dependencies if needed
   - Start the server
   - Launch ngrok to expose your local server
   - Display the webhook URL to use

**Manual ngrok Setup (Alternative):**

If you prefer to set up ngrok manually:

```bash
# Install ngrok globally
npm install -g ngrok

# Start your server
npm start

# In another terminal, expose your local server
ngrok http 3000
```

Use the ngrok URL (e.g., `https://abc123.ngrok.io`) as your webhook payload URL.

## 🧪 Testing

### **Health Check**
Test if your server is running:

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "version": "1.0.0",
  "services": {
    "linear": "configured",
    "github": "configured"
  }
}
```

### **Test Release**
1. Create a new release in your GitHub repository
2. Check the server logs for processing information
3. Verify the Linear label was created and applied

## 📊 What Happens During Processing

When a release webhook is received:

1. **Immediate Response**: Server responds to GitHub within seconds
2. **Background Processing**: Release processing continues asynchronously
3. **Commit Analysis**: Scans all commits between releases for Linear keys
4. **PR Analysis**: Extracts PR information and scans for Linear keys
5. **Branch Search**: Queries Linear for issues associated with branch names
6. **Label Application**: Creates Linear label and applies to all found issues

## 🔧 Configuration Options

### **Environment Variables**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | Yes | - | GitHub personal access token |
| `LINEAR_API_KEY` | Yes | - | Linear App Token |
| `NGROK_AUTH_TOKEN` | Yes | - | Ngrok Authtoken |
| `WEBHOOK_SECRET` | Yes | - | You define this, authentication for the webhook |
| `NGROK_DOMAIN` | No | - | Optional if you already have an Ngrok URL, otherwise this app will create one |
| `PORT` | No | 3000 | Defaults to 3000, change if you prefer something else |

### **Performance Tuning**

The app includes several performance optimizations:

- **Batch Size**: Linear API calls are batched in groups of 10
- **Rate Limiting**: 100ms delays between batches to respect API limits
- **Commit Limits**: Maximum 50 commits processed for branch information
- **Parallel Processing**: Commits and PRs are scanned simultaneously
- **API Call Tracking**: Monitors and logs total API calls for performance analysis
- **Smart Event Filtering**: Ignoring release events that are edits/deletions

## 🚨 Troubleshooting

### **Common Issues**

**Linear API Errors:**
- Verify your `LINEAR_API_KEY` is correct
- Check if the key has necessary permissions
- Ensure your Linear organization allows API access

**GitHub Webhook Issues:**
- Verify the webhook URL is accessible
- Check webhook delivery logs in GitHub
- Ensure the repository has releases enabled

**No Issues Found:**
- Check if commits contain Linear issue keys
- Verify team keys are being retrieved from Linear
- Review server logs for detailed processing information
- App ignores edits/deletions release events

### **Log Analysis**

The app provides detailed logging for debugging:

- **Team Key Detection**: Shows how many Linear team keys were found
- **Issue Key Extraction**: Logs the number of keys found in each source
- **API Call Optimization**: Indicates when duplicate calls are eliminated
- **Performance Summary**: Shows final counts and optimization status
- **API Call Tracking**: Detailed breakdown of calls to GitHub and Linear
- **Event Filtering**: Shows which release events are processed vs. ignored

## 📈 Monitoring and Maintenance

### **Health Monitoring**
- Use the `/health` endpoint for uptime monitoring
- Check server logs for error patterns
- Monitor API rate limit usage

### **Performance Metrics**
The app logs performance metrics for each release:
- Total commits processed
- Linear issues found and labeled
- API call optimization status
- Total API calls made (with breakdown by service)

### **Regular Maintenance**
- Monitor Linear API key expiration
- Review GitHub webhook delivery status
- Update dependencies regularly

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

If you encounter issues:

1. Check the troubleshooting section above
2. Review server logs for error details
3. Verify all API keys and permissions
4. Check GitHub webhook delivery logs
5. Open an issue with detailed error information

---

**Note**: This application is designed for production use but includes safeguards against API rate limiting and error handling to ensure robust operation.
