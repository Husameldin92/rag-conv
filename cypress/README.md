# Cypress Test Suite for RAG-CON

This repository contains Cypress end-to-end tests for the RAG-CON application. The tests automate question submission to the Entwickler Intelligence chat and extract Topic and Synthesis Question from each response.

## Structure

```
cypress/
├── fixtures/
│   └── questions.json          # All 100 questions (only file to update when questions change)
├── support/
│   ├── e2e.js                  # Cypress support file
│   ├── commands.js             # Custom commands
│   └── login.js                # Reusable login logic
├── e2e/
│   ├── block-c.cy.js           # Main test file - runs all questions from questions.json
│   └── quick-test.cy.js        # Quick test with 3 questions for verification
└── reports/
    ├── questions-report-{timestamp}.csv    # CSV report with User, Question, Topic, Synthesis Question, Response Time
    ├── questions-report-{timestamp}.json   # JSON report with same data
    ├── quick-test-report-{timestamp}.csv  # Quick test CSV report
    └── quick-test-report-{timestamp}.json  # Quick test JSON report
```

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp cypress.env.json.example cypress.env.json
   ```
   
   Then edit `cypress.env.json` with your actual credentials:
   ```json
   {
     "AUTH_USERNAME": "your-staging-auth-username",
     "AUTH_PASSWORD": "your-staging-auth-password",
     "AUTH_URL": "https://your-staging-auth-url.com",
     "USER_USERNAME": "your-app-username",
     "USER_PASSWORD": "your-app-password"
   }
   ```

3. **Update Cypress configuration:**
   Edit `cypress.config.js` and update the `baseUrl` with staging URL.

4. **Update selectors in test files (if needed):**
   - Review `cypress/support/login.js` and update selectors for auth and user login forms if they change
   - The chat input selector is: `textarea[placeholder="Frag die Entwickler Intelligence"]`
   - The send button selector is: `button.send-button`

## Running Tests

### Open Cypress Test Runner (Interactive)
```bash
npm run cypress:open
```

### Run All Tests (Headless)
```bash
npm run cypress:run
```

### Run Block-C Test Suite (100 questions)
```bash
npm run test:block-c
```

### Run Quick Test (3 questions for verification)
```bash
npm run test:quick
```

### Run Tests with Visible Browser
```bash
npm run cypress:run:headed
```

**Note:** All tests run in headless mode by default with video recording enabled. Videos are saved to `cypress/videos/`.

## Updating Questions

To update questions, simply edit `cypress/fixtures/questions.json`. This is the **only file** you need to modify when questions change. The test suite will automatically pick up the changes.

## Login Flow

The test suite uses a two-step login process:

1. **Auth Login** (`cy.authLogin()`): Handles the staging auth wall with basic credentials
2. **User Login** (`cy.userLogin()`): Handles the actual app login with user credentials

Both login functions are reusable across different test files via custom Cypress commands.

## Test Behavior

- **Login:** Performed once before all tests (not between questions)
- **Questions:** All questions run in the same chat session (testIsolation: false)
- **Each question:**
  - Types the question into the chat input
  - Submits and waits for response
  - Measures response time (from submit click to response ready)
  - Extracts Topic and Synthesis Question from the answer (finds last occurrence)
  - Saves data to CSV/JSON reports incrementally (after each question)
- **Reports:** Generated incrementally - CSV and JSON files are updated after each question completes
- **Response Time:** Measured in milliseconds and included in all reports
- **Video Recording:** Enabled by default for debugging failed tests

## Report Generation

The test suite generates timestamped report files for each test run:

1. **`cypress/reports/questions-report-{timestamp}.csv`** - CSV format with columns:
   - User
   - Question
   - Topic
   - Synthesis Question
   - Response Time (ms)

2. **`cypress/reports/questions-report-{timestamp}.json`** - JSON format with same data

3. **`cypress/reports/quick-test-report-{timestamp}.csv`** - Quick test CSV report
4. **`cypress/reports/quick-test-report-{timestamp}.json`** - Quick test JSON report

**Features:**
- **Timestamped filenames:** Each test run creates unique files (format: `YYYY-MM-DDTHH-MM-SS`)
- **Incremental saving:** Reports are updated after each question completes, so you can monitor progress and still have data if the test fails partway through
- **Response time tracking:** Response time is measured from question submission to response ready, logged in milliseconds

## Data Extraction

The tests extract Topic and Synthesis Question from the API response or page content:
- **Topic:** Extracted from "Question topics:" in the answer
- **Synthesis Question:** Extracted from "Synthesised question:" in the answer
- Uses the **last occurrence** (most recent answer) when multiple answers are present

## Notes

- `cypress.env.json` is gitignored - never commit credentials
- `cypress/reports/` and `cypress/videos/` are gitignored
- All questions run in the same browser session (no page reloads between questions)
- Video recording is enabled by default - check `cypress/videos/` for test recordings
- If extraction fails, values will be "Not found" in the reports
- Response time is measured with good network conditions (no artificial throttling)
- Each test run creates unique timestamped report files to prevent overwriting previous results
