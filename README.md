# Cypress Test Suite for RAG-CON

This repository contains Cypress end-to-end tests for the RAG-CON application.

## Structure

```
cypress/
├── fixtures/
│   └── questions.json          # All 100 questions (only file to update when questions change)
├── support/
│   ├── e2e.js                  # Cypress support file
│   ├── commands.js             # Custom commands
│   └── login.js                # Reusable login logic
└── e2e/
    └── questions.cy.js         # Main test file that loops through questions
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
   Edit `cypress.config.js` and update the `baseUrl` with your staging URL.

4. **Update selectors in test files:**
   - Review `cypress/support/login.js` and update selectors for auth and user login forms
   - Review `cypress/e2e/questions.cy.js` and update selectors for chat input and response elements

## Running Tests

### Open Cypress Test Runner (Interactive)
```bash
npm run cypress:open
```

### Run Tests Headless
```bash
npm run cypress:run
```

### Run Specific Test File
```bash
npx cypress run --spec "cypress/e2e/questions.cy.js"
```

## Updating Questions

To update questions, simply edit `cypress/fixtures/questions.json`. This is the **only file** you need to modify when questions change. The test suite will automatically pick up the changes.

## Login Flow

The test suite uses a two-step login process:

1. **Auth Login** (`cy.authLogin()`): Handles the staging auth wall with basic credentials
2. **User Login** (`cy.userLogin()`): Handles the actual app login with user credentials

Both login functions are reusable across different test files via custom Cypress commands.

## Test Behavior

- Each question is tested as a separate test case for easy failure identification
- Tests wait for responses with a 30-second timeout
- Tests assert that responses are not empty
- A 1-second wait between questions helps avoid rate limiting

## Notes

- `cypress.env.json` is gitignored - never commit credentials
- All selectors use flexible matching to work with various form structures
- Adjust selectors and timeouts based on your actual application structure
