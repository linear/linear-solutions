# Quick Setup Guide

## Step 1: Install Dependencies

```bash
npm install
```

## Step 2: Configure Environment Variables

Create a `.env` file:

```bash
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-jira-api-token
LINEAR_API_KEY=your-linear-api-key
```

Note: `JIRA_BASE_URL` can be set here or in `config.json` (config.json takes precedence if both are set).

## Step 3: Create Configuration File

Copy the example config:

```bash
cp config.example.json config.json
```

Edit `config.json` with your settings:

```json
{
  "linear": {
    "teamIds": ["your-team-id"],
    "startDate": "2024-01-01",
    "endDate": "2024-12-31",
    "labelScope": "team",
    "createMissingLabels": true
  },
  "jira": {
    "baseUrl": "https://your-domain.atlassian.net",
    "customFields": [
      {
        "fieldId": "customfield_10001",
        "fieldName": "Your Field Name",
        "fieldType": "single-select"
      }
    ]
  }
}
```

## Step 4: Find Your Custom Field IDs

### Method 1: Use the Validation Tool (Easiest!)

Run the validation tool - it will list all your Jira custom fields:

```bash
npm run validate
```

Example output:
```
5. Fetching available Jira custom fields...
   Found 25 custom fields:

   - Environment
     ID: customfield_10001
     Type: option

   - Priority Level
     ID: customfield_10002
     Type: string
```

Copy the IDs you need into your `config.json`.

### Method 2: Jira API

Visit: `https://your-domain.atlassian.net/rest/api/3/field`

Search for your custom field name and copy the `id`.

## Step 5: Get Linear Team IDs (Optional)

### Option 1: Use the Validation Tool

The validation tool will show you information about your Linear account including teams.

### Option 2: Linear Settings

1. Go to your Linear team settings
2. The team ID can be found in the URL or via the Linear API
3. Or omit `teamIds` entirely to search all teams!

## Step 6: Validate Everything

Before running the sync, validate your configuration:

```bash
npm run validate
```

This will check:
- ✅ Environment variables
- ✅ Config file structure
- ✅ Jira connection
- ✅ Linear connection
- ✅ Available custom fields

## Step 7: Run the Sync

```bash
npm run sync
```

Or build and run:

```bash
npm run build
npm start
```

## Common Issues

### Issue: "No Linear issues with Jira links found"
**Solution**: 
- Make sure your Linear issues have Jira ticket URLs as attachments
- Check that your team IDs are correct
- Verify your date range isn't too narrow

### Issue: "Missing required environment variables"
**Solution**: Double-check your `.env` file exists and has all required variables (JIRA_EMAIL, JIRA_API_TOKEN, LINEAR_API_KEY).

### Issue: "Label group not found"
**Solution**: Set `createMissingLabels: true` in `config.json`, or manually create the label group in Linear first.

### Issue: Jira API returns 401
**Solution**: 
- Verify your Jira email matches your Atlassian account
- Generate a new API token at https://id.atlassian.com/manage-profile/security/api-tokens
- Make sure there are no extra spaces in your `.env` file

### Issue: Can't find Linear team ID
**Solution**: 
- Run `npm run validate` to see your teams
- Or simply omit `teamIds` from config to search all teams

## Testing the Setup

Before running on all your data, test with a small dataset:

1. Set a narrow date range in `config.json` (e.g., just 1 week)
2. Use a single team
3. Test with one custom field first
4. Verify the results in Linear
5. Gradually expand your scope

## Configuration Tips

### Start Simple

```json
{
  "linear": {
    "teamIds": ["one-team"],
    "startDate": "2024-11-01",
    "endDate": "2024-11-07",
    "labelScope": "team",
    "createMissingLabels": true
  },
  "jira": {
    "baseUrl": "https://your-domain.atlassian.net",
    "customFields": [
      {
        "fieldId": "customfield_10001",
        "fieldName": "Environment",
        "fieldType": "single-select"
      }
    ]
  }
}
```

### Scale Up Gradually

1. ✅ Test with 1 week of data
2. ✅ Add more custom fields
3. ✅ Expand to 1 month
4. ✅ Add more teams
5. ✅ Remove date filters to sync everything

## Next Steps

Once everything is working:
- Schedule regular syncs using cron or similar
- Add more custom fields to your config
- Expand to multiple teams
- Document which fields map to which labels for your team
