import { checkDatabase } from './check.js';

await checkDatabase();
console.log('Database connection and schema are healthy.');
