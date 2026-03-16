# Discovery API Client

Calls the Discovery GraphQL API with questions and generates reports.

## Quick Start

```bash
cd discovery-api-client
npm install
npm start
```

## How It Works

1. **Loads questions** from `fixtures/questions.json` (100 questions)
2. **Calls API** for each question with:
   - `question`: The question text
   - `restriction`: `"NONE"`
   - `enableConversation`: `true`
3. **Saves results** incrementally to `reports/` as JSON and CSV

## Output

Reports are saved with timestamps:
- `discovery-report-{timestamp}.json` - Full API responses
- `discovery-report-{timestamp}.csv` - Summary with question, results count, stream URL, etc.

## Configuration

Edit `.env` to change:
- `GRAPHQL_ENDPOINT` - API endpoint (default: `https://concord.sandsmedia.com/graphql`)
- `AUTH_TOKEN` - Bearer token for authentication

## Notes

- Reports save after each question (monitor progress)
- 500ms delay between requests
- Failed calls logged but don't stop the process
