# Discovery API Client

Calls the Discovery GraphQL API with questions and generates reports. Supports both `discovery` and `discoveryTest` queries for comparison.

## Quick Start

```bash
cd discovery-api-client
npm install
```

## Running Queries

### Run discoveryTest query (default)
```bash
npm run discoveryTest
# or
npm start
```

### Run discovery query
```bash
npm run discovery
```

### Compare Results
After running both queries, compare the latest reports:
```bash
npm run compare
```

### Run discovery query
```bash
npm run quick-test
```

## How It Works

1. **Loads questions** from `fixtures/questions.json`
2. **Calls API** for each question with:
   - `question`: The question text (embedded in query)
   - `restriction`: `NONE`
   - `enableConversation`: `true`
3. **Saves results** incrementally to `reports/` as JSON and CSV

## Output

Reports are saved with timestamps:
- `discovery-report-{timestamp}.json` - Full API responses
- `discovery-report-{timestamp}.csv` - Summary
- `discoveryTest-report-{timestamp}.json` - Full API responses
- `discoveryTest-report-{timestamp}.csv` - Summary
- `comparison-report-{timestamp}.csv` - Detailed comparison (after running compare)

## Comparison Report

The comparison script analyzes:
- **Results matching**: Do both queries return the same result IDs?
- **Chunks ordering**: Are chunks in the same order between queries?
- **Null results**: Which questions return null in one but not the other?
- **parentGenre analysis**: Why is parentGenre null? (should show "Read" and "Rheingold")

## Configuration

Edit `.env` to change:
- `GRAPHQL_ENDPOINT` - API endpoint (default: `https://concord.sandsmedia.com/graphql`)
- `AUTH_TOKEN` - Access token for authentication

## Notes

- Reports save after each question (monitor progress)
- 500ms delay between requests
- Failed calls logged but don't stop the process
- Comparison script finds the latest reports automatically
