import pkg from 'pg';
import chalk from 'chalk';

const { Pool } = pkg;

// Solves Issue #3: Single shared pool to prevent Connection Exhaustion on Railway
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20, // Reduced from 200
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
    console.error(chalk.red('[DB] Unexpected error on idle client'), err);
});

export default pool;
