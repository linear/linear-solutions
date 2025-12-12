# Linear Customer Attribute Sync

This repository provides a single-purpose script that aligns customer attributes in Linear with data from a CSV file. The script reads customer rows, matches each by exact name to existing Linear customers, and updates selected attributes through the `customerUpdate` mutation.

[Video Walkthrough](https://us02web.zoom.us/clips/share/rdV4oip-RSi7-YPecemUKg)

**⚠️ Warning:** Any attribute present in the CSV will overwrite the attribute in Linear for matching customers. Double-check values before running the script.

Tiers and Statuses must exist in Linear to be matched.

## Prerequisites

- Node.js 18 or later (for the built-in `fetch` API)
- A Linear API key with permissions to read and update customers

## CSV Format

Create a UTF-8 encoded CSV file with a header row that matches the column names below:

| Column           | Required | Description                                                                 |
| ---------------- | -------- | --------------------------------------------------------------------------- |
| `name`           | Yes      | Customer name in Linear. Must match exactly (case-sensitive) to update.     |
| `domains`        | No       | Domains associated with the customer (comma/semicolon/pipe separated).      |
| `owner`          | No       | Owner email or full name. Uses Linear users to resolve the ID.              |
| `owner_id`       | No       | Direct Linear user ID to set as owner (overrides `owner`).                  |
| `status`         | No       | Customer status name (matched case-insensitively).                          |
| `status_id`      | No       | Direct Linear status ID (overrides `status`).                               |
| `tier`           | No       | Customer tier name (matched case-insensitively).                            |
| `tier_id`        | No       | Direct Linear tier ID (overrides `tier`).                                   |
| `annual_revenue` | No       | Revenue figure; non-numeric characters are stripped before parsing.         |
| `revenue`        | No       | Alternate column for revenue (same handling as `annual_revenue`).           |
| `size`           | No       | Customer size/headcount; parsed as an integer.                              |

Additional columns are ignored. Rows missing a `name` value are skipped.

### Example CSV

```csv
name,domains,owner,status,tier,annual_revenue,size
Acme Corp,"acme.com, acme.org",Jamie Lee,Active,Enterprise,1250000,1200
Beta Labs,beta.io,Maria Zhang,Pilot,Mid-Market,350000,250
```

## Running the Script

No package installation is required. Ensure you are running Node.js 18+:

```bash
node -v
```

Execute the JavaScript script:

```bash
node linear_customer_sync.js --csv /absolute/path/to/customers.csv --api-key <your-linear-api-key>
```

```bash
# Example
node linear_customer_sync.js --csv ~/Downloads/customers.csv
```

If you omit `--api-key`, the script securely prompts for it. For security, avoid storing the key directly in scripts or files.


### Behavior

- Fetches all customers in the Linear workspace once and caches them by name.
- Fetches users, customer statuses, and customer tiers once (statuses and tiers exclude archived entries via `includeArchived: false`) to resolve names reliably.
- Matches CSV rows to Linear customers by exact (case-sensitive) name.
- Only performs updates for customers with both a successful match and at least one attribute value provided.
- Handles Linear API rate limiting with retries and exponential backoff.
- Uses a 20-second timeout per request; failures surface with a clear error message.
- Ignores archived tiers and statuses when resolving names; if a name still fails, the script warns and lists nearby matches. Supply `*_id` columns if you prefer to target explicit IDs.

### Output

The script reports how many customers were updated and how many rows were skipped because of missing matches or attributes.

## Troubleshooting

- **HTTP or API errors**: The script prints details to stderr. Re-run after resolving credentials or network issues.
- **Unmatched customers**: Ensure CSV names exactly match Linear customer names.
- **Rate limiting**: The script retries automatically. If you see repeated failures, consider reducing the CSV size or spacing out runs.

## Support

Share this script and README with users who need to sync Linear customer records. For enhancements or bug reports, open an issue in this repository.


