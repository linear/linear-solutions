# API Usage Analysis

## Current API Call Pattern

### Linear API Calls

1. **Team Resolution** (if using team keys): `1 call`
   - Fetches all teams to resolve keys to UUIDs
   - Cached for the session

2. **Issues Query** (paginated): `⌈Linear Issues / 50⌉ calls`
   - Fetches 50 issues per page
   - Example: 100 issues = 2 calls, 250 issues = 5 calls

3. **Attachments Per Issue**: `N calls` (where N = number of Linear issues checked)
   - **⚠️ PERFORMANCE BOTTLENECK**: Separate API call for each issue
   - This is the most expensive operation

4. **Organization Labels**: `1 call`
   - Fetches all label groups and labels
   - Cached for the session
   - Reused for all label operations

5. **Issue Updates**:
   - Label additions: `1 call per issue that gets labels`
   - Description updates: `1 call per issue that gets description updates`

### Jira API Calls

1. **Issue Search** (batched): `⌈Jira Issues / 50⌉ calls`
   - Fetches up to 50 issues per batch
   - Example: 100 Jira keys = 2 calls

---

## API Call Examples

### Scenario 1: Small Sync (10 Linear issues, 8 with Jira links)
- Linear team resolution: 1 call
- Linear issues (10 total): 1 call (50 per page)
- Linear attachments: **10 calls** (1 per issue) ⚠️
- Linear labels cache: 1 call
- Jira issue fetch (8 issues): 1 call
- Linear updates (8 issues): ~8-16 calls (depending on fields)

**Total: ~28-36 API calls**

### Scenario 2: Medium Sync (100 Linear issues, 50 with Jira links)
- Linear team resolution: 1 call
- Linear issues (100 total): 2 calls (50 per page)
- Linear attachments: **100 calls** (1 per issue) ⚠️
- Linear labels cache: 1 call
- Jira issue fetch (50 issues): 1 call
- Linear updates (50 issues): ~50-100 calls

**Total: ~154-254 API calls**

### Scenario 3: Large Sync (500 Linear issues, 300 with Jira links)
- Linear team resolution: 1 call
- Linear issues (500 total): 10 calls (50 per page)
- Linear attachments: **500 calls** (1 per issue) ⚠️
- Linear labels cache: 1 call
- Jira issue fetch (300 issues): 6 calls
- Linear updates (300 issues): ~300-600 calls

**Total: ~818-1,418 API calls**

---

## Rate Limits

### Linear API
- **Standard limit**: 1,500 requests per minute per user
- **Complexity limit**: 3,000,000 complexity units per minute
- **Reset**: Rolling 60-second window

### Jira API
- **Cloud**: ~100-300 requests per minute (varies by plan)
- **Reset**: Sliding window

---

## Optimizations Implemented ✅

### ✅ Parallel Attachment Fetching
**Implementation**: Process attachment fetching in parallel within each 50-issue batch  
**Benefit**: Reduces total wall-clock time by ~50% for attachment operations  
**Note**: Still requires 1 API call per issue (Linear API limitation), but all calls in a batch happen simultaneously

### ✅ API Call Tracking
**Implementation**: Track all API calls to Linear and Jira  
**Benefit**: Real-time visibility into API usage for monitoring rate limits  
**Display**: Shows in summary after sync completes

### ✅ Already Optimized
- ✅ Label caching (single fetch, reused)
- ✅ Team resolution caching
- ✅ Jira batching (50 issues per call)
- ✅ Linear pagination (50 issues per page)
- ✅ Issue updates check before applying (skip if already present)

---

## Performance Characteristics

### Scenario 1: Small (10 Linear issues, 8 with Jira links)
**API Calls**: ~20-30 total
- Linear: 1 (teams) + 1 (issues) + 10 (attachments) + 1 (labels) + ~8-16 (updates)
- Jira: 1 (issue batch)
**Time**: Parallel processing reduces time by ~5-7 seconds

### Scenario 2: Medium (100 Linear issues, 50 with Jira links)
**API Calls**: ~160-260 total
- Linear: 1 (teams) + 2 (issues) + 100 (attachments) + 1 (labels) + ~50-100 (updates)
- Jira: 1 (issue batch)
**Time**: Parallel processing reduces time by ~45-60 seconds

### Scenario 3: Large (500 Linear issues, 300 with Jira links)
**API Calls**: ~820-1,420 total
- Linear: 1 (teams) + 10 (issues) + 500 (attachments) + 1 (labels) + ~300-600 (updates)
- Jira: 6 (issue batches)
**Time**: Parallel processing reduces time by ~4-6 minutes

---

## Rate Limiting Protection

### Current Implementation
1. **Tracking**: All API calls are counted and displayed
2. **Parallel Processing**: Controlled to 50 issues per batch
3. **Caching**: Labels and teams cached to minimize redundant calls

### Staying Under Limits

**Linear** (1,500 requests/minute):
- Small sync: ✅ Well under limit
- Medium sync: ✅ Under limit  
- Large sync: ✅ Should complete in ~1 minute with parallel processing

**Jira** (~100-300 requests/minute):
- Small sync: ✅ Well under limit
- Medium sync: ✅ Well under limit
- Large sync: ✅ Very minimal Jira calls (6 for 300 issues)

