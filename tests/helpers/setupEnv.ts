// Environment defaults for integration tests. Real values can be supplied
// through the shell; these keep `npm run test:int` runnable out of the box.
process.env.TEST_DATABASE_URL ??= "postgres://tms:tms@localhost:5432/tms_test";
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.ROUTING_MODE ??= "synthetic";
