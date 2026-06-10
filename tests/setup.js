import "@testing-library/jest-dom/vitest";

// NOTE: no global afterEach(cleanup) here. @amiceli/vitest-cucumber runs each
// Gherkin step as its own test, so a per-test cleanup would unmount the React
// tree between Given/When/Then. BDD specs clean up per scenario via
// AfterEachScenario instead; unit tests here don't mount components.
