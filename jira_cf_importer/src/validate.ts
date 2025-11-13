import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import { LinearClient as LinearSDK } from '@linear/sdk';

dotenv.config();

/**
 * Validation script to test connections and configuration
 */
async function validate() {
  console.log('Jira to Linear Importer - Configuration Validator');
  console.log('================================================\n');

  let hasErrors = false;

  // Check environment variables
  console.log('1. Checking environment variables...');
  const requiredEnvVars = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'LINEAR_API_KEY'];
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);

  if (missingVars.length > 0) {
    console.error(`   ✗ Missing environment variables: ${missingVars.join(', ')}`);
    hasErrors = true;
  } else {
    console.log('   ✓ All required environment variables present');
  }

  // Check config.json
  console.log('\n2. Checking config.json...');
  const configPath = path.join(process.cwd(), 'config.json');
  
  if (!fs.existsSync(configPath)) {
    console.error('   ✗ config.json not found. Please create it based on config.example.json');
    hasErrors = true;
  } else {
    try {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configContent);
      
      if (!config.jira || !config.linear) {
        console.error('   ✗ Invalid config structure');
        hasErrors = true;
      } else {
        console.log('   ✓ config.json is valid');
        console.log(`     - Linear Teams: ${config.linear.teamIds?.join(', ') || 'all teams'}`);
        console.log(`     - Date Range: ${config.linear.startDate || 'any'} to ${config.linear.endDate || 'any'}`);
        console.log(`     - Custom fields: ${config.jira.customFields?.length || 0}`);
        console.log(`     - Label scope: ${config.linear.labelScope || 'not set'}`);
      }
    } catch (error) {
      console.error('   ✗ Failed to parse config.json:', error);
      hasErrors = true;
    }
  }

  if (hasErrors) {
    console.log('\n✗ Configuration validation failed. Please fix the errors above.');
    process.exit(1);
  }

  // Test Jira connection
  console.log('\n3. Testing Jira connection...');
  try {
    // Get Jira base URL from env or config
    let jiraBaseUrl = process.env.JIRA_BASE_URL;
    if (!jiraBaseUrl) {
      const configPath = path.join(process.cwd(), 'config.json');
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configContent);
        jiraBaseUrl = config.jira?.baseUrl;
      }
    }
    
    if (!jiraBaseUrl) {
      console.error('   ✗ JIRA_BASE_URL not found in .env or config.json');
      hasErrors = true;
    } else {
      jiraBaseUrl = jiraBaseUrl.replace(/\/$/, '');
      const authHeader = 'Basic ' + Buffer.from(
        `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
      ).toString('base64');

    const response = await fetch(`${jiraBaseUrl}/rest/api/3/myself`, {
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
      },
    });

      if (response.ok) {
        const user: any = await response.json();
        console.log(`   ✓ Connected to Jira as: ${user.displayName} (${user.emailAddress})`);
      } else {
        console.error(`   ✗ Jira connection failed: ${response.status} ${response.statusText}`);
        hasErrors = true;
      }
    }
  } catch (error) {
    console.error('   ✗ Jira connection error:', error);
    hasErrors = true;
  }

  // Test Linear connection
  console.log('\n4. Testing Linear connection...');
  try {
    const linearClient = new LinearSDK({ apiKey: process.env.LINEAR_API_KEY! });
    const viewer = await linearClient.viewer;
    console.log(`   ✓ Connected to Linear as: ${viewer.name} (${viewer.email})`);
    
    // List available teams
    console.log('\n   Available Linear teams:');
    const teamsConnection = await linearClient.teams();
    const teams = await teamsConnection.nodes;
    for (const team of teams) {
      console.log(`     - ${team.name} (Key: ${team.key}, ID: ${team.id})`);
    }
  } catch (error) {
    console.error('   ✗ Linear connection error:', error);
    hasErrors = true;
  }

  // List available Jira custom fields (if connected)
  if (!hasErrors) {
    console.log('\n5. Fetching available Jira custom fields...');
    try {
      // Get Jira base URL from env or config
      let jiraBaseUrl = process.env.JIRA_BASE_URL;
      if (!jiraBaseUrl) {
        const configPath = path.join(process.cwd(), 'config.json');
        if (fs.existsSync(configPath)) {
          const configContent = fs.readFileSync(configPath, 'utf-8');
          const config = JSON.parse(configContent);
          jiraBaseUrl = config.jira?.baseUrl;
        }
      }
      
      if (!jiraBaseUrl) {
        console.log('   Skipping (no Jira URL configured)');
      } else {
        jiraBaseUrl = jiraBaseUrl.replace(/\/$/, '');
        const authHeader = 'Basic ' + Buffer.from(
          `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
        ).toString('base64');

        const response = await fetch(`${jiraBaseUrl}/rest/api/3/field`, {
          headers: {
            'Authorization': authHeader,
            'Accept': 'application/json',
          },
        });

        if (response.ok) {
          const fields = await response.json() as any[];
          const customFields = fields.filter(f => f.id.startsWith('customfield_'));
          
          console.log(`   Found ${customFields.length} custom fields:\n`);
          
          customFields.slice(0, 10).forEach(field => {
            console.log(`   - ${field.name}`);
            console.log(`     ID: ${field.id}`);
            console.log(`     Type: ${field.schema?.type || 'unknown'}`);
            console.log('');
          });

          if (customFields.length > 10) {
            console.log(`   ... and ${customFields.length - 10} more`);
          }
        }
      }
    } catch (error) {
      console.log('   Could not fetch custom fields (non-critical)');
    }
  }

  // Summary
  if (hasErrors) {
    console.log('\n✗ Validation completed with errors. Please fix the issues above.');
    process.exit(1);
  } else {
    console.log('\n✓ All validation checks passed! You can now run: npm run sync');
  }
}

validate();

