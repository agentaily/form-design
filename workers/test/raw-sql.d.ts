// Vite's `?raw` import suffix yields the file contents as a string. Declare it
// so the test helpers can import schema.sql as the single source of truth for
// the table DDL without tsc complaining.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
